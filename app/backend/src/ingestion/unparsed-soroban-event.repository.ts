import { Injectable, Logger } from "@nestjs/common";

import { SupabaseService } from "../supabase/supabase.service";
import type { RawHorizonContractEvent } from "./soroban-event.parser";

export type UnparsedSorobanEventReason =
  | "unknown_schema_version"
  | "parse_failure";

export type UnparsedSorobanEventStatus = "pending" | "replayed" | "dead_letter";

const MAX_REPLAY_ATTEMPTS = 5;

/**
 * Idempotency key used to guarantee that replaying an unparsed event never
 * produces duplicate downstream effects. The key is derived from the event's
 * paging token, which is unique per ledger event on Horizon.
 */
export function buildReplayIdempotencyKey(pagingToken: string): string {
  return `unparsed-replay:${pagingToken}`;
}

export interface ReplayUnparsedEventResult {
  pagingToken: string;
  idempotencyKey: string;
  replayed: boolean;
  alreadyReplayed: boolean;
  status: UnparsedSorobanEventStatus;
}

export interface SaveUnparsedSorobanEventInput {
  raw: RawHorizonContractEvent;
  reason: UnparsedSorobanEventReason;
  eventName?: string | null;
  schemaVersion?: number | null;
  errorMessage?: string | null;
}

export interface UnparsedSorobanEventRecord
  extends SaveUnparsedSorobanEventInput {
  pagingToken: string;
  contractId: string;
  ledger: number;
  transactionHash: string;
  attempts: number;
  status: UnparsedSorobanEventStatus;
}

@Injectable()
export class UnparsedSorobanEventRepository {
  private readonly logger = new Logger(UnparsedSorobanEventRepository.name);

  constructor(private readonly supabase: SupabaseService) {}

  async save(input: SaveUnparsedSorobanEventInput): Promise<void> {
    const row = {
      paging_token: input.raw.paging_token,
      contract_id: input.raw.contract_id,
      ledger: input.raw.ledger,
      transaction_hash: input.raw.transaction_hash,
      event_name: input.eventName ?? null,
      schema_version: input.schemaVersion ?? null,
      reason: input.reason,
      raw_topics: input.raw.topic,
      raw_payload: input.raw.value,
      raw_event: input.raw,
      error_message: input.errorMessage ?? null,
      status: "pending",
      updated_at: new Date().toISOString(),
    };

    const { error } = await this.supabase
      .getClient()
      .from("unparsed_soroban_events")
      .upsert(row, { onConflict: "paging_token" });

    if (error) {
      this.logger.error(
        `Failed to persist unparsed Soroban event ${input.raw.paging_token}: ${error.message}`,
      );
      throw error;
    }
  }

  async listPending(
    limit = 100,
    filters?: {
      contractId?: string;
      schemaVersion?: number;
      errorType?: UnparsedSorobanEventReason;
    },
  ): Promise<UnparsedSorobanEventRecord[]> {
    let query = this.supabase
      .getClient()
      .from("unparsed_soroban_events")
      .select("*")
      .eq("status", "pending")
      .order("ledger", { ascending: true })
      .limit(limit);

    if (filters?.contractId) {
      query = query.eq("contract_id", filters.contractId);
    }
    if (filters?.schemaVersion !== undefined) {
      query = query.eq("schema_version", filters.schemaVersion);
    }
    if (filters?.errorType) {
      query = query.eq("reason", filters.errorType);
    }

    const { data, error } = await query;

    if (error) {
      this.logger.error(`Failed to list unparsed Soroban events: ${error.message}`);
      throw error;
    }

    return (data ?? []).map((row: Record<string, unknown>) => ({
      raw: row.raw_event as RawHorizonContractEvent,
      reason: row.reason as UnparsedSorobanEventReason,
      eventName: (row.event_name as string | null) ?? null,
      schemaVersion:
        row.schema_version === null || row.schema_version === undefined
          ? null
          : Number(row.schema_version),
      errorMessage: (row.error_message as string | null) ?? null,
      pagingToken: String(row.paging_token),
      contractId: String(row.contract_id),
      ledger: Number(row.ledger),
      transactionHash: String(row.transaction_hash),
      attempts: Number(row.attempts ?? 0),
      status: row.status as UnparsedSorobanEventStatus,
    }));
  }

  async listDeadLetter(limit = 100): Promise<UnparsedSorobanEventRecord[]> {
    const { data, error } = await this.supabase
      .getClient()
      .from("unparsed_soroban_events")
      .select("*")
      .eq("status", "dead_letter")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) {
      this.logger.error(`Failed to list dead-letter Soroban events: ${error.message}`);
      throw error;
    }

