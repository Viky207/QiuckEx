import {
  createSubmissionGuard,
  createSubmissionKey,
  type SubmissionAttempt,
} from './submissionGuard';

const KEY = 'link_payload_0000000001';

function start<T>(attempt: SubmissionAttempt<T>) {
  if (attempt.status !== 'start') {
    throw new Error(`Expected a started submission, got ${attempt.status}`);
  }
  return attempt;
}

describe('createSubmissionGuard', () => {
  it('ignores a synchronous second click while a request is in flight', () => {
    let now = 0;
    const guard = createSubmissionGuard<string>({ now: () => now });
    const first = start(guard.begin(KEY));

    expect(guard.pending).toBe(true);
    expect(guard.begin(KEY)).toEqual({ status: 'duplicate' });
    expect(guard.begin('link_other_payload_0001')).toEqual({
      status: 'duplicate',
    });

    first.settle({ ok: true, value: 'canonical-link' });
    expect(guard.pending).toBe(false);
    expect(guard.begin(KEY)).toEqual({
      status: 'replay',
      value: 'canonical-link',
    });
  });

  it('allows a retry with the same key after a failure without replaying a stale result', () => {
    const guard = createSubmissionGuard<string>();
    const failed = start(guard.begin(KEY));

    failed.settle({ ok: false });
    expect(guard.pending).toBe(false);

    const retry = start(guard.begin(KEY));
    expect(retry.key).toBe(KEY);
    retry.settle({ ok: true, value: 'recovered-link' });

    expect(guard.begin(KEY)).toEqual({
      status: 'replay',
      value: 'recovered-link',
    });
  });

  it('replays a successful result after the replay window but before expiry', () => {
    let now = 1_000;
    const guard = createSubmissionGuard<string>({
      now: () => now,
      ttlMs: 5_000,
    });
    const attempt = start(guard.begin(KEY));
    attempt.settle({ ok: true, value: 'original' });

    now += 4_999;
    expect(guard.begin(KEY)).toEqual({ status: 'replay', value: 'original' });
  });

  it('starts a new submission once the replay window has expired', () => {
    let now = 1_000;
    const guard = createSubmissionGuard<string>({
      now: () => now,
      ttlMs: 5_000,
    });
    const attempt = start(guard.begin(KEY));
    attempt.settle({ ok: true, value: 'original' });

    now += 5_000;
    expect(start(guard.begin(KEY)).key).toBe(KEY);
  });

  it('bounds the replay cache to the most recent results', () => {
    const guard = createSubmissionGuard<string>({ maxCached: 2 });

    start(guard.begin('link_one_payload_000001')).settle({
      ok: true,
      value: 'one',
    });
    start(guard.begin('link_two_payload_000002')).settle({
      ok: true,
      value: 'two',
    });
    start(guard.begin('link_three_payload_0003')).settle({
      ok: true,
      value: 'three',
    });

    const evicted = guard.begin('link_one_payload_000001');
    expect(evicted.status).toBe('start');
    if (evicted.status === 'start') {
      evicted.settle({ ok: false });
    }
    expect(guard.begin('link_three_payload_0003')).toEqual({
      status: 'replay',
      value: 'three',
    });
  });

  it('ignores a duplicate settle from a stale attempt', () => {
    const guard = createSubmissionGuard<string>();
    const first = start(guard.begin(KEY));
    first.settle({ ok: true, value: 'first' });

    const second = start(guard.begin('link_other_payload_0001'));
    first.settle({ ok: true, value: 'stale' });

    expect(guard.pending).toBe(true);
    second.settle({ ok: false });
    expect(guard.pending).toBe(false);
  });

  it('requires a non-empty key and can be reset', () => {
    const guard = createSubmissionGuard<string>();
    expect(() => guard.begin('')).toThrow('A submission key is required.');

    start(guard.begin(KEY)).settle({ ok: true, value: 'cached' });
    guard.reset();

    expect(guard.pending).toBe(false);
    expect(guard.begin(KEY).status).toBe('start');
  });
});

describe('createSubmissionKey', () => {
  it('is stable across object key order and ignores undefined fields', () => {
    expect(
      createSubmissionKey({ amount: 25, asset: 'XLM', memo: undefined }),
    ).toBe(createSubmissionKey({ asset: 'XLM', amount: 25 }));
  });

  it('changes when payload or scope changes', () => {
    const payload = { amount: 25, asset: 'XLM' };
    expect(createSubmissionKey(payload)).not.toBe(
      createSubmissionKey({ ...payload, amount: 26 }),
    );
    expect(createSubmissionKey(payload, 'tab_a')).not.toBe(
      createSubmissionKey(payload, 'tab_b'),
    );
  });

  it('is url-safe and long enough for an Idempotency-Key header', () => {
    const key = createSubmissionKey({ amount: 25 });
    expect(key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(key.startsWith('link_')).toBe(true);
  });
});
