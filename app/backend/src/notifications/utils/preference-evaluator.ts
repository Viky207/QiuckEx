import type {
  NotificationPreference,
  NotificationPayload,
  NotificationChannel,
} from "../types/notification.types";

/**
 * Stable, machine-readable reasons a notification was not delivered to a
 * channel. These strings are part of the observability contract: they are
 * emitted as structured log fields and as the `reason` label on suppression
 * metrics, so dashboards and alerts can rely on them.
 */
export type NotificationSuppressionReason =
  | "CHANNEL_DISABLED"
  | "EVENT_NOT_SUBSCRIBED"
  | "BELOW_MIN_AMOUNT"
  | "MISSING_DESTINATION";

export type NotificationDecisionReason = "ALLOWED" | NotificationSuppressionReason;

export interface NotificationDecision {
  /** True only when the notification may be handed to the channel provider. */
  allowed: boolean;
  reason: NotificationDecisionReason;
}

/**
 * Destination field required for each channel before a delivery attempt is
 * made. Attempting delivery without it produces a provider error that can only
 * be diagnosed from a failure log, so it is treated as a suppression instead.
 */
const REQUIRED_DESTINATION: Record<
  NotificationChannel,
  "email" | "pushToken" | "webhookUrl" | null
> = {
  email: "email",
  push: "pushToken",
  webhook: "webhookUrl",
  telegram: null,
  in_app: null,
};

function hasDestination(
  pref: NotificationPreference,
  channel: NotificationChannel,
): boolean {
  switch (REQUIRED_DESTINATION[channel]) {
    case "email":
      return typeof pref.email === "string" && pref.email.trim().length > 0;
    case "pushToken":
      return typeof pref.pushToken === "string" && pref.pushToken.trim().length > 0;
    case "webhookUrl":
      return typeof pref.webhookUrl === "string" && pref.webhookUrl.trim().length > 0;
    default:
      return true;
  }
}

/**
 * Authoritative preference gate shared by every channel (email, push, webhook,
 * telegram, in-app) and by the retry path.
 *
 * The evaluation order is fixed so the emitted reason is deterministic:
 * disabled channel -> event subscription -> amount threshold -> destination.
 */
export function evaluateNotificationPreference(
  pref: NotificationPreference,
  payload: NotificationPayload,
): NotificationDecision {
  if (!pref.enabled) {
    return { allowed: false, reason: "CHANNEL_DISABLED" };
  }

  if (pref.events && !pref.events.includes(payload.eventType)) {
    return { allowed: false, reason: "EVENT_NOT_SUBSCRIBED" };
  }

  if (pref.minAmountStroops > 0n && payload.amountStroops !== undefined) {
    if (payload.amountStroops < pref.minAmountStroops) {
      return { allowed: false, reason: "BELOW_MIN_AMOUNT" };
    }
  }

  if (!hasDestination(pref, pref.channel)) {
    return { allowed: false, reason: "MISSING_DESTINATION" };
  }

  return { allowed: true, reason: "ALLOWED" };
}

/** Convenience predicate over {@link evaluateNotificationPreference}. */
export function shouldSendNotification(
  pref: NotificationPreference,
  payload: NotificationPayload,
): boolean {
  return evaluateNotificationPreference(pref, payload).allowed;
}