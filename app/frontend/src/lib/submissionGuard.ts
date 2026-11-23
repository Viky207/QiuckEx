/**
 * Framework-agnostic single-flight guard for form submissions.
 *
 * React state updates are asynchronous, so `disabled={loading}` alone cannot
 * stop a second click that lands before the next render. The guard below uses
 * a synchronous in-flight flag to ignore those duplicate submissions, and a
 * small bounded replay cache so a retry after a timeout can return the result
 * of a request that already succeeded.
 */

export type SubmissionOutcome<T> =
  | { ok: true; value: T }
  | { ok: false };

export type SubmissionAttempt<T> =
  | { status: 'duplicate' }
  | { status: 'replay'; value: T }
  | {
      status: 'start';
      key: string;
      settle: (outcome: SubmissionOutcome<T>) => void;
    };

export interface SubmissionGuard<T> {
  readonly pending: boolean;
  begin(key: string): SubmissionAttempt<T>;
  reset(): void;
}

export interface SubmissionGuardOptions {
  /** How long a successful result can be replayed. Defaults to five minutes. */
  ttlMs?: number;
  /** Maximum number of cached results. Defaults to 20. */
  maxCached?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CACHED = 20;

export function createSubmissionGuard<T>(
  options: SubmissionGuardOptions = {},
): SubmissionGuard<T> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxCached = options.maxCached ?? DEFAULT_MAX_CACHED;
  const now = options.now ?? (() => Date.now());

  const successful = new Map<string, { value: T; expiresAt: number }>();
  let pending = false;

  const prune = () => {
    const timestamp = now();
    for (const [key, entry] of successful) {
      if (entry.expiresAt <= timestamp) {
        successful.delete(key);
      }
    }
  };

  return {
    get pending() {
      return pending;
    },

    begin(key: string): SubmissionAttempt<T> {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error('A submission key is required.');
      }

      prune();

      // This check is deliberately synchronous: two clicks in the same tick
      // must not start two requests, even before React re-renders the button.
      if (pending) {
        return { status: 'duplicate' };
      }

      const cached = successful.get(key);
      if (cached) {
        return { status: 'replay', value: cached.value };
      }

      pending = true;
      let settled = false;

      return {
        status: 'start',
        key,
        settle(outcome: SubmissionOutcome<T>) {
          if (settled) {
            return;
          }
          settled = true;
          pending = false;

          if (!outcome.ok) {
            // A failed submission is not cached: the user can retry with the
            // same key and the backend idempotency contract handles replay.
            return;
          }

          successful.delete(key);
          successful.set(key, {
            value: outcome.value,
            expiresAt: now() + ttlMs,
          });

          while (successful.size > maxCached) {
            const oldest = successful.keys().next().value as string | undefined;
            if (oldest === undefined) {
              break;
            }
            successful.delete(oldest);
          }
        },
      };
    },

    reset() {
      pending = false;
      successful.clear();
    },
  };
}

/**
 * Stable, url-safe key for a submission payload. Object key order is
 * irrelevant, and the optional scope keeps two browser sessions apart.
 */
export function createSubmissionKey(payload: unknown, scope = 'link'): string {
  const serialized = stableStringify(payload);
  const first = fnv1a(serialized, 0x811c9dc5);
  const second = fnv1a(serialized, 0x01000193);
  const safeScope = scope.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'link';

  return `${safeScope}_${first.toString(16).padStart(8, '0')}${second
    .toString(16)
    .padStart(8, '0')}`;
}

function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();

  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
