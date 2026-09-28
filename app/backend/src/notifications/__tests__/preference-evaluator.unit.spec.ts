import {
  evaluateNotificationPreference,
  shouldSendNotification,
  type NotificationSuppressionReason,
} from "../utils/preference-evaluator";
import type {
  NotificationPayload,
  NotificationPreference,
} from "../types/notification.types";

const PUBLIC_KEY = "GDQERHRWJYV7JHRP5V7DWJVI6Y5ABZP3YRH7DKYJRBEGJQKE6IQEOSY2";

function makePref(
  overrides: Partial<NotificationPreference> = {},
): NotificationPreference {
  return {
    id: "pref-1",
    publicKey: PUBLIC_KEY,
    channel: "email",
    email: "user@example.com",
    events: null,
    minAmountStroops: 0n,
    enabled: true,
    ...overrides,
  };
}

function makePayload(
  overrides: Partial<NotificationPayload> = {},
): NotificationPayload {
  return {
    eventType: "payment.received",
    eventId: "tx-abc",
    recipientPublicKey: PUBLIC_KEY,
    title: "Payment",
    body: "You received a payment",
    occurredAt: new Date().toISOString(),
    amountStroops: 100_000_000n,
    txHash: "tx-abc",
    sender: "GSENDER",
    ...overrides,
  } as NotificationPayload;
}

/**
 * Issue #274: preferences must be enforced identically on every channel, not
 * just the channels that happened to be routed through a provider earlier.
 */
describe("evaluateNotificationPreference", () => {
  it("allows a delivery that satisfies every preference", () => {
    expect(evaluateNotificationPreference(makePref(), makePayload())).toEqual({
      allowed: true,
      reason: "ALLOWED",
    });
    expect(shouldSendNotification(makePref(), makePayload())).toBe(true);
  });

  it("suppresses a disabled channel with CHANNEL_DISABLED", () => {
    const decision = evaluateNotificationPreference(
      makePref({ enabled: false }),
      makePayload(),
    );

    expect(decision).toEqual({
      allowed: false,
      reason: "CHANNEL_DISABLED",
    });
  });

  it("suppresses an event the user did not subscribe to", () => {
    const decision = evaluateNotificationPreference(
      makePref({ events: ["EscrowDeposited"] }),
      makePayload({ eventType: "payment.received" }),
    );

    expect(decision).toEqual({
      allowed: false,
      reason: "EVENT_NOT_SUBSCRIBED",
    });
  });

  it("treats a null event list as subscribe-to-everything", () => {
    expect(
      evaluateNotificationPreference(
        makePref({ events: null }),
        makePayload({ eventType: "EscrowDeposited" }),
      ).allowed,
    ).toBe(true);
  });

  it("suppresses a payment below the configured amount threshold", () => {
    const decision = evaluateNotificationPreference(
      makePref({ minAmountStroops: 1_000n }),
      makePayload({ amountStroops: 999n }),
    );

    expect(decision).toEqual({ allowed: false, reason: "BELOW_MIN_AMOUNT" });
  });

  it("allows a payment exactly at the amount threshold (inclusive bound)", () => {
    expect(
      evaluateNotificationPreference(
        makePref({ minAmountStroops: 1_000n }),
        makePayload({ amountStroops: 1_000n }),
      ).allowed,
    ).toBe(true);
  });

  it("does not apply the amount threshold to events without an amount", () => {
    const decision = evaluateNotificationPreference(
      makePref({ minAmountStroops: 1_000n }),
      makePayload({ amountStroops: undefined }),
    );

    // A threshold cannot be evaluated against a missing amount, so the event is
    // delivered rather than silently dropped.
    expect(decision.allowed).toBe(true);
  });

  it("ignores a zero amount threshold", () => {
    expect(
      evaluateNotificationPreference(
        makePref({ minAmountStroops: 0n }),
        makePayload({ amountStroops: 1n }),
      ).allowed,
    ).toBe(true);
  });


  describe("per-channel destination enforcement", () => {
    it("suppresses email with no address configured", () => {
      const decision = evaluateNotificationPreference(
        makePref({ channel: "email", email: undefined }),
        makePayload(),
      );

      expect(decision).toEqual({
        allowed: false,
        reason: "MISSING_DESTINATION",
      });
    });

    it("suppresses email with a blank address", () => {
      const decision = evaluateNotificationPreference(
        makePref({ channel: "email", email: "   " }),
        makePayload(),
      );

      expect(decision.reason).toBe("MISSING_DESTINATION");
    });

    it("suppresses push with no push token", () => {
      const decision = evaluateNotificationPreference(
        makePref({ channel: "push", pushToken: undefined }),
        makePayload(),
      );

      expect(decision.reason).toBe("MISSING_DESTINATION");
    });

    it("allows push when a push token is present", () => {
      expect(
        evaluateNotificationPreference(
          makePref({ channel: "push", pushToken: "ExponentPushToken[abc]" }),
          makePayload(),
        ).allowed,
      ).toBe(true);
    });

    it("suppresses webhook with no URL", () => {
      const decision = evaluateNotificationPreference(
        makePref({ channel: "webhook", webhookUrl: undefined }),
        makePayload(),
      );

      expect(decision.reason).toBe("MISSING_DESTINATION");
    });

    it("allows webhook when a URL is present", () => {
      expect(
        evaluateNotificationPreference(
          makePref({
            channel: "webhook",
            webhookUrl: "https://example.com/hook",
          }),
          makePayload(),
        ).allowed,
      ).toBe(true);
    });

    it("does not require a destination for in_app or telegram", () => {
      for (const channel of ["in_app", "telegram"] as const) {
        expect(
          evaluateNotificationPreference(makePref({ channel }), makePayload())
            .allowed,
        ).toBe(true);
      }
    });
  });

  it("evaluates in a fixed order so the emitted reason is deterministic", () => {
    // Every condition fails at once; the first rule in the documented order
    // (disabled) must win, so dashboards see one stable reason.
    const decision = evaluateNotificationPreference(
      makePref({
        enabled: false,
        events: ["EscrowDeposited"],
        minAmountStroops: 10n,
        email: undefined,
      }),
      makePayload(),
    );

    expect(decision.reason).toBe("CHANNEL_DISABLED");
  });

  it("emits only reasons from the stable suppression contract", () => {
    const stable: NotificationSuppressionReason[] = [
      "CHANNEL_DISABLED",
      "EVENT_NOT_SUBSCRIBED",
      "BELOW_MIN_AMOUNT",
      "MISSING_DESTINATION",
    ];

    expect(stable).toContain(
      evaluateNotificationPreference(
        makePref({ enabled: false }),
        makePayload(),
      ).reason,
    );
  });
});
