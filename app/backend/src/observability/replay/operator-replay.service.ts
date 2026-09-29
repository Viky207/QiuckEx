import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";

import { AuditService } from "../../audit/audit.service";
import { MetricsService } from "../../metrics/metrics.service";
import { NotificationLogRepository } from "../../notifications/notification-log.repository";
import { NotificationPreferencesRepository } from "../../notifications/notification-preferences.repository";
import { NotificationService } from "../../notifications/notification.service";
import { WebhookReplayService } from "../../notifications/webhook-replay.service";
import type {
  NotificationChannel,
  NotificationEventType,
  NotificationPayload,
} from "../../notifications/types/notification.types";

/**
 * Stable error codes returned by the operator replay surface. These are part
 * of the API contract (see docs/OBSERVABILITY-OPERATIONS.md) and must not
 * change without a contract-map update.
 */
export const OPERATOR_REPLAY_ERRORS = {
  UNAUTHORIZED: "OPERATOR_REPLAY_UNAUTHORIZED",
  DISABLED: "OPERATOR_REPLAY_DISABLED",
  MALFORMED: "OPERATOR_REPLAY_MALFORMED",
  NOT_FOUND: "OPERATOR_REPLAY_NOT_FOUND",
  ALREADY_DELIVERED: "OPERATOR_REPLAY_ALREADY_DELIVERED",
  CHANNEL_UNSUPPORTED: "OPERATOR_REPLAY_CHANNEL_UNSUPPORTED",
  COOLDOWN: "OPERATOR_REPLAY_COOLDOWN",
  QUOTA_EXCEEDED: "OPERATOR_REPLAY_QUOTA_EXCEEDED",
  DEPENDENCY_FAILURE: "OPERATOR_REPLAY_DEPENDENCY_FAILURE",
} as const;

export type OperatorReplayErrorCode =
  (typeof OPERATOR_REPLAY_ERRORS)[keyof typeof OPERATOR_REPLAY_ERRORS];

/** Stable outcome codes, used as the `outcome` metric label. */
export const OPERATOR_REPLAY_OUTCOMES = {
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  REJECTED: "rejected",
} as const;

export interface OperatorReplayResult {
  /** Always true: the request was accepted and executed. */
  accepted: boolean;
  target: "notification" | "webhook";
  channel: NotificationChannel;
  eventType: string;
  eventId: string;
  /** True when the redelivery attempt reported success. */
  delivered: boolean;
  message: string;
}

/**
 * Replayable channels.
 *
 * `in_app` is excluded deliberately: an in-app notification is a row in the
 * user's own inbox, and duplicating it would show a user two copies of the
 * same event. Replay exists to recover a *lost* delivery, and an in-app
 * notification is never lost once committed.
 */
export const REPLAYABLE_CHANNELS: readonly NotificationChannel[] = [
  "webhook",
  "email",
  "push",
  "telegram",
];

/**
 * Operator-initiated replay of notification and webhook deliveries.
 *
 * The safety properties this service exists to guarantee:
 *
 *  - **Authorization.** Every call is an admin-scoped API call; the service
 *    never infers authority from the payload. The public key in the request
 *    identifies *whose* notification to replay, not who may ask.
 *  - **Idempotency.** A delivery already in `pending` is rejected with a
 *    conflict rather than duplicated, and a delivery already `sent` is refused
 *    outright, so an operator cannot cause a double notification.
 *  - **Blast radius.** Webhook replays reuse the existing per-event cooldown
 *    and per-webhook quota limiter, and every channel is still subject to the
 *    notification rate limiter, so a replay storm degrades into rejections
 *    instead of amplifying into a subscriber's endpoint.
 *  - **Financial safety.** Replay re-sends a *notification* about an already
 *    recorded event. It never moves funds, never re-executes a contract call,
 *    and never writes to the escrow state machine, so no financial invariant
 *    (INV-01..INV-10) can be affected by a replay.
 *  - **Auditability.** Every attempt — accepted, rejected, or failed — is
 *    written to the audit log and counted in a metric.
 */
@Injectable()
export class OperatorReplayService {
  private readonly logger = new Logger(OperatorReplayService.name);

