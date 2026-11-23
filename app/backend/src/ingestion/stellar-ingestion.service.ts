import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Horizon } from "@stellar/stellar-sdk";

import { AppConfigService } from "../config";
import { HORIZON_BASE_URLS } from "../config/stellar.config";
import {
  SorobanEventParser,
  RawHorizonContractEvent,
} from "./soroban-event.parser";
import { CursorRepository } from "./cursor.repository";
import { EscrowEventRepository } from "./escrow-event.repository";
import { JobQueueService } from "../job-queue/job-queue.service";
import { JobType } from "../job-queue/types";
import { StellarReconnectPayload } from "../job-queue/types/job-payloads.types";
import type {
  EscrowEvent,
  QuickExContractEvent,
} from "./types/contract-event.types";
import type { ReceiptTransitionResult } from "./escrow-event.repository";

/** Milliseconds between reconnect attempts (doubles each retry, capped at MAX_BACKOFF_MS). */
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;

/**
 * Structured metadata attached to Horizon dependency failures.
 *
 * Only privacy-safe correlation data is captured: the upstream request id
 * (when Horizon supplies one) and the HTTP status. Addresses, payloads and
 * other response bodies are never included.
 */
export interface HorizonDependencyErrorMetadata {
  dependency: "horizon";
  /** Upstream request id supplied by Horizon (e.g. `X-Request-Id`), if any. */
  requestId?: string;
  /** HTTP status code, when the failure came from an HTTP response. */
  status?: number;
  /** Stable error code for downstream consumers. */
  code: "HORIZON_STREAM_ERROR";
}

/**
 * Extract an approved upstream request id from a Horizon error/response.
 *
 * Horizon exposes its correlation id via the `X-Request-Id` header (and, for
 * some SDK error shapes, a `requestId`/`request_id` property). Returns
 * `undefined` when no identifier was supplied — we never synthesise one.
 */
export function extractHorizonRequestId(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const candidate = err as {
    requestId?: unknown;
    request_id?: unknown;
    response?: { headers?: unknown };
    headers?: unknown;
  };

  const direct = candidate.requestId ?? candidate.request_id;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }

  const headerSource = candidate.response?.headers ?? candidate.headers;
  const headerValue = readHeader(headerSource, "x-request-id");
  return headerValue;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(n: string): unknown }).get(name);
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : undefined;
  }
  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(
      headers as Record<string, unknown>,
    )) {
      if (key.toLowerCase() === name && typeof value === "string") {
        return value.trim().length > 0 ? value.trim() : undefined;
      }
    }
  }
  return undefined;
}

/**
 * Build structured, privacy-safe metadata for a Horizon stream failure.
 * Logs must use this instead of stringifying the raw error, which may embed
 * addresses or payloads.
 */
