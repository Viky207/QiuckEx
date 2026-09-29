import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { MetricsService } from "../metrics/metrics.service";
import { NotificationLogRepository } from "./notification-log.repository";
import { NotificationPreferencesRepository } from "./notification-preferences.repository";
import { WebhookProvider } from "./providers/notification-provider.interface";
import type { BaseNotificationPayload } from "./types/notification.types";
import {
  canAttemptDelivery,
  computeNextRetryAt,
  isPermanentHttpStatus,
  isRetryDue,
  resolveQuarantine,
  type WebhookDeliveryRecord,
} from "./webhook-delivery-policy";
import {
  WEBHOOK_MAX_DELIVERY_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  extractHttpStatus,
} from "./webhook-retry.constants";

@Injectable()
export class WebhookRetryScheduler {
  private readonly logger = new Logger(WebhookRetryScheduler.name);
  private readonly provider = new WebhookProvider();

  constructor(
    private readonly logRepo: NotificationLogRepository,
    private readonly prefsRepo: NotificationPreferencesRepository,
    private readonly metrics?: MetricsService,
  ) {}

  /**
   * Runs every minute to pick up failed webhook deliveries that are due for retry.
   * After MAX_ATTEMPTS the entry moves to DLQ status (inspectable via delivery API).
   *
   * Ordering (issue #276): a delivery is only retried when it is the lowest
   * unfinished sequence for its subscriber endpoint, so a subscriber never sees
   * event N+1 before event N has either succeeded or been quarantined.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async retryFailedWebhooks(): Promise<void> {
    const pending = await this.logRepo.getPendingRetries(
      WEBHOOK_MAX_DELIVERY_ATTEMPTS,
    );
    const webhookPending = pending.filter((r) => r.channel === "webhook");

    await this.recordDeliveryMetrics(webhookPending.map((r) => r.publicKey));

    if (webhookPending.length === 0) return;

    this.logger.debug(`Retrying ${webhookPending.length} failed webhook(s)`);

    // Build the per-resource view the ordering policy needs. The delivery log is
    // keyed by (public key, channel, event), so a public key is used as the
    // resource id here; endpoints are isolated at the preference layer.
    const records: WebhookDeliveryRecord[] = webhookPending.map((entry) => ({
      resourceId: entry.publicKey,
      sequence: entry.sequence,
      status: "failed" as const,
      attempts: entry.attempts,
      lastFailedAt: entry.lastFailedAt,
    }));

    for (const entry of webhookPending) {
      const record: WebhookDeliveryRecord = {
        resourceId: entry.publicKey,
        sequence: entry.sequence,
        status: "failed",
        attempts: entry.attempts,
        lastFailedAt: entry.lastFailedAt,
      };

      if (!canAttemptDelivery(record, records)) {
        this.logger.debug(
          `Deferring retry out of order: ${entry.eventType}/${entry.eventId} ` +
            `seq=${entry.sequence} for ${entry.publicKey.slice(0, 8)}...`,
        );
        continue;
      }

      if (!isRetryDue(record)) continue;

      await this.attemptRedelivery(
        entry.publicKey,
        entry.eventType,
        entry.eventId,
        entry.attempts,
        entry.id,
      );
    }
  }

  /**
   * Manually redeliver a specific event (admin / consumer-triggered).
   * Returns true if delivery succeeded.
   */
  async redeliver(
    publicKey: string,
    eventId: string,
    eventType: string,
  ): Promise<boolean> {
    return this.attemptRedelivery(publicKey, eventType as never, eventId, 0);
  }

  /**
   * Attempt one redelivery of an event across every active endpoint of a wallet.
   *
   * Deduplication (issue #276): an event already recorded as `sent` is skipped
   * rather than POSTed again, so a replay storm or a duplicated scheduler tick
   * cannot produce a duplicate delivery.
   *
   * Quarantine: a permanent 4xx quarantines immediately without burning the
   * remaining attempts; a transient failure quarantines once the attempt budget
   * is spent. Quarantined entries stop being retried automatically and surface
   * through the dead-letter endpoints.
   */
  private async attemptRedelivery(
    publicKey: string,
    eventType: string,
    eventId: string,
    currentAttempts: number,
    deliveryLogId?: string,
  ): Promise<boolean> {
    const alreadyDelivered = await this.logRepo.isAlreadySent(
      publicKey,
      "webhook",
      eventType as never,
      eventId,
    );
    if (alreadyDelivered) {
      this.logger.debug(
        `Skipping duplicate redelivery: ${eventType}/${eventId} already sent`,
      );
      return true;
    }

    const webhooks = await this.prefsRepo.getWebhooksByPublicKey(publicKey);
    const active = webhooks.filter((w) => w.enabled && w.webhookUrl);

    if (active.length === 0) {
      this.logger.warn(
        `No active webhooks for ${publicKey.slice(0, 8)}... — skipping retry`,
      );
      return false;
    }

    const payload: BaseNotificationPayload = {
      eventType: eventType as never,
      eventId,
      recipientPublicKey: publicKey,
      title: `Redelivery: ${eventType}`,
      body: `Event ${eventId} redelivered`,
      occurredAt: new Date().toISOString(),
    };

    let anySuccess = false;

    for (const pref of active) {
      try {
        const result = await this.provider.send(pref, payload);
        await this.logRepo.markSent(
          publicKey,
          "webhook",
          eventType as never,
          eventId,
          result.messageId,
          result.httpStatus,
          result.responseBody,
        );
        this.logger.log(
          `Webhook redelivered: ${eventType}/${eventId} -> ${pref.webhookUrl} (attempt ${currentAttempts + 1})`,
        );
        anySuccess = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const httpStatus = extractHttpStatus(message);
        const permanent =
          httpStatus !== null && isPermanentHttpStatus(httpStatus);

        await this.logRepo.markFailed(
          publicKey,
          "webhook",
          eventType as never,
          eventId,
          message,
        );

        const { quarantine, reason } = resolveQuarantine(
          {
            resourceId: publicKey,
            sequence: currentAttempts + 1,
            status: "failed",
            attempts: currentAttempts + 1,
          },
          { permanent },
        );

        if (quarantine && deliveryLogId) {
          await this.logRepo.quarantine(
            deliveryLogId,
            reason ?? "ATTEMPTS_EXHAUSTED",
            message,
          );
        }

        if (quarantine) {
          this.logger.warn(
            `Webhook quarantined (${reason}): ${eventType}/${eventId} ` +
              `after ${currentAttempts + 1} attempt(s). Last error: ${message}`,
          );
        } else {
          this.logger.debug(
            `Webhook retry failed (attempt ${currentAttempts + 1}/${WEBHOOK_MAX_DELIVERY_ATTEMPTS}): ${message}`,
          );
        }
      }
    }

    return anySuccess;
  }

  /**
   * Publish delivery health gauges per affected public key:
   * webhook_delivery_success_rate (0-1) and webhook_dlq_size.
   */
  private async recordDeliveryMetrics(publicKeys: string[]): Promise<void> {
    if (!this.metrics) return;

    const keys = [...new Set(publicKeys)];
    if (keys.length === 0) return;

    for (const publicKey of keys) {
      try {
        const { sent, failed, dlq } =
          await this.logRepo.getWebhookDeliveryTotals(publicKey);
        const total = sent + failed;
        const rate = total > 0 ? sent / total : 0;
        this.metrics.setWebhookDeliverySuccessRate(publicKey, rate);
        this.metrics.setWebhookDlqSize(publicKey, dlq);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.debug(
          `Failed to record webhook delivery metrics for ${publicKey.slice(0, 8)}...: ${message}`,
        );
      }
    }
  }
}
