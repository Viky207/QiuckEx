import { Injectable, Logger } from "@nestjs/common";
import { SupabaseService } from "../supabase/supabase.service";
import type {
  EscrowEvent,
  EscrowDepositedEvent,
  EscrowDisputedEvent,
  EscrowFinalizedEvent,
  RefundFinalizedEvent,
  PartialPaymentEvent,
  MilestoneCompletedEvent,
  EscrowExtensionAppliedEvent,
  EscrowExtensionFeeChargedEvent,
  EscrowExtensionFeeRefundedEvent,
  EscrowCleanedEvent,
} from "./types/contract-event.types";

/**
 * Canonical receipt statuses, ordered from least to most advanced.
 * Terminal statuses (FINALIZED, REFUNDED, CLEANED) can never be left.
 */
export const RECEIPT_STATUS_RANK: Readonly<Record<string, number>> = Object.freeze({
  PENDING: 0,
  PAID: 1,
  DISPUTED: 2,
  FINALIZED: 3,
  REFUNDED: 3,
  CLEANED: 4,
});

const TERMINAL_RECEIPT_STATUSES: ReadonlySet<string> = new Set([
  "FINALIZED",
  "REFUNDED",
  "CLEANED",
]);

/**
 * Returns true when moving a receipt from `from` to `to` is a monotonic
 * (non-regressing) transition. Unknown statuses are treated as non-transitionable
 * so that unexpected values cannot clobber canonical state.
 */
export function canTransitionReceipt(from: string, to: string): boolean {
  if (from === to) {
    return true;
  }
  const fromRank = RECEIPT_STATUS_RANK[from];
  const toRank = RECEIPT_STATUS_RANK[to];
  if (fromRank === undefined || toRank === undefined) {
    return false;
  }
  if (TERMINAL_RECEIPT_STATUSES.has(from)) {
    return false;
  }
  return toRank > fromRank;
}

/**
 * Returns true when an observation carries the same status as the canonical
 * state, i.e. replaying it is an idempotent no-op.
 */
export function isDuplicateObservation(canonical: string | null, observed: string | null): boolean {
  return canonical !== null && observed !== null && canonical === observed;
}

/**
 * Persists escrow domain events to Supabase.
 * All inserts use ON CONFLICT DO NOTHING so replaying the same event is safe.
 * Receipt status transitions are enforced monotonically: regressions are
 * recorded as conflict evidence instead of overwriting canonical state.
 */
