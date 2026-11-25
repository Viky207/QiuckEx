import { useCallback, useEffect, useRef, useState } from "react";

export type RetryState = "idle" | "loading" | "failed" | "terminal";

export interface RetryNoticeProps {
  /** Human-readable description of what failed. */
  message: string;
  /** Called when the user activates the retry CTA. Should reject on failure. */
  onRetry: () => Promise<void> | void;
  /** Maximum attempts before the failure is treated as terminal. */
  maxAttempts?: number;
  /** Optional server-provided Retry-After in seconds. */
  retryAfterSeconds?: number | null;
  /** Optional label override for the retry CTA. */
  retryLabel?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function formatBackoff(seconds: number): string {
  if (seconds <= 0) return "";
  return `Try again in ${seconds}s`;
}

/**
 * Consistent retry CTA for transient service errors.
 *
 * - Bounded: honors maxAttempts and server Retry-After so repeated requests
 *   cannot loop unbounded.
 * - Distinct states: loading and terminal failures are announced via aria-live.
 * - Retained input: this component never owns form state, so caller inputs
 *   remain intact across retries and terminal failures.
 */
export default function RetryNotice({
  message,
  onRetry,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryAfterSeconds = null,
  retryLabel = "Retry",
}: RetryNoticeProps) {
  const [state, setState] = useState<RetryState>("failed");
  const [attempts, setAttempts] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const handleRetry = useCallback(async () => {
    if (state === "loading" || state === "terminal" || cooldown > 0) return;
    const nextAttempt = attempts + 1;
    setAttempts(nextAttempt);
    setState("loading");
    try {
      await onRetry();
      if (mounted.current) setState("idle");
    } catch {
      if (!mounted.current) return;
      if (nextAttempt >= maxAttempts) {
        setState("terminal");
      } else {
        setState("failed");
        if (retryAfterSeconds && retryAfterSeconds > 0) {
          setCooldown(retryAfterSeconds);
        }
      }
    }
  }, [attempts, cooldown, maxAttempts, onRetry, retryAfterSeconds, state]);

  if (state === "idle") return null;

  const isTerminal = state === "terminal";
  const isLoading = state === "loading";
  const disabled = isLoading || isTerminal || cooldown > 0;
  const backoffText = formatBackoff(cooldown);

  return (
    <div role="alert" aria-live="assertive" className="retry-notice">
      <p className="retry-notice__message">
        {isTerminal
          ? `${message} We could not complete this after ${maxAttempts} attempts. Please try again later.`
          : message}
      </p>
      {!isTerminal && (
        <button
          type="button"
          className="retry-notice__cta"
          onClick={handleRetry}
          disabled={disabled}
          aria-busy={isLoading}
        >
          {isLoading ? "Retrying…" : backoffText || retryLabel}
        </button>
      )}
      {isLoading && (
        <span className="retry-notice__status" role="status">
          Retrying, attempt {attempts} of {maxAttempts}…
        </span>
      )}
    </div>
  );
}
