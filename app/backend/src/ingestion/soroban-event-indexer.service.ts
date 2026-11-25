import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";

import { AppConfigService } from "../config";
import { HORIZON_BASE_URLS } from "../config/stellar.config";
import { MetricsService } from "../metrics/metrics.service";
import { SorobanEventParser, RawHorizonContractEvent } from "./soroban-event.parser";
import { IndexerCheckpointRepository } from "./indexer-checkpoint.repository";
import { EscrowEventRepository } from "./escrow-event.repository";
import { PrivacyEventRepository } from "./privacy-event.repository";
import { AdminEventRepository } from "./admin-event.repository";
import { StealthEventRepository } from "./stealth-event.repository";
import { UnparsedSorobanEventRepository, UnparsedSorobanEventReason, UnparsedSorobanEventRecord } from "./unparsed-soroban-event.repository";
import type {
  QuickExContractEvent,
  EscrowEvent,
  AdminEvent,
  StealthEvent,
} from "./types/contract-event.types";

/** Number of events fetched per Horizon page. */
const PAGE_LIMIT = 200;

export interface LedgerRangeResult {
  fromLedger: number;
  toLedger: number;
  processed: number;
  persisted: number;
  skippedUnknownSchema: number;
  parseFailures: number;
}

export interface ReplayUnparsedResult {
  attempted: number;
  replayed: number;
  stillUnparsed: number;
}

export interface DualReadConfig {
  previousContractId?: string;
  effectiveLedger?: number;
  effectiveTime?: Date;
}

/**
 * Polls Soroban contract events by ledger range from Horizon's REST API.
 *
 * Responsibilities:
 *  - Fetch events page-by-page for a given [fromLedger, toLedger] range.
 *  - Parse each event with schema-version awareness.
 *  - Persist all event domains idempotently (escrow, privacy, admin, stealth).
 *  - Advance the durable checkpoint after each page so a crash is recoverable.
 *  - Emit domain events for downstream consumers.
 *
 * Reconciliation / reindex: calling `indexLedgerRange` with `force=true` skips
 * the checkpoint read and re-processes the full range. Idempotent upserts ensure
 * no duplicates are created.
 */
@Injectable()
export class SorobanEventIndexerService {
  private readonly logger = new Logger(SorobanEventIndexerService.name);
  private readonly horizonUrl: string;

  constructor(
    private readonly config: AppConfigService,
    private readonly checkpointRepo: IndexerCheckpointRepository,
    private readonly escrowRepo: EscrowEventRepository,
    private readonly privacyRepo: PrivacyEventRepository,
    private readonly adminRepo: AdminEventRepository,
    private readonly stealthRepo: StealthEventRepository,
    private readonly unparsedRepo: UnparsedSorobanEventRepository,
    private readonly metrics: MetricsService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.horizonUrl = HORIZON_BASE_URLS[this.config.network];

    // Wire the parser's unknown-schema-version callback to metrics.
    this.parser = new SorobanEventParser((eventName, version, pagingToken) => {
      this.logger.warn(
        `Unknown schema_version=${version} for event ${eventName} paging_token=${pagingToken}`,
      );
      this.metrics.recordUnknownSchemaVersion(eventName, version);
    });
  }