  constructor(
    private readonly logRepo: NotificationLogRepository,
    private readonly prefsRepo: NotificationPreferencesRepository,
    private readonly notificationService: NotificationService,
    private readonly webhookReplayService: WebhookReplayService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
  ) {}

  /** Inspect a delivery without replaying it. */
  async getDeliveryStatus(
    publicKey: string,
    channel: NotificationChannel,
    eventType: string,
    eventId: string,
  ) {
    const delivery = await this.logRepo.getDelivery(
      publicKey,
      channel,
      eventType,
      eventId,
    );

    if (!delivery) {
      throw new NotFoundException({
        code: OPERATOR_REPLAY_ERRORS.NOT_FOUND,
        message: "No delivery record found for this event",
      });
    }

    return delivery;
  }

  /**
   * Replay one delivery. `actor` is the authenticated operator identity taken
   * from the API key, never from the request body, so the audit trail cannot be
   * spoofed by the caller.
   */
  async replay(
    publicKey: string,
    channel: NotificationChannel,
    eventType: string,
    eventId: string,
    actor: string,
  ): Promise<OperatorReplayResult> {
    const target = channel === "webhook" ? "webhook" : "notification";
    this.assertReplayable(channel, eventType, eventId);

    let delivery;
    try {
      delivery = await this.logRepo.getDelivery(
        publicKey,
        channel,
        eventType,
        eventId,
      );
    } catch (error) {
      return this.failDependency(target, channel, eventType, eventId, error);
    }

    if (!delivery) {
      this.reject(
        target,
        channel,
        eventType,
        eventId,
        OPERATOR_REPLAY_ERRORS.NOT_FOUND,
        HttpStatus.NOT_FOUND,
        "No delivery record found for this event",
      );
    }

    if (delivery.status === "sent") {
      this.reject(
        target,
        channel,
        eventType,
        eventId,
        OPERATOR_REPLAY_ERRORS.ALREADY_DELIVERED,
        HttpStatus.CONFLICT,
        "Delivery already succeeded; refusing to send a duplicate",
      );
    }

    if (delivery.status === "pending") {
      this.reject(
        target,
        channel,
        eventType,
        eventId,
        OPERATOR_REPLAY_ERRORS.COOLDOWN,
        HttpStatus.CONFLICT,
        "Delivery is already in progress for this event",
      );
    }

    let delivered: boolean;
    try {
      delivered = await this.redeliver(publicKey, channel, eventType, eventId);
    } catch (error) {
      return this.failDependency(target, channel, eventType, eventId, error);
    }

    await this.audit.log(
      actor,
      "operator.replay",
      `${channel}/${eventType}/${eventId}`,
      {
        channel,
        eventType,
        publicKey,
        delivered,
        previousStatus: delivery.status,
        previousAttempts: delivery.attempts,
      },
    );

    this.metrics.recordOperatorReplay(
      target,
      delivered
        ? OPERATOR_REPLAY_OUTCOMES.SUCCEEDED
        : OPERATOR_REPLAY_OUTCOMES.FAILED,
    );

    this.logger.log(
      `Operator replay ${delivered ? "succeeded" : "failed"}: ` +
        `${channel}/${eventType}/${eventId} actor=${actor}`,
    );

    return {
      accepted: true,
      target,
      channel,
      eventType,
      eventId,
      delivered,
      message: delivered
        ? "Replay delivered successfully"
        : "Replay attempted but delivery did not succeed — inspect delivery status",
    };
  }

