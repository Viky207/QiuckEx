export type TransactionAsset = {
  code: string;
  issuer?: string;
};

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
};

export type TransactionDetail = Transaction & {
  explorerUrl: string;
  horizonUrl: string;
};

/**
 * Canonical payment status vocabulary shared across web surfaces
 * (dashboard, link page, confirmation screen).
 *
 * Each value maps to a stable backend `LinkState`:
 * - `pending`   <- DRAFT, ACTIVE
 * - `confirmed` <- PAID
 * - `expired`   <- EXPIRED
 * - `failed`    <- REFUNDED (and any unrecognized/unknown backend state)
 */
export type PaymentStatus = "pending" | "confirmed" | "expired" | "failed";

/** Backend link states as returned by the API. */
export type LinkState = "DRAFT" | "ACTIVE" | "EXPIRED" | "PAID" | "REFUNDED";

export type PaymentStatusPresentation = {
  status: PaymentStatus;
  /** Human-readable label, e.g. "Pending". */
  label: string;
  /** Non-color-only glyph so status is distinguishable without color. */
  glyph: string;
  /** Short text signal paired with the glyph (also non-color-only). */
  signal: string;
  /** Text announced to assistive technology via an aria-live region. */
  announcement: string;
};

const PAYMENT_STATUS_PRESENTATION: Record<PaymentStatus, Omit<PaymentStatusPresentation, "status">> = {
  pending: {
    label: "Pending",
    glyph: "◷",
    signal: "Awaiting payment",
    announcement: "Payment status: Pending. Awaiting payment.",
  },
  confirmed: {
    label: "Confirmed",
    glyph: "✓",
    signal: "Payment received",
    announcement: "Payment status: Confirmed. Payment received.",
  },
  expired: {
    label: "Expired",
    glyph: "⌛",
    signal: "Link expired",
    announcement: "Payment status: Expired. The payment link has expired.",
  },
  failed: {
    label: "Failed",
    glyph: "✕",
    signal: "Payment not completed",
    announcement: "Payment status: Failed. The payment was not completed.",
  },
};

/**
 * Maps a backend `LinkState` to the canonical `PaymentStatus`.
 * Unknown or unrecognized states fall back to `failed` so the UI never
 * silently presents an ambiguous state as successful.
 */
export function mapBackendStateToPaymentStatus(state: LinkState | string | null | undefined): PaymentStatus {
  switch (state) {
    case "DRAFT":
    case "ACTIVE":
      return "pending";
    case "PAID":
      return "confirmed";
    case "EXPIRED":
      return "expired";
    case "REFUNDED":
    default:
      return "failed";
  }
}

/**
 * Returns the presentation (label, non-color glyph/signal, and aria-live
 * announcement) for a canonical payment status.
 */
export function getPaymentStatusPresentation(status: PaymentStatus): PaymentStatusPresentation {
  const presentation = PAYMENT_STATUS_PRESENTATION[status];
  return { status, ...presentation };
}

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