    return (data ?? []).map((row: Record<string, unknown>) => ({
      raw: row.raw_event as RawHorizonContractEvent,
      reason: row.reason as UnparsedSorobanEventReason,
      eventName: (row.event_name as string | null) ?? null,
      schemaVersion: row.schema_version == null ? null : Number(row.schema_version),
      errorMessage: (row.error_message as string | null) ?? null,
      pagingToken: String(row.paging_token),
      contractId: String(row.contract_id),
      ledger: Number(row.ledger),
      transactionHash: String(row.transaction_hash),
      attempts: Number(row.attempts ?? 0),
      status: row.status as UnparsedSorobanEventStatus,
    }));
  }

  async markReplayed(pagingToken: string): Promise<void> {
    await this.updateStatus(pagingToken, "replayed");
  }

  /**
   * Replays a single unparsed event exactly once.
   *
   * The replay is guarded by an idempotency key so that repeated calls (e.g.
   * an operator retrying after a timeout, or two operators acting at once)
   * never duplicate downstream effects. If the event has already been
   * replayed, the call is a no-op and reports `alreadyReplayed: true`.
   */
  async replay(
    pagingToken: string,
    replayFn: (record: UnparsedSorobanEventRecord) => Promise<void>,
  ): Promise<ReplayUnparsedEventResult> {
    const idempotencyKey = buildReplayIdempotencyKey(pagingToken);
    const record = await this.getByPagingToken(pagingToken);

    if (!record) {
      throw new Error(`Unparsed Soroban event ${pagingToken} not found`);
    }

    if (record.status === "replayed") {
      return {
        pagingToken,
        idempotencyKey,
        replayed: false,
        alreadyReplayed: true,
        status: record.status,
      };
    }

    // Atomically claim the event for replay. The conditional update only
    // succeeds when the row is still in a replayable state, so concurrent
    // callers cannot both proceed past this point.
    const { data: claimed, error: claimError } = await this.supabase
      .getClient()
      .from("unparsed_soroban_events")
      .update({
        status: "replayed",
        replay_idempotency_key: idempotencyKey,
        replayed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("paging_token", pagingToken)
      .in("status", ["pending", "dead_letter"])
      .select("paging_token");

    if (claimError) {
      this.logger.error(
        `Failed to claim unparsed Soroban event ${pagingToken} for replay: ${claimError.message}`,
      );
      throw claimError;
    }

    if (!claimed || claimed.length === 0) {
      // Another caller won the race; treat as already replayed.
      return {
        pagingToken,
        idempotencyKey,
        replayed: false,
        alreadyReplayed: true,
        status: "replayed",
      };
    }

    try {
      await replayFn(record);
    } catch (err) {
      // Roll the claim back so the event can be retried, and record the
      // failure through the existing attempt-tracking path.
      await this.supabase
        .getClient()
        .from("unparsed_soroban_events")
        .update({
          status: record.status,
          replay_idempotency_key: null,
          replayed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("paging_token", pagingToken);

      const message = err instanceof Error ? err.message : String(err);
      await this.markFailed(pagingToken, message);
      throw err;
    }

    return {
      pagingToken,
      idempotencyKey,
      replayed: true,
      alreadyReplayed: false,
      status: "replayed",
    };
  }

  /**
   * Replays a batch of dead-letter events. Each event is replayed through
   * {@link replay}, so idempotency guarantees hold per event.
   */
  async replayDeadLetter(
    pagingTokens: string[],
    replayFn: (record: UnparsedSorobanEventRecord) => Promise<void>,
  ): Promise<ReplayUnparsedEventResult[]> {
    const results: ReplayUnparsedEventResult[] = [];
    for (const token of pagingTokens) {
      results.push(await this.replay(token, replayFn));
    }
    return results;
  }

  async archiveReplayedBefore(cutoff: Date, batchSize = 1000): Promise<number> {
    const { data, error } = await this.supabase
      .getClient()
      .rpc('archive_replayed_soroban_events', {
        p_cutoff: cutoff.toISOString(),
        p_batch_size: batchSize,
      });

    if (error) {
      this.logger.error(`Failed to archive replayed Soroban events: ${error.message}`);
      throw error;
    }
    return Number(data ?? 0);
  }

  private async incrementAttempts(pagingToken: string): Promise<number> {
    const current = await this.getByPagingToken(pagingToken);
    if (!current) return 0;
    const newAttempts = current.attempts + 1;
    await this.supabase
      .getClient()
      .from("unparsed_soroban_events")
      .update({ attempts: newAttempts })
      .eq("paging_token", pagingToken);
    return newAttempts;
  }

  async markFailed(pagingToken: string, errorMessage: string): Promise<void> {
    const { error } = await this.supabase.getClient().rpc(
      "record_unparsed_soroban_replay_failure",
      {
        p_paging_token: pagingToken,
        p_error_message: errorMessage,
        p_max_attempts: MAX_REPLAY_ATTEMPTS,
      },
    );

    if (error) throw error;
  }

  async getByPagingToken(pagingToken: string): Promise<UnparsedSorobanEventRecord | null> {
    const { data, error } = await this.supabase
      .getClient()
      .from("unparsed_soroban_events")
      .select("*")
      .eq("paging_token", pagingToken)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null; // No rows returned
      this.logger.error(`Failed to get unparsed event: ${error.message}`);
      throw error;
    }

    return {
      raw: data.raw_event as RawHorizonContractEvent,
      reason: data.reason as UnparsedSorobanEventReason,
      eventName: (data.event_name as string | null) ?? null,
      schemaVersion:
        data.schema_version === null || data.schema_version === undefined
          ? null
          : Number(data.schema_version),
      errorMessage: (data.error_message as string | null) ?? null,
      pagingToken: String(data.paging_token),
      contractId: String(data.contract_id),
      ledger: Number(data.ledger),
      transactionHash: String(data.transaction_hash),
      attempts: Number(data.attempts ?? 0),
      status: data.status as UnparsedSorobanEventStatus,
    };
  }

  private async updateStatus(pagingToken: string, status: string): Promise<void> {
    await this.incrementAttempts(pagingToken);
    const { error } = await this.supabase
      .getClient()
      .from("unparsed_soroban_events")
      .update({ 
        status,
        updated_at: new Date().toISOString() 
      })
      .eq("paging_token", pagingToken);

    if (error) throw error;
  }
}