export function buildHorizonErrorMetadata(
  err: unknown,
): HorizonDependencyErrorMetadata {
  const requestId = extractHorizonRequestId(err);
  const status =
    typeof (err as { response?: { status?: unknown } })?.response?.status ===
    "number"
      ? ((err as { response: { status: number } }).response.status)
      : undefined;

  return {
    dependency: "horizon",
    code: "HORIZON_STREAM_ERROR",
    ...(requestId ? { requestId } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export interface IngestionConfig {
  contractId: string;
}

export interface DualReadIngestionConfig extends IngestionConfig {
  previousContractId?: string;
  effectiveLedger?: number;
}

/**
 * Listens to Horizon SSE streams for a QuickEx Soroban contract.
 *
 * Responsibilities:
 *  - Open a streaming subscription starting from the last known cursor.
 *  - Parse each raw Soroban event into a typed domain event.
 *  - Persist escrow events idempotently to Supabase.
 *  - Update the cursor after each successful persist.
 *  - Auto-reconnect with exponential back-off when the stream drops.
 */
@Injectable()
export class StellarIngestionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StellarIngestionService.name);

  private server!: Horizon.Server;
  private stopStream: (() => void) | null = null;
  private stopPreviousStream: (() => void) | null = null;
  private destroyed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private currentBackoffMs = INITIAL_BACKOFF_MS;
  private currentContractId: string | null = null;
  private previousContractId: string | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly cursorRepo: CursorRepository,
    private readonly escrowRepo: EscrowEventRepository,
    private readonly parser: SorobanEventParser,
    private readonly eventEmitter: EventEmitter2,
    private readonly jobQueueService: JobQueueService,
  ) {}

  onModuleInit(): void {
    const network = this.config.network;
    const horizonUrl = HORIZON_BASE_URLS[network];
    this.server = new Horizon.Server(horizonUrl);
    this.logger.log(
      `Stellar ingestion initialised (${network} → ${horizonUrl})`,
    );
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.stopCurrentStream();
    this.stopPreviousStreamFn();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.logger.log("Stellar ingestion service stopped.");
  }

  /**
   * Start streaming contract events for the given contract ID.
   * Safe to call multiple times; previous stream is closed first.
   */
  async startStreaming(contractId: string): Promise<void> {
    this.currentContractId = contractId;
    this.stopCurrentStream();
    this.stopPreviousStreamFn();
    await this.openStream(contractId);
  }

  /**
   * Start streaming contract events with dual-read support for transition windows.
   * Streams from both current and previous contract IDs until effective ledger is reached.
   */
  async startStreamingWithDualRead(config: DualReadIngestionConfig): Promise<void> {
    this.currentContractId = config.contractId;
    this.previousContractId = config.previousContractId ?? null;
    this.stopCurrentStream();
    this.stopPreviousStreamFn();

    // If in dual-read window, start previous stream first
    if (config.previousContractId && config.effectiveLedger) {
      this.logger.log(
        `Starting dual-read streams: previous=${config.previousContractId}, current=${config.contractId}, effective ledger=${config.effectiveLedger}`,
      );
      this.stopPreviousStream = await this.openStreamAsync(config.previousContractId);
    }

    // Always open current stream
    await this.openStream(config.contractId);
  }

  // ---------------------------------------------------------------------------
  // Private stream management
  // ---------------------------------------------------------------------------

  private async openStream(contractId: string): Promise<void> {
    const streamId = `contract:${contractId}`;
    const cursor = await this.cursorRepo.getCursor(streamId);

    this.logger.log(
      cursor
        ? `Resuming stream ${streamId} from cursor ${cursor}`
        : `Starting stream ${streamId} from "now"`,
    );

    // stellar-sdk v13 exposes `server.operationsForAccount` / `server.payments`
    // but for Soroban contract events we use the dedicated endpoint:
    const eventsBuilder = (
      this.server as unknown as {
        contractEvents(contractId: string): {
          cursor(c: string): unknown;
          stream(opts: {
            onmessage: (record: unknown) => void;
            onerror: (err: unknown) => void;
          }): () => void;
        };
      }
    ).contractEvents?.(contractId);

    if (!eventsBuilder) {
      // Fallback: use Horizon's raw SSE endpoint via fetch + EventSource
      this.logger.warn(
        "server.contractEvents() not available on this SDK version; using raw SSE fallback.",
      );
      this.stopStream = this.openRawSseStream(contractId, streamId, cursor);
      return;
    }

    const cursoredBuilder = cursor
      ? eventsBuilder.cursor(cursor)
      : eventsBuilder.cursor("now");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stop = (cursoredBuilder as any).stream({
      onmessage: (record: unknown) => {
        void this.handleRecord(record as RawHorizonContractEvent, streamId);
      },
      onerror: (err: unknown) => {
        this.logHorizonStreamError(streamId, err);
        this.stopCurrentStream();
        this.scheduleReconnect(contractId);
      },
    }) as () => void;

    this.stopStream = stop;
    this.currentBackoffMs = INITIAL_BACKOFF_MS; // reset on successful open
  }

  /**
   * Fallback SSE stream using the Horizon REST API directly via stellar-sdk's
   * CallBuilder streaming, watching the /contract_events endpoint.
   */
  private openRawSseStream(
    contractId: string,
    streamId: string,
    cursor: string | null,
  ): () => void {
    const horizonUrl = HORIZON_BASE_URLS[this.config.network];
    const url = new URL(`${horizonUrl}/contract_events`);
    url.searchParams.set("contract_id", contractId);
    url.searchParams.set("cursor", cursor ?? "now");
    url.searchParams.set("limit", "200");

    this.logger.debug(`Opening SSE at ${url.toString()}`);

    const es = new EventSource(url.toString());

    es.onmessage = (msg: MessageEvent) => {
      try {
        const record = JSON.parse(
          msg.data as string,
        ) as RawHorizonContractEvent;
        void this.handleRecord(record, streamId);
      } catch (err) {
        this.logger.warn(`Failed to parse SSE message: ${String(err)}`);
      }
    };

    es.onerror = (err) => {
      this.logHorizonStreamError(streamId, err);
      es.close();
      this.scheduleReconnect(contractId);
    };

    return () => es.close();
  }

  private stopCurrentStream(): void {
    if (this.stopStream) {
      try {
        this.stopStream();
      } catch {
        // ignore
      }
      this.stopStream = null;
    }
  }

  private stopPreviousStreamFn(): void {
    if (this.stopPreviousStream) {
      try {
        this.stopPreviousStream();
      } catch {
        // ignore
      }
      this.stopPreviousStream = null;
    }
  }

  private async openStreamAsync(contractId: string): Promise<() => void> {
    const streamId = `contract:${contractId}`;
    const cursor = await this.cursorRepo.getCursor(streamId);

    this.logger.log(
      cursor
        ? `Resuming stream ${streamId} from cursor ${cursor}`
        : `Starting stream ${streamId} from "now"`,
    );

    const eventsBuilder = (
      this.server as unknown as {
        contractEvents(contractId: string): {
          cursor(c: string): unknown;
          stream(opts: {
            onmessage: (record: unknown) => void;
            onerror: (err: unknown) => void;
          }): () => void;
        };
      }
    ).contractEvents?.(contractId);

    if (!eventsBuilder) {
      return this.openRawSseStream(contractId, streamId, cursor);
    }

    const cursoredBuilder = cursor
      ? eventsBuilder.cursor(cursor)
      : eventsBuilder.cursor("now");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stop = (cursoredBuilder as any).stream({
      onmessage: (record: unknown) => {
        void this.handleRecord(record as RawHorizonContractEvent, streamId);
      },
      onerror: (err: unknown) => {
        this.logHorizonStreamError(streamId, err);
        this.stopCurrentStream();
        this.scheduleReconnect(contractId);
      },
    }) as () => void;

    this.currentBackoffMs = INITIAL_BACKOFF_MS;
    return stop;
  }

  /**
   * Log a Horizon stream failure using structured, privacy-safe metadata.
   *
   * The raw error is never stringified into the log line: it may contain
   * account addresses or event payloads. Only the upstream request id (when
   * supplied by Horizon) and HTTP status are surfaced for correlation.
   */
  private logHorizonStreamError(streamId: string, err: unknown): void {
    const metadata = buildHorizonErrorMetadata(err);
    this.logger.error(
      `Horizon stream error for ${streamId}`,
      metadata as unknown as Record<string, unknown>,
    );
  }

  private async scheduleReconnect(contractId: string): Promise<void> {
    if (this.destroyed) return;

    // Get the last cursor for this contract
    const streamId = `contract:${contractId}`;
    const lastCursor = await this.cursorRepo.getCursor(streamId);

    if (!lastCursor) {
      this.logger.warn(
        `No cursor found for contract ${contractId} - cannot enqueue reconnect job`,
      );
      // Fall back to in-process reconnection
      this.logger.warn(
        `Reconnecting stream for contract ${contractId} in ${this.currentBackoffMs}ms (in-process fallback)`,
      );

      this.reconnectTimer = setTimeout(() => {
        if (!this.destroyed) {
          void this.openStream(contractId);
        }
      }, this.currentBackoffMs);

      // Exponential back-off with cap
      this.currentBackoffMs = Math.min(
        this.currentBackoffMs * BACKOFF_MULTIPLIER,
        MAX_BACKOFF_MS,
      );
      return;
    }

    // Enqueue stellar_reconnect job via JobQueueService
    // Requirements: 11.2, 11.5
    try {
      const payload: StellarReconnectPayload = {
        contractId,
        lastCursor,
      };

      const jobId = await this.jobQueueService.enqueue(
        JobType.STELLAR_RECONNECT,
        payload,
      );

      this.logger.log(
        `SSE stream disconnected - reconnect job enqueued: ${jobId} ` +
        `(contractId: ${contractId}, lastCursor: ${lastCursor})`,
      );

      // Reset backoff since we successfully enqueued the job
      this.currentBackoffMs = INITIAL_BACKOFF_MS;
    } catch (err) {
      this.logger.error(
        `Failed to enqueue reconnect job for contract ${contractId}: ${(err as Error).message}`,
        (err as Error).stack,
      );

      // Fall back to in-process reconnection
      this.logger.warn(
        `Reconnecting stream for contract ${contractId} in ${this.currentBackoffMs}ms (in-process fallback)`,
      );

      this.reconnectTimer = setTimeout(() => {
        if (!this.destroyed) {
          void this.openStream(contractId);
        }
      }, this.currentBackoffMs);

      // Exponential back-off with cap
      this.currentBackoffMs = Math.min(
        this.currentBackoffMs * BACKOFF_MULTIPLIER,
        MAX_BACKOFF_MS,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Event processing
  // ---------------------------------------------------------------------------

  private async handleRecord(
    raw: RawHorizonContractEvent,
    streamId: string,
  ): Promise<void> {
    const event = this.parser.parse(raw);

    if (!event) {
      // Unrecognised or non-QuickEx event; still advance cursor.
      await this.safeUpdateCursor(streamId, raw.paging_token, raw.ledger);
      return;
    }

    this.logger.debug(
      `Processing ${event.eventType} paging_token=${event.pagingToken}`,
    );

    const transition = await this.persistEvent(event);

    // A rejected regression must not advance the cursor past the conflicting
    // observation: the event is retained as conflict evidence and the cursor
    // stays put so the evidence can be re-examined on the next pass.
    if (transition?.outcome === "rejected_regression") {
      this.logger.warn(
        `Receipt status conflict: ${event.eventType} paging_token=${event.pagingToken} ` +
          `receipt=${transition.receiptId ?? "unknown"} ` +
          `observed=${transition.observedStatus ?? "unknown"} ` +
          `canonical=${transition.canonicalStatus ?? "unknown"}`,
      );
      this.eventEmitter.emit("stellar.receipt_status_conflict", {
        eventType: event.eventType,
        pagingToken: event.pagingToken,
        receiptId: transition.receiptId,
        observedStatus: transition.observedStatus,
        canonicalStatus: transition.canonicalStatus,
      });
      return;
    }

    await this.safeUpdateCursor(streamId, raw.paging_token, raw.ledger);

    // Emit for other services / notification layer
    this.eventEmitter.emit(`stellar.${event.eventType}`, event);
  }

  private async persistEvent(
    event: QuickExContractEvent,
  ): Promise<ReceiptTransitionResult | null> {
    switch (event.eventType) {
      case "EscrowDeposited":
      case "EscrowWithdrawn":
      case "EscrowRefunded":
        return this.escrowRepo.upsertEvent(event as EscrowEvent);
      default:
        // Other events are emitted but not stored in the DB yet.
        this.logger.debug(
          `Event ${event.eventType} emitted but not persisted.`,
        );
        return null;
    }
  }

  private async safeUpdateCursor(
    streamId: string,
    pagingToken: string,
    ledger?: number,
  ): Promise<void> {
    try {
      await this.cursorRepo.saveCursor(streamId, pagingToken, ledger);
    } catch (err) {
      // Cursor update failure is non-fatal; we log and continue.
      // The worst case is re-processing a handful of events on the next restart
      // (handled by idempotency constraints).
      this.logger.error(`Failed to update cursor: ${String(err)}`);
    }
  }
}
