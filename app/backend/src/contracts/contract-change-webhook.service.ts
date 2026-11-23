import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

interface AdminWebhookSubscription {
  id: string;
  webhookUrl: string;
  secret: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export const CONTRACT_CHANGE_WEBHOOK_MAX_PAYLOAD_BYTES = 64 * 1024;

export const CONTRACT_CHANGE_WEBHOOK_OVERSIZED_CODE =
  'CONTRACT_CHANGE_WEBHOOK_PAYLOAD_TOO_LARGE';

export interface ContractChangeWebhookEnqueueResult {
  ok: boolean;
  code?: typeof CONTRACT_CHANGE_WEBHOOK_OVERSIZED_CODE;
  sizeBytes?: number;
  maxBytes?: number;
}

@Injectable()
export class ContractChangeWebhookService {
  private readonly logger = new Logger(ContractChangeWebhookService.name);
  private readonly fallbackStore = new Map<string, AdminWebhookSubscription[]>();
  private readonly oversizedEventCounts = new Map<string, number>();

  constructor(private readonly supabaseService: SupabaseService) {}

  async registerWebhook(
    webhookUrl: string,
    secret?: string,
  ): Promise<AdminWebhookSubscription> {
    const id = `cwh_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();

    const subscription: AdminWebhookSubscription = {
      id,
      webhookUrl,
      secret: secret ?? this.generateSecret(),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    await this.persistSubscription(subscription);

    this.logger.log(`Registered contract change webhook: ${webhookUrl}`);
    return subscription;
  }

  async listWebhooks(): Promise<AdminWebhookSubscription[]> {
    try {
      const client = this.supabaseService.getClient();
      const { data, error } = await client
        .from('contract_change_webhooks')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (data ?? []).map((row) => this.mapRow(row));
    } catch (error) {
      this.logger.warn(
        `Falling back to in-memory webhook store: ${(error as Error).message}`,
      );
      return this.fallbackStore.get('contract-change-webhooks') ?? [];
    }
  }

  async deleteWebhook(id: string): Promise<boolean> {
    try {
      const client = this.supabaseService.getClient();
      const { error } = await client
        .from('contract_change_webhooks')
        .delete()
        .eq('id', id);

      if (error) throw error;
    } catch (error) {
      this.logger.warn(
        `Unable to delete webhook from store: ${(error as Error).message}`,
      );
    }

    const fallback = this.fallbackStore.get('contract-change-webhooks') ?? [];
    const exists = fallback.some((w) => w.id === id);
    this.fallbackStore.set(
      'contract-change-webhooks',
      fallback.filter((w) => w.id !== id),
    );
    return exists;
  }

  async getEnabledWebhooks(): Promise<AdminWebhookSubscription[]> {
    try {
      const client = this.supabaseService.getClient();
      const { data, error } = await client
        .from('contract_change_webhooks')
        .select('*')
        .eq('enabled', true);

      if (error) throw error;
      return (data ?? []).map((row) => this.mapRow(row));
    } catch (error) {
      this.logger.warn(
        `Unable to fetch enabled webhooks: ${(error as Error).message}`,
      );
      return (this.fallbackStore.get('contract-change-webhooks') ?? []).filter(
        (w) => w.enabled,
      );
    }
  }

  /**
   * Validates the serialized size of a contract change event before it is
   * enqueued for delivery. Oversized events are rejected as a whole (never
   * partially sent) and the failure is recorded so it stays observable.
   * Payload contents are never logged.
   */
  enqueueContractChangeEvent(
    webhookId: string,
    event: Record<string, unknown>,
    maxBytes: number = CONTRACT_CHANGE_WEBHOOK_MAX_PAYLOAD_BYTES,
  ): ContractChangeWebhookEnqueueResult {
    let serialized: string;
    try {
      serialized = JSON.stringify(event);
    } catch (error) {
      this.logger.warn(
        `Unable to serialize contract change event for webhook ${webhookId}: ${(error as Error).message}`,
      );
      return { ok: false };
    }

    const sizeBytes = Buffer.byteLength(serialized, 'utf8');
    if (sizeBytes > maxBytes) {
      const previous = this.oversizedEventCounts.get(webhookId) ?? 0;
      this.oversizedEventCounts.set(webhookId, previous + 1);
      this.logger.warn(
        `Rejected oversized contract change event for webhook ${webhookId}: ` +
          `${sizeBytes} bytes exceeds limit of ${maxBytes} bytes ` +
          `(code=${CONTRACT_CHANGE_WEBHOOK_OVERSIZED_CODE})`,
      );
      return {
        ok: false,
        code: CONTRACT_CHANGE_WEBHOOK_OVERSIZED_CODE,
        sizeBytes,
        maxBytes,
      };
    }

    return { ok: true, sizeBytes, maxBytes };
  }

  getOversizedEventCount(webhookId: string): number {
    return this.oversizedEventCounts.get(webhookId) ?? 0;
  }

  private async persistSubscription(
    subscription: AdminWebhookSubscription,
  ): Promise<void> {
    try {
      const client = this.supabaseService.getClient();
      const { error } = await client
        .from('contract_change_webhooks')
        .upsert(
          {
            id: subscription.id,
            webhook_url: subscription.webhookUrl,
            secret: subscription.secret,
            enabled: subscription.enabled,
            created_at: subscription.createdAt,
            updated_at: subscription.updatedAt,
          },
          { onConflict: 'id' },
        );

      if (error) throw error;
    } catch (error) {
      this.logger.warn(
        `Unable to persist webhook subscription: ${(error as Error).message}`,
      );
      const fallback = this.fallbackStore.get('contract-change-webhooks') ?? [];
      fallback.push(subscription);
      this.fallbackStore.set('contract-change-webhooks', fallback);
    }
  }

  private generateSecret(): string {
    return `cwhsec_${Math.random().toString(36).slice(2, 15)}`;
  }

  private mapRow(row: Record<string, unknown>): AdminWebhookSubscription {
    return {
      id: String(row.id),
      webhookUrl: String(row.webhook_url),
      secret: String(row.secret ?? ''),
      enabled: Boolean(row.enabled),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
