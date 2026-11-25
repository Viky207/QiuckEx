/**
 * Shared public key resolution for frontend API calls.
 * Used by analytics and activity feed hooks to resolve the user's
 * Stellar public key from localStorage or environment variables.
 */
import { cacheInvalidator } from './cacheInvalidation';

const DEFAULT_PUBLIC_KEY =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;
const PUBLIC_KEY_STORAGE_CANDIDATES = [
  "quickex.publicKey",
  "quickex.walletPublicKey",
  "walletPublicKey",
  "publicKey",
];

export function resolveAuthenticatedPublicKey(): string | null {
  if (typeof window !== "undefined") {
    for (const key of PUBLIC_KEY_STORAGE_CANDIDATES) {
      const value = window.localStorage.getItem(key)?.trim();
      if (value && PUBLIC_KEY_REGEX.test(value)) {
        return value;
      }
    }
  }

  const fromEnv =
    process.env.NEXT_PUBLIC_QUICKEX_API_PUBLIC_KEY?.trim() ||
    process.env.NEXT_PUBLIC_QUICKEX_ANALYTICS_PUBLIC_KEY?.trim();

  return fromEnv && PUBLIC_KEY_REGEX.test(fromEnv) ? fromEnv : null;
}

/**
 * Resolve the user's Stellar public key from available sources:
 * 1. localStorage (browser wallets store the key under known keys)
 * 2. Environment variable (NEXT_PUBLIC_QUICKEX_ANALYTICS_PUBLIC_KEY)
 * 3. Fallback to a zero-value default key
 */
export function resolvePublicKey(): string {
  const authenticatedPublicKey = resolveAuthenticatedPublicKey();
  if (authenticatedPublicKey) return authenticatedPublicKey;

  return DEFAULT_PUBLIC_KEY;
}

/** Alias for `resolvePublicKey`, named for call sites that care this is the "currently active" account. */
export const getActivePublicKey = resolvePublicKey;

/**
 * Switch the active wallet account and notify every account-scoped query/cache
 * so they invalidate and refetch under the new key instead of showing stale rows.
 */
export function setActivePublicKey(publicKey: string): void {
  const trimmed = publicKey.trim();
  if (!PUBLIC_KEY_REGEX.test(trimmed)) {
    throw new Error("setActivePublicKey requires a valid Stellar public key.");
  }

  if (typeof window !== "undefined") {
    window.localStorage.setItem(PUBLIC_KEY_STORAGE_CANDIDATES[0], trimmed);
  }

  cacheInvalidator.invalidate("account_switched", { publicKey: trimmed });
}

/** Subscribe to active-account changes; returns an unsubscribe function. */
export function subscribeToActivePublicKey(
  listener: (publicKey: string) => void,
): () => void {
  return cacheInvalidator.subscribe((event) => {
    if (event.type === "account_switched" && event.payload?.publicKey) {
      listener(event.payload.publicKey);
    }
  });
}
