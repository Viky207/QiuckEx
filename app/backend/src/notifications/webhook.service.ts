import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import * as crypto from "crypto";

import { NotificationPreferencesRepository } from "./notification-preferences.repository";
import { NotificationLogRepository } from "./notification-log.repository";
import { WebhookReplayService } from "./webhook-replay.service";
import {
  getEventVersionDescriptor,
  normalizeApiVersion,
  LATEST_WEBHOOK_API_VERSION,
  type WebhookEventVersionDescriptor,
} from "./webhook-event-versions";
import { WEBHOOK_SECRET_ROTATION_GRACE_MS } from "./webhook-retry.constants";
import type { NotificationPreference } from "./types/notification.types";

/**
 * Event types covered by the version registry. Used when a webhook subscribes
 * to all events, so the discovery endpoint can describe every event it may
 * receive without the registry having to be queried twice.
 */
const ALL_VERSIONED_EVENT_TYPES = [
  "payment.received",
  "EscrowDeposited",
  "EscrowWithdrawn",
  "EscrowRefunded",
  "username.claimed",
  "payment.link.expired",
] as const;
import type {
  CreateWebhookDto,
  UpdateWebhookDto,
  WebhookResponseDto,
  WebhookDeliveryLogDto,
  WebhookStatsDto,
  WebhookDeliveryStatusDto,
  WebhookReplayLogDto,
  WebhookRedeliverResponseDto,
} from "./dto/webhook.dto";

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prefsRepo: NotificationPreferencesRepository,
    private readonly logRepo: NotificationLogRepository,
    private readonly replayService: WebhookReplayService,
  ) {}

  async createWebhook(
    publicKey: string,
    dto: CreateWebhookDto,
  ): Promise<WebhookResponseDto> {
    const secret = dto.secret ?? this.generateSecret();

    const preference = await this.prefsRepo.upsertPreference(
      publicKey,
      "webhook",
      {
        webhookUrl: dto.webhookUrl,
        webhookSecret: secret,
        // Pin the subscriber to a known-good API version (issue #275). Unknown
        // values normalize to the default rather than being rejected, so an
        // integrator sending a version from a newer QuickEx still registers.
        apiVersion: normalizeApiVersion(dto.apiVersion),
        events: dto.events ?? null,
        minAmountStroops: dto.minAmountStroops
          ? BigInt(dto.minAmountStroops)
          : 0n,
        enabled: true,
      },
    );

    return this.toResponse(preference);
  }

  async listWebhooks(
    publicKey: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ data: WebhookResponseDto[]; next_cursor: string | null; has_more: boolean }> {
    const preferences = await this.prefsRepo.getWebhooksByPublicKeyPaginated(publicKey, cursor, limit);
    return {
      data: preferences.data.map((p) => this.toResponse(p)),
      next_cursor: preferences.next_cursor,
      has_more: preferences.has_more,
    };
  }

  async getWebhook(id: string): Promise<WebhookResponseDto | null> {
    const preference = await this.prefsRepo.getWebhookById(id);
    if (!preference) return null;
    return this.toResponse(preference);
  }

  async updateWebhook(
    id: string,
    publicKey: string,
    dto: UpdateWebhookDto,
  ): Promise<WebhookResponseDto | null> {
    const existing = await this.prefsRepo.getWebhookById(id);
    if (!existing || existing.publicKey !== publicKey) {
      return null;
    }

    const updated = await this.prefsRepo.upsertPreference(
      publicKey,
      "webhook",
      {
        webhookUrl: dto.webhookUrl ?? existing.webhookUrl,
        webhookSecret: existing.webhookSecret,
        // An omitted apiVersion keeps the current pin: re-registering a webhook
        // must not silently move a subscriber onto a different schema version.
        apiVersion: normalizeApiVersion(dto.apiVersion ?? existing.apiVersion),
        events: dto.events ?? existing.events,
        minAmountStroops:
          dto.minAmountStroops !== undefined
            ? BigInt(dto.minAmountStroops)
            : existing.minAmountStroops,
        enabled: dto.enabled ?? existing.enabled,
      },
    );

    return this.toResponse(updated);
  }

  async deleteWebhook(id: string, publicKey: string): Promise<boolean> {
    const existing = await this.prefsRepo.getWebhookById(id);
    if (!existing || existing.publicKey !== publicKey) {
      return false;
    }

    await this.prefsRepo.deleteWebhook(id);
    return true;
  }

  /**
   * Rotate a webhook's signing secret (issue #277).
   *
   * The new secret signs every subsequent delivery. The previous secret is kept
   * for a bounded overlap window so a subscriber that has not yet redeployed
   * does not reject in-flight deliveries; the caller is told when the overlap
   * ends. Pass `overlapMs: 0` for an immediate rotation with no overlap.
   *
   * Returns `null` when the webhook does not exist or belongs to another
   * public key, so the controller can answer 404 without leaking existence.
   */
  async regenerateSecret(
    id: string,
    publicKey: string,
    overlapMs: number = WEBHOOK_SECRET_ROTATION_GRACE_MS,
  ): Promise<{ secret: string; previousSecretExpiresAt?: string } | null> {
    const existing = await this.prefsRepo.getWebhookById(id);
    if (!existing || existing.publicKey !== publicKey) {
      return null;
    }

    const newSecret = this.generateSecret();
    const rotated = await this.prefsRepo.regenerateWebhookSecret(id, newSecret, {
      currentSecret: existing.webhookSecret,
      overlapMs,
    });

    this.logger.log(
      `Rotated webhook secret for ${publicKey.slice(0, 8)}... webhook=${id} ` +
        `overlapMs=${overlapMs} previousRetained=${Boolean(rotated.previousWebhookSecret)}`,
    );

    return {
      secret: newSecret,
      previousSecretExpiresAt: rotated.previousSecretExpiresAt,
    };
  }

  async getDeliveryLogs(
    publicKey: string,
    limit?: number,
    cursor?: string,
  ): Promise<{ data: WebhookDeliveryLogDto[]; next_cursor: string | null; has_more: boolean }> {
    const result = await this.logRepo.getWebhookDeliveryLogsPaginated(publicKey, limit, cursor);
    return {
      data: result.data.map((log) => ({
        id: log.id,
        eventType: log.eventType,
        eventId: log.eventId,
        status: log.status,
        attempts: log.attempts,
        lastError: log.lastError,
        httpStatus: log.httpStatus,
        responseBody: log.responseBody,
        createdAt: log.createdAt,
        deliveredAt: log.deliveredAt,
      })),
      next_cursor: result.next_cursor,
      has_more: result.has_more,
    };
  }

  async getStats(publicKey: string): Promise<WebhookStatsDto> {
    const stats = await this.logRepo.getWebhookStats(publicKey);
    return {
      totalSent: stats.totalSent,
      totalFailed: stats.totalFailed,
      pendingRetries: stats.pendingRetries,
      lastDeliveryAt: stats.lastDeliveryAt,
      lastError: stats.lastError,
    };
  }

  /**
   * List deliveries parked in the dead-letter queue for a webhook's public key.
   * Callers are expected to scope-check the webhook ID against the public key.
   */
  async getDeadLetter(
    publicKey: string,
    limit?: number,
  ): Promise<WebhookDeliveryLogDto[]> {
    const entries = await this.logRepo.getWebhookDlqEntries(
      publicKey,
      limit ? Number(limit) : 50,
    );
    return entries.map((entry) => ({
      id: entry.id,
      eventType: entry.eventType,
      eventId: entry.eventId,
      status: "dlq",
      attempts: entry.attempts,
      lastError: entry.lastError,
      httpStatus: entry.httpStatus,
      responseBody: entry.responseBody,
      createdAt: entry.createdAt,
      deliveredAt: entry.updatedAt,
    }));
  }

  /**
   * Trigger immediate redelivery of a specific event via the replay service.
   */
  async redeliverEvent(
    publicKey: string,
    webhookId: string,
    eventId: string,
    eventType: string,
  ): Promise<WebhookRedeliverResponseDto> {
    return this.replayService.replayDelivery(
      publicKey,
      webhookId,
      eventId,
      eventType,
    );
  }

  async getDeliveryStatus(
    publicKey: string,
    eventId: string,
    eventType: string,
  ): Promise<WebhookDeliveryStatusDto> {
    return this.replayService.getDeliveryStatus(publicKey, eventId, eventType);
  }

  async getReplayHistory(
    webhookId: string,
    limit?: number,
  ): Promise<WebhookReplayLogDto[]> {
    return this.replayService.listReplayHistory(webhookId, limit);
  }

  /**
   * Version and migration metadata for the events a webhook subscribes to
   * (issue #275).
   *
   * When the webhook subscribes to all events (`events === null`) the full
   * registry is returned; otherwise only the subscribed types are. The response
   * contains no secrets, so it is safe to expose to the owning tenant.
   */
  async getEventVersionMetadata(
    webhookId: string,
    publicKey: string,
  ): Promise<{
    webhookId: string;
    apiVersion: string;
    latestApiVersion: string;
    events: WebhookEventVersionDescriptor[];
  }> {
    const preference = await this.prefsRepo.getWebhookById(webhookId);
    if (!preference || preference.publicKey !== publicKey) {
      throw new NotFoundException("Webhook not found");
    }

    const subscribed = preference.events;
    const events = (subscribed ?? ALL_VERSIONED_EVENT_TYPES).map(
      (eventType) => getEventVersionDescriptor(eventType),
    );

    return {
      webhookId,
      apiVersion: normalizeApiVersion(preference.apiVersion),
      latestApiVersion: LATEST_WEBHOOK_API_VERSION,
      events,
    };
  }

  private generateSecret(): string {
    const bytes = crypto.randomBytes(32);
    return `whsec_${bytes.toString("hex")}`;
  }

  private toResponse(preference: NotificationPreference): WebhookResponseDto {
    return {
      id: preference.id,
      publicKey: preference.publicKey,
      webhookUrl: preference.webhookUrl ?? "",
      secret: preference.webhookSecret ?? "",
      apiVersion: normalizeApiVersion(preference.apiVersion),
      events: preference.events,
      minAmountStroops: preference.minAmountStroops.toString(),
      enabled: preference.enabled,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}