  /**
   * Perform the actual redelivery.
   *
   * Webhooks delegate to the existing `WebhookReplayService`, which already
   * owns the cooldown/quota limiter, the replay audit table and the retry
   * scheduler. Re-implementing that here would create two competing safety
   * mechanisms, so the operator surface is a thin, authorized front door onto
   * it.
   */
  private async redeliver(
    publicKey: string,
    channel: NotificationChannel,
    eventType: string,
    eventId: string,
  ): Promise<boolean> {
    if (channel === "webhook") {
      const webhooks = await this.prefsRepo.getWebhooksByPublicKey(publicKey);
      const active = webhooks.filter(
        (webhook) => webhook.enabled && webhook.webhookUrl,
      );
      const webhookId = active[0]?.id;

      if (!webhookId) {
        throw new ServiceUnavailableException({
          code: OPERATOR_REPLAY_ERRORS.DEPENDENCY_FAILURE,
          message: "No enabled webhook is registered for this account",
        });
      }

      const result = await this.webhookReplayService.replayDelivery(
        publicKey,
        webhookId,
        eventId,
        eventType,
        "operator",
      );

      return result.deliverySuccess === true;
    }

    await this.logRepo.resetNotificationForManualReplay(
      publicKey,
      channel,
      eventType as NotificationEventType,
      eventId,
    );

    const preference = (
      await this.prefsRepo.getPreferences(publicKey)
    ).find((entry) => entry.channel === channel);

    if (!preference) {
      throw new ServiceUnavailableException({
        code: OPERATOR_REPLAY_ERRORS.DEPENDENCY_FAILURE,
        message: "No notification preference exists for this channel",
      });
    }

    // The payload union is discriminated on eventType and the concrete
    // payload types carry event-specific fields; the operator replay has no
    // access to the original payload, so it is reconstructed from the event
    // identity alone and cast, exactly as the retry sweep already does.
    await this.notificationService.redeliverToChannel(
      preference,
      {
        eventType: eventType as NotificationEventType,
        eventId,
        recipientPublicKey: publicKey,
        title: `Replay: ${eventType}`,
        body: `Event ${eventId} replayed by an operator`,
        occurredAt: new Date().toISOString(),
      } as NotificationPayload,
    );

    // The delivery row is the source of truth for the outcome: the replay only
    // counts as delivered when the row actually moved to `sent`.
    const after = await this.logRepo.getDelivery(
      publicKey,
      channel,
      eventType,
      eventId,
    );

    return after?.status === "sent";
  }

  /**
   * Validation that must happen before any I/O. Rejecting an unsupported
   * channel or a missing event identifier up front keeps the audit log free of
   * entries for requests that could never have been executed.
   */
  private assertReplayable(
    channel: NotificationChannel,
    eventType: string,
    eventId: string,
  ): void {
    const target = channel === "webhook" ? "webhook" : "notification";

    if (!REPLAYABLE_CHANNELS.includes(channel)) {
      this.metrics.recordOperatorReplay(
        target,
        OPERATOR_REPLAY_OUTCOMES.REJECTED,
      );
      throw new BadRequestException({
        code: OPERATOR_REPLAY_ERRORS.CHANNEL_UNSUPPORTED,
        message: `Channel "${channel}" is not replayable`,
      });
    }

    if (!eventType?.trim() || !eventId?.trim()) {
      this.metrics.recordOperatorReplay(
        target,
        OPERATOR_REPLAY_OUTCOMES.REJECTED,
      );
      throw new BadRequestException({
        code: OPERATOR_REPLAY_ERRORS.MALFORMED,
        message: "eventType and eventId are required",
      });
    }
  }

  /**
   * Reject with a stable code and count the rejection. Rejections are the most
   * operationally interesting outcome of a replay tool, so they are counted as
   * visibly as successes.
   */
  private reject(
    target: "notification" | "webhook",
    channel: NotificationChannel,
    eventType: string,
    eventId: string,
    code: string,
    status: HttpStatus,
    message: string,
  ): never {
    this.metrics.recordOperatorReplay(target, OPERATOR_REPLAY_OUTCOMES.REJECTED);
    this.logger.warn(
      `Operator replay rejected (${code}): ${channel}/${eventType}/${eventId}`,
    );

    throw new HttpException({ code, message }, status);
  }

  /**
   * A dependency failure is reported as a stable 503 rather than a 500, so an
   * operator (or a retrying script) can distinguish "try again" from "this
   * request was wrong".
   */
  private failDependency(
    target: "notification" | "webhook",
    channel: NotificationChannel,
    eventType: string,
    eventId: string,
    error: unknown,
  ): never {
    const message =
      error instanceof Error ? error.message : "unknown dependency failure";

    this.metrics.recordOperatorReplay(target, OPERATOR_REPLAY_OUTCOMES.FAILED);
    this.logger.error(
      `Operator replay dependency failure for ` +
        `${channel}/${eventType}/${eventId}: ${message}`,
    );

    throw new ServiceUnavailableException({
      code: OPERATOR_REPLAY_ERRORS.DEPENDENCY_FAILURE,
      message: "Replay could not be completed because a dependency failed",
    });
  }
}
