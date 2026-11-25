import { BadRequestException, ConflictException } from '@nestjs/common';

import { LinksController } from './links.controller';
import { LinksService } from './links.service';
import { LinkMetadataIdempotencyService } from './link-metadata-idempotency.service';
import type {
  LinkMetadataRequestDto,
  LinkMetadataResponseDto,
} from '../dto';

const KEY = 'link_metadata_attempt_0001';

function response(expiresAt: string): LinkMetadataResponseDto {
  return {
    amount: '25.0000000',
    memo: null,
    memoType: 'text',
    asset: 'XLM',
    privacy: false,
    expiresAt,
    canonical: `quickex.to/pay?amount=25.0000000&asset=XLM&expires=${expiresAt}`,
    username: null,
    destination: null,
    referenceId: null,
    acceptedAssets: null,
    swapOptions: null,
    metadata: { normalized: false },
  } as LinkMetadataResponseDto;
}

describe('LinksController idempotency', () => {
  let controller: LinksController;
  let generateMetadata: jest.Mock;

  beforeEach(() => {
    generateMetadata = jest.fn();
    controller = new LinksController(
      { generateMetadata } as unknown as LinksService,
      new LinkMetadataIdempotencyService(),
    );
  });

  it('returns the original response when a successful request is retried with the same key', async () => {
    const original = response('2026-11-21T12:00:00.000Z');
    generateMetadata.mockResolvedValueOnce(original);
    const payload = { amount: 25, asset: 'XLM' } as LinkMetadataRequestDto;

    const first = await controller.generateMetadata(payload, KEY);
    generateMetadata.mockResolvedValueOnce(response('2026-11-22T12:00:00.000Z'));
    const retry = await controller.generateMetadata(payload, KEY);

    expect(first).toEqual({ success: true, data: original });
    expect(retry).toEqual(first);
    expect(generateMetadata).toHaveBeenCalledTimes(1);
  });

  it('rejects the same key with a different payload', async () => {
    generateMetadata.mockResolvedValue(response('2026-11-21T12:00:00.000Z'));
    await controller.generateMetadata(
      { amount: 25, asset: 'XLM' } as LinkMetadataRequestDto,
      KEY,
    );

    await expect(
      controller.generateMetadata(
        { amount: 50, asset: 'XLM' } as LinkMetadataRequestDto,
        KEY,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(generateMetadata).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed submission, so a retry can succeed', async () => {
    const payload = { amount: 25, asset: 'XLM' } as LinkMetadataRequestDto;
    generateMetadata
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(response('2026-11-21T12:00:00.000Z'));

    await expect(controller.generateMetadata(payload, KEY)).rejects.toThrow(
      'temporary failure',
    );
    await expect(controller.generateMetadata(payload, KEY)).resolves.toEqual({
      success: true,
      data: response('2026-11-21T12:00:00.000Z'),
    });
    expect(generateMetadata).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed idempotency key without calling the service', async () => {
    await expect(
      controller.generateMetadata(
        { amount: 25 } as LinkMetadataRequestDto,
        'short',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(generateMetadata).not.toHaveBeenCalled();
  });

  it('coalesces concurrent submissions with the same key while the first is pending', async () => {
    const original = response('2026-11-21T12:00:00.000Z');
    let release!: (value: LinkMetadataResponseDto) => void;
    generateMetadata.mockImplementation(
      () =>
        new Promise<LinkMetadataResponseDto>((resolve) => {
          release = resolve;
        }),
    );
    const payload = { amount: 25, asset: 'XLM' } as LinkMetadataRequestDto;

    const first = controller.generateMetadata(payload, KEY);
    const second = controller.generateMetadata(payload, KEY);

    expect(generateMetadata).toHaveBeenCalledTimes(1);
    release(original);
    expect(await second).toEqual({ success: true, data: original });
    expect(await first).toEqual({ success: true, data: original });
  });

  it('preserves the existing contract when no idempotency key is supplied', async () => {
    const original = response('2026-11-21T12:00:00.000Z');
    generateMetadata.mockResolvedValue(original);
    const payload = { amount: 25 } as LinkMetadataRequestDto;

    expect(await controller.generateMetadata(payload)).toEqual({
      success: true,
      data: original,
    });
    expect(await controller.generateMetadata(payload)).toEqual({
      success: true,
      data: original,
    });
    expect(generateMetadata).toHaveBeenCalledTimes(2);
  });
});