  private readonly parser: SorobanEventParser;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Index all contract events in [fromLedger, toLedger] with dual-read support.
   *
   * @param contractId      Soroban contract address (current).
   * @param fromLedger      Inclusive start ledger.
   * @param toLedger        Inclusive end ledger.
   * @param dualReadConfig  Optional dual-read configuration for transition windows.
   * @param force           When true, ignore the stored checkpoint and reindex the
   *                        full range (reconciliation mode). Idempotency prevents
   *                        duplicate records.
   */
  async indexLedgerRange(
    contractId: string,
    fromLedger: number,
    toLedger: number,
    dualReadConfig?: DualReadConfig,
    force = false,
  ): Promise<LedgerRangeResult> {
    const checkpoint = force
      ? null
      : await this.checkpointRepo.getCheckpoint(contractId);
    const effectiveFrom = this.resolveStartLedger(fromLedger, checkpoint);
    const resumeCursor = checkpoint && checkpoint.lastLedger >= fromLedger
      ? checkpoint.pagingToken ?? undefined
      : undefined;

    if (effectiveFrom > toLedger) {
      this.logger.log(
        `Contract ${contractId}: ledger range [${effectiveFrom}, ${toLedger}] already indexed; skipping.`,
      );
      return { fromLedger, toLedger, processed: 0, persisted: 0, skippedUnknownSchema: 0, parseFailures: 0 };
    }

    const inDualReadWindow = this.isInDualReadWindow(effectiveFrom, dualReadConfig);
    const logSuffix = inDualReadWindow ? " (dual-read mode)" : "";

    this.logger.log(
      `Indexing contract ${contractId} ledgers [${effectiveFrom}, ${toLedger}]${force ? " (force reindex)" : ""}${logSuffix}`,
    );

    let processed = 0;
    let persisted = 0;
    let skippedUnknownSchema = 0;
    let parseFailures = 0;

    // In dual-read mode, index both current and previous contract IDs
    if (inDualReadWindow && dualReadConfig?.previousContractId) {
      const previousResult = await this.indexContractWithCursor(
        dualReadConfig.previousContractId,
        effectiveFrom,
        dualReadConfig.effectiveLedger ?? toLedger,
        undefined,
      );
      processed += previousResult.processed;
      persisted += previousResult.persisted;
      skippedUnknownSchema += previousResult.skippedUnknownSchema;
      parseFailures += previousResult.parseFailures;
    }

    // Always index the current contract ID
    const currentResult = await this.indexContractWithCursor(
      contractId,
      effectiveFrom,
      toLedger,
      resumeCursor,
    );
    processed += currentResult.processed;
    persisted += currentResult.persisted;
    skippedUnknownSchema += currentResult.skippedUnknownSchema;
    parseFailures += currentResult.parseFailures;

    this.logger.log(
      `Indexed contract ${contractId} [${effectiveFrom}, ${toLedger}]: ` +
        `processed=${processed} persisted=${persisted} skippedUnknownSchema=${skippedUnknownSchema} parseFailures=${parseFailures}`,
    );

    return { fromLedger: effectiveFrom, toLedger, processed, persisted, skippedUnknownSchema, parseFailures };
  }

  private async indexContractWithCursor(
    contractId: string,
    fromLedger: number,
    toLedger: number,
    cursor: string | undefined,
  ): Promise<{ processed: number; persisted: number; skippedUnknownSchema: number; parseFailures: number }> {
    let processed = 0;
    let persisted = 0;
    let skippedUnknownSchema = 0;
    let parseFailures = 0;
    let nextCursor = cursor;
    let previousLedger: number | null = null;
    const seenPagingTokens = new Set<string>();

    while (true) {
      const { records, nextCursor: returnedCursor } = await this.fetchPage(
        contractId,
        fromLedger,
        toLedger,
        nextCursor,
      );

      if (records.length === 0) break;

      for (const raw of records) {
        if (previousLedger !== null && raw.ledger < previousLedger) {
          await this.recordAnomaly(contractId, "reorg", raw, previousLedger);
        }
        if (seenPagingTokens.has(raw.paging_token)) {
          await this.recordAnomaly(contractId, "duplicate", raw, previousLedger);
        }
        seenPagingTokens.add(raw.paging_token);
        previousLedger = raw.ledger;
      }

      for (const raw of records) {
        processed++;
        const event = this.parser.parse(raw);

        if (!event) {
          const outcome = await this.captureUnparsedEvent(raw);
          if (outcome === "parse_failure") {
            parseFailures++;
          } else {
            skippedUnknownSchema++;
          }
          continue;
        }

        const inserted = await this.persistEvent(event, contractId);
        if (inserted) {
          persisted++;
          this.eventEmitter.emit(`stellar.${event.eventType}`, event);
        }
      }

      // Advance checkpoint after each page
      const lastRecord = records[records.length - 1];
      if (lastRecord) {
        await this.checkpointRepo.saveCheckpoint(
          contractId,
          lastRecord.ledger,
          lastRecord.paging_token,
        );
      }

      if (!returnedCursor || records.length < PAGE_LIMIT) break;
      nextCursor = returnedCursor;
    }

    if (previousLedger !== null) {
      await this.checkpointRepo.saveLastLedger(contractId, previousLedger);
    }

    return { processed, persisted, skippedUnknownSchema, parseFailures };
  }

