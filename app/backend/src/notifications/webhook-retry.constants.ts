/** Retry delays in milliseconds: 1m, 5m, 15m, 1h, 6h (exponential backoff). */
export const WEBHOOK_RETRY_DELAYS_MS = [
  60_000,
  300_000,
  900_000,
  3_600_000,
  21_600_000,
] as const;

/**
 * Extract the HTTP status from a provider error message.
 *
 * The webhook provider phrases failures as `Webhook returned HTTP 503 for ...`,
 * so the status is recoverable from the message. Returning `null` for anything
 * unparseable keeps the caller on the conservative path: treat it as transient
 * and let the attempt budget decide, rather than quarantining on a guess.
 */
export function extractHttpStatus(message: string): number | null {
  const match = /HTTP\s+(\d{3})/i.exec(message);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : null;
}

/** Total delivery attempts (1 initial + retries). */
export const WEBHOOK_MAX_DELIVERY_ATTEMPTS =
  WEBHOOK_RETRY_DELAYS_MS.length + 1;

/**
 * Default overlap window, in milliseconds, during which a rotated webhook
 * signing secret is still accepted for verification (issue #277).
 *
 * Overridable per deployment with WEBHOOK_SECRET_ROTATION_GRACE_MS. Set it to 0
 * to rotate with no overlap (old secret stops working immediately).
 */
export const WEBHOOK_SECRET_ROTATION_GRACE_MS = Number(
  process.env["WEBHOOK_SECRET_ROTATION_GRACE_MS"] ?? 3_600_000,
);

export function computeWebhookNextRetryAt(
  attempts: number,
  lastFailedAt: string | Date,
): Date | null {
  if (attempts <= 0 || attempts >= WEBHOOK_MAX_DELIVERY_ATTEMPTS) {
    return null;
  }

  const delayMs =
    WEBHOOK_RETRY_DELAYS_MS[attempts - 1] ??
    WEBHOOK_RETRY_DELAYS_MS[WEBHOOK_RETRY_DELAYS_MS.length - 1];
  const base =
    lastFailedAt instanceof Date
      ? lastFailedAt.getTime()
      : new Date(lastFailedAt).getTime();

  return new Date(base + delayMs);
}
