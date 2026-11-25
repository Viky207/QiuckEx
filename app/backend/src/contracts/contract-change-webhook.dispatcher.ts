import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomUUID } from 'crypto';

export const WEBHOOK_PAYLOAD_TOO_LARGE = 'WEBHOOK_PAYLOAD_TOO_LARGE';

/**
 * Default maximum serialized event body size in bytes (256 KiB).
 * Kept well below common provider limits to leave headroom for headers.
 */
export const DEFAULT_MAX_WEBHOOK_PAYLOAD_BYTES = 256 * 1024;

export interface WebhookDispatchResult {
  webhookId: string;
  url: string;
  success: boolean;
  httpStatus?: number;
  error?: string;
  /** Stable failure code, present when the event was rejected before delivery. */
  errorCode?: string;
}

@Injectable()
export class ContractChangeWebhookDispatcher {
  private readonly logger = new Logger(
    ContractChangeWebhookDispatcher.name,
  );

  private readonly maxPayloadBytes: number;

  constructor(maxPayloadBytes: number = DEFAULT_MAX_WEBHOOK_PAYLOAD_BYTES) {
    this.maxPayloadBytes =
      Number.isFinite(maxPayloadBytes) && maxPayloadBytes > 0
        ? maxPayloadBytes
        : DEFAULT_MAX_WEBHOOK_PAYLOAD_BYTES;
  }

  async dispatch(
    webhooks: { id: string; webhookUrl: string; secret: string }[],
    payload: Record<string, unknown>,
  ): Promise<WebhookDispatchResult[]> {
    const results: WebhookDispatchResult[] = [];

    if (!webhooks.length) return results;

    const body = JSON.stringify({
      id: randomUUID(),
      event: 'contract_registry.changed',
      occurredAt: new Date().toISOString(),
      payload,
    });

    const bodyBytes = Buffer.byteLength(body, 'utf8');
    if (bodyBytes > this.maxPayloadBytes) {
      // Reject before any delivery attempt so no partial send can occur.
      // Log only size metadata, never payload contents or signing material.
      this.logger.warn(
        `Rejected contract change webhook event: serialized size ${bodyBytes} bytes exceeds limit of ${this.maxPayloadBytes} bytes (${webhooks.length} endpoint(s) skipped)`,
      );

      return webhooks.map((webhook) => ({
        webhookId: webhook.id,
        url: webhook.webhookUrl,
        success: false,
        error: `Serialized event body of ${bodyBytes} bytes exceeds the maximum of ${this.maxPayloadBytes} bytes`,
        errorCode: WEBHOOK_PAYLOAD_TOO_LARGE,
      }));
    }

    await Promise.allSettled(
      webhooks.map(async (webhook) => {
        try {
          const signature = createHmac('sha256', webhook.secret)
            .update(body)
            .digest('hex');

          const response = await fetch(webhook.webhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-QuickEx-Signature': signature,
              'X-QuickEx-Event': 'contract_registry.changed',
            },
            body,
          });

          results.push({
            webhookId: webhook.id,
            url: webhook.webhookUrl,
            success: response.ok,
            httpStatus: response.status,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Unknown error';
          results.push({
            webhookId: webhook.id,
            url: webhook.webhookUrl,
            success: false,
            error: message,
          });
        }
      }),
    );

    const failures = results.filter((r) => !r.success);
    if (failures.length > 0) {
      this.logger.warn(
        `Failed to deliver contract change webhook to ${failures.length}/${results.length} endpoints`,
      );
    }

    return results;
  }
}
