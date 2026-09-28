import {
  buildIdempotencyKey,
  canAttemptDelivery,
  computeNextRetryAt,
  isPermanentHttpStatus,
  isRetryDue,
  resolveQuarantine,
  type WebhookDeliveryRecord,
} from "../webhook-delivery-policy";
import { WEBHOOK_MAX_DELIVERY_ATTEMPTS } from "../webhook-retry.constants";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function record(
  overrides: Partial<WebhookDeliveryRecord> = {},
): WebhookDeliveryRecord {
  return {
    resourceId: "wh_1",
    sequence: 1,
    status: "failed",
    attempts: 1,
    lastFailedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("buildIdempotencyKey", () => {
  it("is deterministic for the same delivery inputs", () => {
    expect(buildIdempotencyKey("wh_1", "payment.received", "tx-1", "v1")).toBe(
      buildIdempotencyKey("wh_1", "payment.received", "tx-1", "v1"),
    );
  });

  it("differs per resource, so two endpoints never collide", () => {
    expect(buildIdempotencyKey("wh_1", "e", "tx", "v1")).not.toBe(
      buildIdempotencyKey("wh_2", "e", "tx", "v1"),
    );
  });

  it("reuses the same key for a replayed event and differs for a new one", () => {
    const first = buildIdempotencyKey("wh_1", "e", "tx-1", "v1");
    const replay = buildIdempotencyKey("wh_1", "e", "tx-1", "v1");
    const different = buildIdempotencyKey("wh_1", "e", "tx-2", "v1");

    expect(replay).toBe(first);
    expect(different).not.toBe(first);
  });

  it("differs per API version, so v1 and v2 subscribers each get one delivery", () => {
    expect(buildIdempotencyKey("wh_1", "e", "tx", "v1")).not.toBe(
      buildIdempotencyKey("wh_1", "e", "tx", "v2"),
    );
  });
});

describe("canAttemptDelivery (ordering, issue #276)", () => {
  it("allows the lowest sequence when nothing else is pending", () => {
    const current = record({ sequence: 1 });

    expect(canAttemptDelivery(current, [current])).toBe(true);
  });

  it("blocks a later sequence while an earlier one is still failed and retryable", () => {
    const earlier = record({ sequence: 1, attempts: 1 });
    const later = record({ sequence: 2, attempts: 1 });

    expect(canAttemptDelivery(later, [earlier, later])).toBe(false);
  });

  it("allows the later sequence once the earlier one succeeded", () => {
    const earlier = record({ sequence: 1, status: "sent" });
    const later = record({ sequence: 2 });

    expect(canAttemptDelivery(later, [earlier, later])).toBe(true);
  });

  it("allows the later sequence once the earlier one is quarantined", () => {
    // A quarantined event can never make progress, so holding the stream behind
    // it forever would be worse than delivering out of order.
    const earlier = record({ sequence: 1, status: "dlq" });
    const later = record({ sequence: 2 });

    expect(canAttemptDelivery(later, [earlier, later])).toBe(true);
  });

  it("blocks on a pending predecessor", () => {
    const earlier = record({ sequence: 1, status: "pending" });
    const later = record({ sequence: 2 });

    expect(canAttemptDelivery(later, [earlier, later])).toBe(false);
  });

  it("does not let one resource's progress block another resource", () => {
    const otherResource = record({
      resourceId: "wh_other",
      sequence: 1,
      attempts: 1,
    });
    const current = record({ resourceId: "wh_1", sequence: 5 });

    expect(canAttemptDelivery(current, [otherResource, current])).toBe(true);
  });

  it("never re-attempts a sent delivery", () => {
    expect(canAttemptDelivery(record({ status: "sent" }), [])).toBe(false);
  });

  it("never re-attempts a quarantined delivery", () => {
    expect(canAttemptDelivery(record({ status: "dlq" }), [])).toBe(false);
  });
});

describe("computeNextRetryAt", () => {
  it("schedules a retry after the backoff for the attempt count", () => {
    const next = computeNextRetryAt(record({ attempts: 1 }), NOW);

    expect(next?.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("returns null once the attempt budget is spent", () => {
    const exhausted = record({ attempts: WEBHOOK_MAX_DELIVERY_ATTEMPTS });

    expect(computeNextRetryAt(exhausted, NOW)).toBeNull();
  });

  it("returns null for a non-failed record", () => {
    expect(computeNextRetryAt(record({ status: "sent" }), NOW)).toBeNull();
    expect(computeNextRetryAt(record({ status: "pending" }), NOW)).toBeNull();
  });

  it("falls back to now when the last failure time is missing", () => {
    const next = computeNextRetryAt(
      record({ attempts: 1, lastFailedAt: undefined }),
      NOW,
    );

    expect(next).not.toBeNull();
  });
});

describe("isRetryDue", () => {
  it("is false while the backoff is still running", () => {
    expect(isRetryDue(record({ attempts: 1 }), NOW)).toBe(false);
  });

  it("is true once the backoff has elapsed", () => {
    const longAgo = new Date(NOW.getTime() - 10 * 60 * 60 * 1000).toISOString();

    expect(isRetryDue(record({ attempts: 1, lastFailedAt: longAgo }), NOW)).toBe(
      true,
    );
  });

  it("is false for an exhausted delivery, so it stops being retried", () => {
    const longAgo = new Date(NOW.getTime() - 10 * 60 * 60 * 1000).toISOString();
    const exhausted = record({
      attempts: WEBHOOK_MAX_DELIVERY_ATTEMPTS,
      lastFailedAt: longAgo,
    });

    expect(isRetryDue(exhausted, NOW)).toBe(false);
  });
});

describe("resolveQuarantine (issue #276)", () => {
  it("quarantines with ATTEMPTS_EXHAUSTED when the budget is spent", () => {
    const result = resolveQuarantine(
      record({ attempts: WEBHOOK_MAX_DELIVERY_ATTEMPTS }),
    );

    expect(result).toEqual({
      quarantine: true,
      reason: "ATTEMPTS_EXHAUSTED",
    });
  });

  it("quarantines a permanent client error immediately", () => {
    const result = resolveQuarantine(record({ attempts: 1 }), {
      permanent: true,
    });

    expect(result).toEqual({
      quarantine: true,
      reason: "PERMANENT_CLIENT_ERROR",
    });
  });

  it("keeps retrying a transient failure that still has budget", () => {
    expect(resolveQuarantine(record({ attempts: 1 }))).toEqual({
      quarantine: false,
    });
  });
});

describe("isPermanentHttpStatus", () => {
  it.each([400, 401, 403, 404, 410, 422])(
    "treats %s as permanent",
    (status) => {
      expect(isPermanentHttpStatus(status)).toBe(true);
    },
  );

  it.each([408, 429])("treats %s as transient", (status) => {
    expect(isPermanentHttpStatus(status)).toBe(false);
  });

  it.each([200, 202, 500, 502, 503])("treats %s as not permanent", (status) => {
    expect(isPermanentHttpStatus(status)).toBe(false);
  });
});

  });

  it("never re-attempts a sent delivery", () => {
    expect(canAttemptDelivery(record({ status: "sent" }), [])).toBe(false);
  });

  it("never re-attempts a quarantined delivery", () => {
    expect(canAttemptDelivery(record({ status: "dlq" }), [])).toBe(false);
  });
});