  private isInDualReadWindow(currentLedger: number, config?: DualReadConfig): boolean {
    if (!config?.previousContractId || !config?.effectiveLedger) {
      return false;
    }
    return currentLedger < config.effectiveLedger;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * A paging token resumes within a partially processed ledger; older checkpoints
   * without one continue from the next ledger.
   */
  private resolveStartLedger(
    fromLedger: number,
    checkpoint: { lastLedger: number; pagingToken: string | null } | null,
  ): number {
    if (checkpoint && checkpoint.lastLedger >= fromLedger) {
      return checkpoint.pagingToken ? checkpoint.lastLedger : checkpoint.lastLedger + 1;
    }
    return fromLedger;
  }

  /**
   * Fetches one page of contract events from Horizon for the given ledger range.
   * Uses the `start_ledger` + `end_ledger` query params (Horizon v2 API).
   */
  private async fetchPage(
    contractId: string,
    fromLedger: number,
    toLedger: number,
    cursor?: string,
  ): Promise<{ records: RawHorizonContractEvent[]; nextCursor: string | undefined }> {
    const url = new URL(`${this.horizonUrl}/contract_events`);
    url.searchParams.set("contract_id", contractId);
    url.searchParams.set("start_ledger", String(fromLedger));
    url.searchParams.set("end_ledger", String(toLedger));
    url.searchParams.set("limit", String(PAGE_LIMIT));
    url.searchParams.set("order", "asc");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      throw new Error(`Horizon returned ${res.status} for ${url.toString()}`);
    }

    // Horizon HAL response: { _embedded: { records: [...] }, _links: { next: { href } } }
    const body = (await res.json()) as {
      _embedded?: { records?: RawHorizonContractEvent[] };
      _links?: { next?: { href?: string } };
    };

    const records = body._embedded?.records ?? [];
    const nextHref = body._links?.next?.href;
    const nextCursor = nextHref
      ? new URL(nextHref).searchParams.get("cursor") ?? undefined
      : undefined;

    return { records, nextCursor };
  }

  private async persistEvent(
    event: QuickExContractEvent,
    contractId?: string,
  ): Promise<boolean> {
    switch (event.eventType) {
      case "EscrowDeposited":
      case "EscrowWithdrawn":
      case "EscrowRefunded":
        return this.persistEscrowEvent(event as EscrowEvent, contractId);
      case "PrivacyToggled":
        return this.privacyRepo.upsertEvent(event);
      case "ContractPaused":
      case "AdminChanged":
      case "ContractUpgraded":
        return this.adminRepo.upsertEvent(event as AdminEvent);
      case "EphemeralKeyRegistered":
      case "StealthWithdrawn":
        return this.stealthRepo.upsertEvent(event as StealthEvent);
      default:
        this.logger.debug(`Event ${(event as QuickExContractEvent).eventType} not persisted.`);
        return false;
    }
  }

  /**
   * Persists an escrow event through the guarded (monotonic) upsert path.
   *
   * A late or duplicated event that would regress a receipt to an earlier
   * status is rejected by the repository; the conflict evidence is retained
   * and the canonical state is left untouched. Duplicate events are no-ops.
   */
  private async persistEscrowEvent(
    event: EscrowEvent,
    contractId?: string,
  ): Promise<boolean> {
    const repository = this.escrowRepo as EscrowEventRepository & {
      upsertEventGuarded?: (
        event: EscrowEvent,
      ) => Promise<{ inserted: boolean; conflict?: boolean; reason?: string }>;
    };

    if (!repository.upsertEventGuarded) {
      return this.escrowRepo.upsertEvent(event);
    }

    const result = await repository.upsertEventGuarded(event);
    if (result.conflict) {
      this.logger.warn(
        `Rejected regressive escrow event ${event.eventType} ` +
          `paging_token=${event.pagingToken ?? "unknown"}` +
          `${contractId ? ` contract=${contractId}` : ""}: ${result.reason ?? "status regression"}`,
      );
      await this.recordAnomaly(
        contractId ?? event.contractId ?? "unknown",
        "out_of_order",
        undefined,
        undefined,
        {
          eventType: event.eventType,
          pagingToken: event.pagingToken ?? null,
          reason: result.reason ?? "status regression",
        },
      );
    }
    return result.inserted;
  }

  async listUnparsedEvents(
    limit = 100,
    filters?: {
      contractId?: string;
      schemaVersion?: number;
      errorType?: UnparsedSorobanEventReason;
    },
  ) {
    return this.unparsedRepo.listPending(limit, filters);
  }

  async listDeadLetterEvents(limit = 100) {
    return this.unparsedRepo.listDeadLetter(limit);
  }

