export type TransactionAsset = {
  code: string;
  issuer?: string;
};

/**
 * Canonical payment intent lifecycle states.
 *
 * These values are the single source of truth shared with the backend
 * payment intent contract (see docs/payment-intent-lifecycle.md):
 *
 * - `pending`   — intent created, not yet submitted to the network.
 * - `submitted` — transaction broadcast to Horizon; no ledger confirmation yet.
 * - `confirmed` — transaction included in a ledger (ledger confirmation).
 * - `expired`   — terminal; submission window elapsed before confirmation.
 * - `failed`    — terminal; submission or ledger inclusion failed.
 *
 * `submitted` must never be treated as `confirmed`: only ledger inclusion
 * confirms a payment. `expired` and `failed` are terminal and retry-safe
 * actions must create a new intent rather than mutating these states.
 */
export const PAYMENT_INTENT_STATES = [
  "pending",
  "submitted",
  "confirmed",
  "expired",
  "failed",
] as const;

export type PaymentIntentState = (typeof PAYMENT_INTENT_STATES)[number];

export const TERMINAL_PAYMENT_INTENT_STATES = [
  "confirmed",
  "expired",
  "failed",
] as const satisfies readonly PaymentIntentState[];

export function isPaymentIntentState(value: unknown): value is PaymentIntentState {
  return (
    typeof value === "string" &&
    (PAYMENT_INTENT_STATES as readonly string[]).includes(value)
  );
}

export function isTerminalPaymentIntentState(
  state: PaymentIntentState,
): boolean {
  return (TERMINAL_PAYMENT_INTENT_STATES as readonly string[]).includes(state);
}

export type Transaction = {
  id: string;
  hash: string;
  ledger: number;
  sender: string;
  recipient: string;
  amount: string;
  asset: TransactionAsset;
  memo?: string;
  timestamp: string;
  feePaid: string;
  shielded?: boolean;
  /**
   * Payment intent lifecycle state. Optional for legacy records that predate
   * the lifecycle contract; consumers should treat a missing value as
   * `pending` via {@link getPaymentIntentState}.
   */
  status?: PaymentIntentState;
};

export type TransactionDetail = Transaction & {
  explorerUrl: string;
  horizonUrl: string;
};

const STELLAR_NETWORK = (process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "testnet") as
  | "testnet"
  | "mainnet";

const HORIZON_BASE_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL ??
  (STELLAR_NETWORK === "mainnet"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org");

export function getExplorerUrl(hash: string): string {
  const network = STELLAR_NETWORK === "mainnet" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${network}/tx/${hash}`;
}

export function getHorizonUrl(hash: string): string {
  return `${HORIZON_BASE_URL}/transactions/${hash}`;
}

export function toTransactionDetail(tx: Transaction): TransactionDetail {
  return {
    ...tx,
    explorerUrl: getExplorerUrl(tx.hash),
    horizonUrl: getHorizonUrl(tx.hash),
  };
}

export function formatRelativeTime(timestamp: string, now: Date = new Date()): string {
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) return "";
  const diffSeconds = Math.round((now.getTime() - then) / 1000);
  const abs = Math.abs(diffSeconds);
  if (abs < 60) return diffSeconds >= 0 ? `${abs}s ago` : `in ${abs}s`;
  const minutes = Math.round(abs / 60);
  if (minutes < 60) return diffSeconds >= 0 ? `${minutes}m ago` : `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return diffSeconds >= 0 ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return diffSeconds >= 0 ? `${days}d ago` : `in ${days}d`;
}

export function formatIsoTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toISOString();
}

export function displayAmount(tx: Transaction): string {
  return tx.shielded ? "Shielded" : tx.amount;
}

export function displaySender(tx: Transaction): string {
  return tx.shielded ? "Shielded" : tx.sender;
}

export function displayRecipient(tx: Transaction): string {
  return tx.shielded ? "Shielded" : tx.recipient;
}

/**
 * Resolve the canonical lifecycle state for a transaction. Legacy records
 * without a status are treated as `pending` (not yet confirmed).
 */
export function getPaymentIntentState(tx: Transaction): PaymentIntentState {
  return tx.status ?? "pending";
}

export function displayPaymentIntentState(tx: Transaction): string {
  const state = getPaymentIntentState(tx);
  switch (state) {
    case "pending":
      return "Pending";
    case "submitted":
      return "Submitted";
    case "confirmed":
      return "Confirmed";
    case "expired":
      return "Expired";
    case "failed":
      return "Failed";
  }
}
