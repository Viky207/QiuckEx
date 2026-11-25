export type RetryState = 'idle' | 'loading' | 'retrying' | 'failed' | 'terminal';

export interface RetryPolicy {
  /** Maximum number of retry attempts after the initial request. */
  maxAttempts: number;
  /** Base backoff in milliseconds for exponential delay. */
  baseDelayMs: number;
  /** Upper bound for any single backoff delay. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
};

export interface RetryFeedback {
  state: RetryState;
  /** Human-readable status suitable for aria-live announcements. */
  message: string;
  /** Milliseconds until the next attempt, or null when not waiting. */
  nextRetryInMs: number | null;
  /** Whether the retry CTA should be enabled. */
  canRetry: boolean;
  /** Whether the failure is terminal (no further retries allowed). */
  isTerminal: boolean;
}

/**
 * Parse a Retry-After header value into milliseconds.
 * Supports both delta-seconds and HTTP-date formats. Returns null when absent/invalid.
 */
export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - now);
}

/**
 * Compute the backoff delay for a given attempt, honoring server Retry-After
 * and clamping to the policy's max delay so retries stay bounded.
 */
export function computeBackoffMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  retryAfterMs: number | null = null,
): number {
  if (retryAfterMs !== null && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, policy.maxDelayMs);
  }
  const exponential = policy.baseDelayMs * Math.pow(2, Math.max(0, attempt));
  return Math.min(exponential, policy.maxDelayMs);
}

/**
 * Determine whether another retry is permitted given the attempt count and
 * whether the server signaled a terminal (non-retryable) failure.
 */
export function canRetry(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  terminal: boolean = false,
): boolean {
  if (terminal) return false;
  return attempt < policy.maxAttempts;
}

/**
 * Build the retry feedback object used to drive the shared retry CTA and
 * aria-live status region. Keeps loading and terminal failures distinct.
 */
export function buildRetryFeedback(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  options: { terminal?: boolean; retryAfterMs?: number | null; loading?: boolean } = {},
): RetryFeedback {
  const { terminal = false, retryAfterMs = null, loading = false } = options;

  if (loading) {
    return {
      state: 'loading',
      message: 'Loading…',
      nextRetryInMs: null,
      canRetry: false,
      isTerminal: false,
    };
  }

  if (terminal) {
    return {
      state: 'terminal',
      message: 'This request could not be completed. Please review the details and try again later.',
      nextRetryInMs: null,
      canRetry: false,
      isTerminal: true,
    };
  }

  const allowed = canRetry(attempt, policy, terminal);
  if (!allowed) {
    return {
      state: 'terminal',
      message: 'Retries exhausted. Please try again later.',
      nextRetryInMs: null,
      canRetry: false,
      isTerminal: true,
    };
  }

  const delay = computeBackoffMs(attempt, policy, retryAfterMs);
  return {
    state: 'retrying',
    message: `Transient error. Retrying in ${Math.ceil(delay / 1000)}s (attempt ${attempt + 1} of ${policy.maxAttempts}).`,
    nextRetryInMs: delay,
    canRetry: true,
    isTerminal: false,
  };
}

/**
 * Shared retry CTA label so network-dependent screens stay consistent.
 */
export function retryCtaLabel(feedback: RetryFeedback): string {
  if (feedback.state === 'loading') return 'Retrying…';
  if (feedback.isTerminal) return 'Try again';
  return 'Retry';
}