  async replayUnparsedEvents(limit = 100): Promise<ReplayUnparsedResult> {
    const pending = await this.unparsedRepo.listPending(limit);
    return this.replayBatch(pending);
  }

  async replaySingleEvent(pagingToken: string): Promise<{ success: boolean; message: string }> {
    const record = await this.unparsedRepo.getByPagingToken(pagingToken);
    if (!record) {
      return { success: false, message: "Event not found" };
    }
    if (record.status === "replayed") {
      return { success: false, message: "Event already replayed" };
    }

    const result = await this.replayBatch([record]);
    if (result.replayed === 1) {
      return { success: true, message: "Event successfully replayed" };
    }
    return { success: false, message: "Event failed to replay" };
  }

  async replaySpecificBatch(pagingTokens: string[]): Promise<ReplayUnparsedResult> {
    const records: UnparsedSorobanEventRecord[] = [];
    for (const token of pagingTokens) {
      const record = await this.unparsedRepo.getByPagingToken(token);
      if (record && record.status !== "replayed") {
        records.push(record);
      }
    }
    return this.replayBatch(records);
  }

  /**
   * Returns the durable checkpoint for a contract so operators can inspect
   * progress during stall diagnosis. Read-only: never mutates the checkpoint.
   */
  async getCheckpoint(contractId: string) {
    return this.checkpointRepo.getCheckpoint(contractId);
  }

  async replayBatch(records: UnparsedSorobanEventRecord[]): Promise<ReplayUnparsedResult> {
    let replayed = 0;
    let stillUnparsed = 0;

    for (const record of records) {
      const event = this.parser.parse(record.raw);
      if (event) {
        try {
          const inserted = await this.persistEvent(event, record.raw.contract_id);
          await this.unparsedRepo.markReplayed(record.pagingToken);
          if (inserted) {
            this.eventEmitter.emit(`stellar.${event.eventType}`, event);
          }
          replayed++;
        } catch (err) {
          await this.unparsedRepo.markFailed(
            record.pagingToken,
            (err as Error).message,
          );
          stillUnparsed++;
        }
      } else {
        await this.unparsedRepo.markFailed(
          record.pagingToken,
          "Parser still returned null after replay attempt",
        );
        stillUnparsed++;
      }
    }

    return { attempted: records.length, replayed, stillUnparsed };
  }

  private async captureUnparsedEvent(
    raw: RawHorizonContractEvent,
  ): Promise<"unknown_schema_version" | "parse_failure" | "ignored"> {
    const metadata = this.parser.inspect(raw);
    if (!metadata) {
      if (this.parser.isWellFormedXdr(raw)) return "ignored";

      await this.unparsedRepo.save({
        raw,
        reason: "parse_failure",
        errorMessage: "Malformed Soroban event XDR",
      });
      this.metrics.recordError("soroban_indexer", "parse_failure");
      return "parse_failure";
    }

    if (
      !this.parser.isSupportedSchemaVersion(
        metadata.eventName,
        metadata.schemaVersion,
      )
    ) {
      await this.unparsedRepo.save({
        raw,
        reason: "unknown_schema_version",
        eventName: metadata.eventName,
        schemaVersion: metadata.schemaVersion,
      });
      return "unknown_schema_version";
    }

    this.metrics.recordError("soroban_indexer", "parse_failure");
    await this.unparsedRepo.save({
      raw,
      reason: "parse_failure",
      eventName: metadata.eventName,
      schemaVersion: metadata.schemaVersion,
      errorMessage: "Parser returned null for a supported schema version",
    });
    return "parse_failure";
  }

  private async recordAnomaly(
    contractId: string,
    anomalyType: "gap" | "reorg" | "duplicate" | "out_of_order",
    raw?: RawHorizonContractEvent,
    previousLedger?: number | null,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const repository = this.checkpointRepo as IndexerCheckpointRepository & {
      recordAnomaly?: (input: {
        contractId: string;
        anomalyType: "gap" | "reorg" | "duplicate" | "out_of_order";
        ledger?: number | null;
        previousLedger?: number | null;
        pagingToken?: string | null;
        details?: Record<string, unknown>;
      }) => Promise<void>;
    };
    if (!repository.recordAnomaly) return;
    await repository.recordAnomaly({
      contractId,
      anomalyType,
      ledger: raw?.ledger,
      previousLedger,
      pagingToken: raw?.paging_token,
      details,
    });
  }
}