@Injectable()
export class EscrowEventRepository {
  private readonly logger = new Logger(EscrowEventRepository.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Idempotently insert an escrow event.
   * The unique constraint on (tx_hash, commitment, event_type) ensures
   * that re-processing the same event is a no-op.
   */
  async upsertEvent(event: EscrowEvent): Promise<boolean> {
    const client = this.supabase.getClient();

    const row: Record<string, unknown> = {
      event_type: event.eventType,
      event_id: event.eventId,
      commitment: event.commitment,
      owner: "owner" in event ? event.owner : null,
      token: "token" in event ? event.token : null,
      amount: "amount" in event ? event.amount.toString() : null,
      contract_timestamp: Number(event.contractTimestamp),
      tx_hash: event.txHash,
      ledger_sequence: event.ledgerSequence,
      paging_token: event.pagingToken,
      expires_at:
        event.eventType === "EscrowDeposited"
          ? new Date(
              Number((event as EscrowDepositedEvent).expiresAt) * 1000,
            ).toISOString()
          : null,
      arbiter: "arbiter" in event ? (event as EscrowDisputedEvent).arbiter : null,
      payer: "payer" in event ? (event as PartialPaymentEvent).payer : null,
      payment_amount: "paymentAmount" in event ? (event as PartialPaymentEvent).paymentAmount.toString() : null,
      amount_paid: "amountPaid" in event ? (event as PartialPaymentEvent).amountPaid.toString() : null,
      amount_due: "amountDue" in event ? (event as PartialPaymentEvent).amountDue.toString() : null,
      total_amount: "totalAmount" in event ? (event as EscrowFinalizedEvent).totalAmount.toString() : null,
      expires_at_finalized: "expiresAt" in event ? new Date(Number((event as RefundFinalizedEvent).expiresAt) * 1000).toISOString() : null,
      milestone_id: "milestoneId" in event ? (event as MilestoneCompletedEvent).milestoneId : null,
      milestone_amount: "milestoneAmount" in event ? (event as MilestoneCompletedEvent).milestoneAmount.toString() : null,
      total_amount_paid: "totalAmountPaid" in event ? (event as MilestoneCompletedEvent).totalAmountPaid.toString() : null,
      extension_count: "extensionCount" in event ? (event as EscrowExtensionAppliedEvent).extensionCount : null,
      extension_secs: "extensionSecs" in event ? (event as EscrowExtensionAppliedEvent).extensionSecs.toString() : null,
      fee: "fee" in event ? (event as EscrowExtensionAppliedEvent | EscrowExtensionFeeChargedEvent | EscrowExtensionFeeRefundedEvent).fee.toString() : null,
      new_expires_at: "newExpiresAt" in event ? (event as EscrowExtensionAppliedEvent).newExpiresAt.toString() : null,
      fee_refunded: "fee" in event && event.eventType === "EscrowExtensionFeeRefunded" ? (event as EscrowExtensionFeeRefundedEvent).fee.toString() : null,
      refund_reason: "reason" in event ? (event as EscrowExtensionFeeRefundedEvent).reason : null,
      status: "status" in event ? (event as EscrowCleanedEvent).status : null,
      evidence_hash: "evidenceHash" in event ? (event as { evidenceHash: string }).evidenceHash : null,
      submitted_by: "submittedBy" in event ? (event as { submittedBy: string }).submittedBy : null,
      resolve_for_owner: "resolveForOwner" in event ? (event as ArbiterVoteCastEvent | DisputeResolvedEvent).resolveForOwner : null,
      vote_count: "voteCount" in event ? (event as ArbiterVoteCastEvent).voteCount : null,
      threshold: "threshold" in event ? (event as ArbiterVoteCastEvent | DisputeResolvedEvent).threshold : null,
      total_votes: "totalVotes" in event ? (event as DisputeResolvedEvent).totalVotes : null,
      amount_disputed: "amount" in event && (event.eventType === "DisputeResolved" || event.eventType === "ArbiterVoteCast") ? (event as DisputeResolvedEvent).amount.toString() : null,
    };

    const observedStatus = this.extractReceiptStatus(event);
    if (observedStatus !== null) {
      const canonicalStatus = await this.readCanonicalStatus(event.commitment);

      if (isDuplicateObservation(canonicalStatus, observedStatus)) {
        this.logger.debug(
          `Idempotent receipt status observation ${observedStatus} commitment=${event.commitment}`,
        );
        return false;
      }

      if (canonicalStatus !== null && !canTransitionReceipt(canonicalStatus, observedStatus)) {
        await this.recordStatusConflict(event, observedStatus, canonicalStatus);
        return false;
      }
    }

    const { data, error } = await client
      .from("escrow_events")
      .upsert(row, {
        onConflict: "tx_hash,commitment,event_type",
        ignoreDuplicates: true,
      })
      .select("id");

    if (error) {
      this.logger.error(
        `Failed to upsert escrow event ${event.eventType} for commitment ${event.commitment}: ${error.message}`,
      );
      throw error;
    }

    this.logger.debug(
      `Persisted ${event.eventType} commitment=${event.commitment} ledger=${event.ledgerSequence}`,
    );
    return Boolean(data?.length);
  }

  /**
   * Extracts the receipt status carried by an event, if any.
   */
  private extractReceiptStatus(event: EscrowEvent): string | null {
    if ("status" in event && typeof (event as EscrowCleanedEvent).status === "string") {
      return (event as EscrowCleanedEvent).status;
    }
    return null;
  }

  /**
   * Reads the current canonical receipt status for a commitment.
   * Returns null when no status has been recorded yet.
   */
  private async readCanonicalStatus(commitment: string): Promise<string | null> {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from("escrow_events")
      .select("status, ledger_sequence")
      .eq("commitment", commitment)
      .not("status", "is", null)
      .order("ledger_sequence", { ascending: false })
      .limit(1);

    if (error) {
      this.logger.error(
        `Failed to read canonical receipt status for commitment ${commitment}: ${error.message}`,
      );
      throw error;
    }

    const latest = data?.[0] as { status?: string | null } | undefined;
    return latest?.status ?? null;
  }

  /**
   * Records a regressing observation as conflict evidence without touching
   * canonical state. Never throws on conflict-write failure so that a single
   * bad observation cannot stall ingestion.
   */
  private async recordStatusConflict(
    event: EscrowEvent,
    observedStatus: string,
    canonicalStatus: string,
  ): Promise<void> {
    const client = this.supabase.getClient();
    const { error } = await client.from("receipt_status_conflicts").insert({
      event_id: event.eventId,
      event_type: event.eventType,
      commitment: event.commitment,
      observed_status: observedStatus,
      canonical_status: canonicalStatus,
      tx_hash: event.txHash,
      ledger_sequence: event.ledgerSequence,
      observed_at: new Date(Number(event.contractTimestamp) * 1000).toISOString(),
    });

    if (error) {
      this.logger.error(
        `Failed to record receipt status conflict for commitment ${event.commitment}: ${error.message}`,
      );
      return;
    }

    this.logger.warn(
      `Rejected regressing receipt status ${observedStatus} (canonical ${canonicalStatus}) commitment=${event.commitment}`,
    );
  }
}
