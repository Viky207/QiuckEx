/**
 * Mirrors TransactionItemDto from the backend.
 * Keep in sync with app/backend/src/transactions/dto/transaction.dto.ts
 */

/**
 * Canonical payment intent lifecycle states.
 *
 * These values are the stable, wire-level identifiers shared by the backend
 * payment intent contract and the mobile client. They must not be renamed
 * without a deliberate migration on both sides.
 *
 * Lifecycle:
 *   pending   -> submitted -> confirmed
 *   pending   -> expired
 *   pending   -> failed
 *   submitted -> confirmed
 *   submitted -> failed
 *
 * `confirmed` is only reached after ledger confirmation; `submitted` means the
 * transaction was broadcast but is not yet confirmed on the ledger.
 */
export type PaymentIntentState =
  | "pending"
  | "submitted"
  | "confirmed"
  | "expired"
  | "failed";

/**
 * Terminal states: no further transitions are possible from these values.
 */
export const TERMINAL_PAYMENT_INTENT_STATES: readonly PaymentIntentState[] = [
  "confirmed",
  "expired",
  "failed",
] as const;

/**
 * Non-terminal states: further transitions are expected.
 */
export const ACTIVE_PAYMENT_INTENT_STATES: readonly PaymentIntentState[] = [
  "pending",
  "submitted",
] as const;

/**
 * All implemented stable payment intent state values.
 */
export const PAYMENT_INTENT_STATES: readonly PaymentIntentState[] = [
  "pending",
  "submitted",
  "confirmed",
  "expired",
  "failed",
] as const;

/**
 * Returns true when the given state is a terminal state.
 */
export function isTerminalPaymentIntentState(
  state: PaymentIntentState,
): boolean {
  return TERMINAL_PAYMENT_INTENT_STATES.includes(state);
}

/**
 * Returns true when the given state indicates ledger confirmation.
 * Distinguishes submission (broadcast) from ledger confirmation.
 */
export function isLedgerConfirmedState(state: PaymentIntentState): boolean {
  return state === "confirmed";
}

/**
 * Returns true when the given state indicates submission without confirmation.
 */
export function isSubmittedState(state: PaymentIntentState): boolean {
  return state === "submitted";
}

/**
 * Retry-safe actions: only non-terminal states may be retried or polled.
 * Terminal states must not be retried.
 */
export function canRetryPaymentIntent(state: PaymentIntentState): boolean {
  return !isTerminalPaymentIntentState(state);
}

export interface TransactionItem {
  amount: string;
  asset: string;
  memo?: string;
  timestamp: string;
  txHash: string;
  pagingToken: string;
  source: string;
  destination: string;
  status: "Success" | "Pending";
  /**
   * Payment direction relative to the connected account.
   * Derived client-side: 'sent' if source matches accountId, 'received' otherwise.
   */
  direction?: "sent" | "received";
  /**
   * Canonical payment intent lifecycle state, when available.
   * See PaymentIntentState for the documented lifecycle and terminal states.
   */
  paymentIntentState?: PaymentIntentState;
}

/**
 * Mirrors TransactionResponseDto from the backend.
 */
export interface TransactionResponse {
  items: TransactionItem[];
  nextCursor?: string;
}

/**
 * Transaction-related types for receipt metadata
 */

export interface StellarTransaction {
  id: string;
  pagingToken: string;
  successful: boolean;
  hash: string;
  ledger: number;
  createdAt: string;
  sourceAccount: string;
  sourceAccountSequence: string;
  feeCharged: string;
  maxFee: string;
  operationCount: number;
  memoType?: string;
  memo?: string;
  signatures: string[];
}

export interface SorobanContractEvent {
  id: string;
  type: string;
  ledger: number;
  timestamp: string;
  contractId: string;
  topic: string[];
  value: Record<string, unknown>;
}

export interface HorizonLink {
  href: string;
  templated?: boolean;
}