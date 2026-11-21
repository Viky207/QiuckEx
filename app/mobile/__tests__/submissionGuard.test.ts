import {
  createSubmissionGuard,
  createSubmissionKey,
} from '../utils/submissionGuard';

const KEY = 'link_mobile_payload_0001';

describe('mobile link submission guard', () => {
  it('drops a second tap while a request is in flight', () => {
    const guard = createSubmissionGuard<string>();
    const attempt = guard.begin(KEY);
    expect(attempt.status).toBe('start');

    expect(guard.begin(KEY)).toEqual({ status: 'duplicate' });

    if (attempt.status === 'start') {
      attempt.settle({ ok: true, value: 'https://quickex.to/pay?abc' });
    }
    expect(guard.begin(KEY)).toEqual({
      status: 'replay',
      value: 'https://quickex.to/pay?abc',
    });
  });

  it('allows a retry after a failed submission and keeps the form payload key stable', () => {
    const guard = createSubmissionGuard<string>();
    const failed = guard.begin(KEY);
    if (failed.status === 'start') failed.settle({ ok: false });

    const retry = guard.begin(KEY);
    expect(retry.status).toBe('start');
    if (retry.status === 'start') retry.settle({ ok: true, value: 'link' });

    expect(createSubmissionKey({ amount: 1, asset: 'XLM' })).toBe(
      createSubmissionKey({ asset: 'XLM', amount: 1 }),
    );
  });
});
