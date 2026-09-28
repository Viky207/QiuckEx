/**
 * Per-resource webhook delivery policy: ordering, deduplication, and
 * quarantine.
 *
 * "Resource" is the subscriber endpoint (a webhook row), not the wallet. Two
 * endpoints registered by the same wallet are two independent delivery streams
 * and must not interfere with each other's progress.
 *
 * Ordering
 *   Each enqueue is assigned a strictly increasing per-resource sequence.
 *   A delivery may only be attempted when it is the lowest unfinished sequence
 *   for its resource, so an event that failed transiently blocks later events
 *   behind it instead of being delivered out of order. Blocking is released by
 *   success or by quarantine, so a permanently failing event cannot wedge the
 *   stream forever.
 *
 * Deduplication
 *   The idempotency key is derived from (resource, eventType, eventId, version).
 *   Re-ingesting the same event, replaying it, or re-running a job that already
 *   succeeded is a no-op rather than a second POST to the endpoint.
 *
 * Quarantine
 *   Retries are bounded. A delivery that exhausts its attempts, or that fails
 *   permanently, moves to `quarantine` with a stable reason and stops being
 *   retried automatically. Recovery is an explicit operator action.
 *
 * This module is intentionally pure: ordering and quarantine decisions are
 * derived from delivery state, so they are deterministic and unit-testable
 * without a database or a queue.
 */

import {
  WEBHOOK_MAX_DELIVERY_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
} from "./webhook-retry.constants";

/** Terminal-on-success and terminal-on-quarantine statuses. */
export type WebhookDeliveryState =
  | "pending"
  | "sent"
  | "failed"
  | "dlq";

/** Stable quarantine reasons surfaced through the delivery-status API. */
export type WebhookQuarantineReason =
  | "ATTEMPTS_EXHAUSTED"
  | "PERMANENT_CLIENT_ERROR"
  | "ORDERING_BLOCK_TIMEOUT"
  | "MANUAL";

export interface WebhookDeliveryRecord {
  /** Subscriber endpoint the delivery belongs to. */
  resourceId: string;
  /** Per-resource monotonic sequence, starting at 1. */
  sequence: number;
  status: WebhookDeliveryState;
  attempts: number;
  lastFailedAt?: string;
  updatedAt?: string;
}

/**
 * Deterministic idempotency key for a delivery attempt.
 *
 * The version is part of the key so a subscriber pinned to `v1` and one pinned to
 * `v2` each receive exactly one delivery of an event they subscribed to.
 */
export function buildIdempotencyKey(
  resourceId: string,
  eventType: string,
  eventId: string,
  apiVersion: string,
): string {
  return `${resourceId}:${eventType}:${eventId}:${apiVersion}`;
}

/**
 * Decide whether a delivery may be attempted now.
 *
 * `records` is the set of unfinished deliveries for the same resource. A
 * delivery is allowed when no lower sequence is still unfinished, or when a
 * lower sequence has exhausted its attempts (it will be quarantined, so waiting
 * on it serves no ordering purpose).
 */
export function canAttemptDelivery(
  record: WebhookDeliveryRecord,
  records: readonly WebhookDeliveryRecord[],
): boolean {
  if (record.status === "sent") return false;
  if (record.status === "dlq") return false;

  const blocking = records.filter(
    (candidate) =>
      candidate.resourceId === record.resourceId &&
      candidate.sequence < record.sequence &&
      isUnfinished(candidate),
  );

  return blocking.length === 0;
}

/**
 * A record blocks later sequences while it can still make progress. A record
 * that has exhausted its attempts is released so it cannot wedge the stream.
 */
function isUnfinished(record: WebhookDeliveryRecord): boolean {
  if (record.status === "pending") return true;
  if (record.status === "failed") {
    return record.attempts < WEBHOOK_MAX_DELIVERY_ATTEMPTS;
  }
  return false;
}

/**
 * Next automatic retry time for a failed delivery, or `null` when it should be
 * quarantined instead.
 */
export function computeNextRetryAt(
  record: WebhookDeliveryRecord,
  now: Date = new Date(),
): Date | null {
  if (record.status !== "failed") return null;
  if (record.attempts >= WEBHOOK_MAX_DELIVERY_ATTEMPTS) return null;

  const delayMs =
    WEBHOOK_RETRY_DELAYS_MS[record.attempts - 1] ??
    WEBHOOK_RETRY_DELAYS_MS[WEBHOOK_RETRY_DELAYS_MS.length - 1];
  const lastFailedAt = record.lastFailedAt
    ? new Date(record.lastFailedAt)
    : now;

  if (Number.isNaN(lastFailedAt.getTime())) return now;

  return new Date(lastFailedAt.getTime() + delayMs);
}

/** True when the retry backoff for this record has elapsed. */
export function isRetryDue(
  record: WebhookDeliveryRecord,
  now: Date = new Date(),
): boolean {
  const nextRetryAt = computeNextRetryAt(record, now);
  if (!nextRetryAt) return false;
  return nextRetryAt.getTime() <= now.getTime();
}

/**
 * Quarantine decision for a completed attempt.
 *
 * `permanent` marks an error the endpoint will not recover from on retry (a
 * 4xx other than 408/429), which quarantines immediately rather than burning
 * the remaining attempts.
 */
export function resolveQuarantine(
  record: WebhookDeliveryRecord,
  options: { permanent?: boolean } = {},
): { quarantine: boolean; reason?: WebhookQuarantineReason } {
  if (options.permanent) {
    return { quarantine: true, reason: "PERMANENT_CLIENT_ERROR" };
  }

  if (record.attempts >= WEBHOOK_MAX_DELIVERY_ATTEMPTS) {
    return { quarantine: true, reason: "ATTEMPTS_EXHAUSTED" };
  }

  return { quarantine: false };
}

/**
 * HTTP responses that are permanent: the endpoint rejected the delivery and
 * will reject the same payload again. 408 and 429 are explicitly transient.
 */
export function isPermanentHttpStatus(status: number): boolean {
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

/** Total attempts a delivery is allowed, re-exported for callers of this module. */
export const WEBHOOK_DELIVERY_ATTEMPT_BUDGET = WEBHOOK_MAX_DELIVERY_ATTEMPTS;
