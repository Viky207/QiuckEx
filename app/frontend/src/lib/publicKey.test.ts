import { describe, expect, it, vi } from 'vitest';
import { setActivePublicKey, subscribeToActivePublicKey } from './publicKey';
import { cacheInvalidator } from './cacheInvalidation';

const VALID_KEY_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB';
const VALID_KEY_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBC';

describe('setActivePublicKey / subscribeToActivePublicKey', () => {
  it('rejects an invalid Stellar public key', () => {
    expect(() => setActivePublicKey('not-a-key')).toThrow();
  });

  it('notifies subscribers with the new key on a valid switch', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToActivePublicKey(listener);

    setActivePublicKey(VALID_KEY_A);

    expect(listener).toHaveBeenCalledWith(VALID_KEY_A);
    unsubscribe();
  });

  it('does not fire for unrelated cache invalidation events', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToActivePublicKey(listener);

    cacheInvalidator.invalidate('payment_completed', { txHash: 'abc' });

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToActivePublicKey(listener);
    unsubscribe();

    setActivePublicKey(VALID_KEY_B);

    expect(listener).not.toHaveBeenCalled();
  });
});
