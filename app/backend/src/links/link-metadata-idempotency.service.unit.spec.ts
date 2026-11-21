import {
  fingerprintLinkMetadataRequest,
  LINK_METADATA_IDEMPOTENCY_MAX_ENTRIES,
  LINK_METADATA_IDEMPOTENCY_TTL_MS,
  LinkMetadataIdempotencyService,
} from './link-metadata-idempotency.service';
import type {
  LinkMetadataRequestDto,
  LinkMetadataResponseDto,
} from '../dto';

function makeResponse(
  overrides: Partial<LinkMetadataResponseDto> = {},
): LinkMetadataResponseDto {
  return {
    amount: '10.0000000',
    memo: null,
    memoType: 'text',
    asset: 'XLM',
    privacy: false,
    expiresAt: '2026-11-21T12:00:00.000Z',
    canonical: 'quickex.to/pay?amount=10.0000000&asset=XLM',
    username: null,
    destination: null,
    referenceId: null,
    acceptedAssets: null,
    swapOptions: null,
    metadata: { normalized: false },
    ...overrides,
  } as LinkMetadataResponseDto;
}

function request(
  overrides: Partial<LinkMetadataRequestDto> = {},
): LinkMetadataRequestDto {
  return { amount: 10, asset: 'XLM', ...overrides } as LinkMetadataRequestDto;
}

const KEY_A = 'linkmetadata_key_0000000001';

describe('LinkMetadataIdempotencyService', () => {
  let service: LinkMetadataIdempotencyService;

  beforeEach(() => {
    service = new LinkMetadataIdempotencyService();
  });

  describe('fingerprintLinkMetadataRequest', () => {
    it('ignores property order and undefined fields', () => {
      expect(fingerprintLinkMetadataRequest(request({ memo: undefined }))).toBe(
        fingerprintLinkMetadataRequest(request()),
      );
    });

    it('changes when a payload value changes', () => {
      expect(fingerprintLinkMetadataRequest(request())).not.toBe(
        fingerprintLinkMetadataRequest(request({ amount: 11 })),
      );
    });
  });

  describe('key validation', () => {
    it('accepts url-safe keys between 16 and 128 characters', () => {
      expect(service.isValidKey('a'.repeat(16))).toBe(true);
      expect(service.isValidKey('A_b-9'.repeat(25).slice(0, 128))).toBe(true);
    });

    it('rejects short or unsafe keys', () => {
      expect(service.isValidKey('too-short')).toBe(false);
      expect(service.isValidKey('a'.repeat(129))).toBe(false);
      expect(service.isValidKey('has space in key 1234')).toBe(false);
      expect(service.isValidKey(undefined)).toBe(false);
    });
  });

  it('replays the original response for the same key and payload', () => {
    const fingerprint = fingerprintLinkMetadataRequest(request());
    const original = makeResponse();

    expect(service.lookup(KEY_A, fingerprint)).toEqual({ status: 'miss' });
    service.remember(KEY_A, fingerprint, original);

    expect(service.lookup(KEY_A, fingerprint)).toEqual({
      status: 'hit',
      response: original,
    });
  });

  it('reports a conflict when a key is reused with a different payload', () => {
    const fingerprint = fingerprintLinkMetadataRequest(request());
    service.remember(KEY_A, fingerprint, makeResponse());

    const changed = fingerprintLinkMetadataRequest(request({ amount: 25 }));
    expect(service.lookup(KEY_A, changed)).toEqual({ status: 'conflict' });
  });

  it('treats an expired replay window as a miss', () => {
    jest.useFakeTimers();
    try {
      const fingerprint = fingerprintLinkMetadataRequest(request());
      service.remember(KEY_A, fingerprint, makeResponse());

      jest.advanceTimersByTime(LINK_METADATA_IDEMPOTENCY_TTL_MS + 1);

      expect(service.lookup(KEY_A, fingerprint)).toEqual({ status: 'miss' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds the cache to the most recent entries', () => {
    const fingerprint = fingerprintLinkMetadataRequest(request());
    for (let index = 0; index <= LINK_METADATA_IDEMPOTENCY_MAX_ENTRIES; index += 1) {
      service.remember(`replay_key_${String(index).padStart(20, '0')}`, fingerprint, makeResponse());
    }

    expect(service.lookup('replay_key_00000000000000000000', fingerprint)).toEqual({
      status: 'miss',
    });
    expect(
      service.lookup(
        `replay_key_${String(LINK_METADATA_IDEMPOTENCY_MAX_ENTRIES).padStart(20, '0')}`,
        fingerprint,
      ).status,
    ).toBe('hit');
  });

  it('coalesces concurrent runs with the same key and payload', async () => {
    const fingerprint = fingerprintLinkMetadataRequest(request());
    const original = makeResponse();
    let release!: (response: LinkMetadataResponseDto) => void;
    const generate = jest.fn(
      () =>
        new Promise<LinkMetadataResponseDto>((resolve) => {
          release = resolve;
        }),
    );

    const first = service.run(KEY_A, fingerprint, generate);
    const second = service.run(KEY_A, fingerprint, generate);

    expect(generate).toHaveBeenCalledTimes(1);
    release(original);
    expect(await first).toEqual({ status: 'ok', response: original });
    expect(await second).toEqual({ status: 'ok', response: original });
  });

  it('reports a conflict when an in-flight key is reused with a different payload', async () => {
    let release!: (response: LinkMetadataResponseDto) => void;
    const generate = jest.fn(
      () =>
        new Promise<LinkMetadataResponseDto>((resolve) => {
          release = resolve;
        }),
    );
    const inFlight = service.run(
      KEY_A,
      fingerprintLinkMetadataRequest(request()),
      generate,
    );

    expect(
      await service.run(
        KEY_A,
        fingerprintLinkMetadataRequest(request({ amount: 99 })),
        generate,
      ),
    ).toEqual({ status: 'conflict' });
    expect(generate).toHaveBeenCalledTimes(1);

    release(makeResponse());
    await inFlight;
  });

  it('releases the in-flight slot after a failure so a retry can regenerate', async () => {
    const fingerprint = fingerprintLinkMetadataRequest(request());
    const generate = jest
      .fn<Promise<LinkMetadataResponseDto>, []>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(makeResponse());

    await expect(service.run(KEY_A, fingerprint, generate)).rejects.toThrow(
      'temporary failure',
    );
    expect((await service.run(KEY_A, fingerprint, generate)).status).toBe('ok');
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
