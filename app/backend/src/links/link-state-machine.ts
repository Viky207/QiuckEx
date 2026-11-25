export enum LinkState {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  PAID = 'PAID',
  REFUNDED = 'REFUNDED',
}

/**
 * Canonical payment status vocabulary shared across web surfaces (dashboard,
 * link page, confirmation screen). Each LinkState maps to exactly one
 * PaymentStatus so a payment is never described differently per surface.
 */
export enum PaymentStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  EXPIRED = 'EXPIRED',
  FAILED = 'FAILED',
}

const PAYMENT_STATUS_BY_LINK_STATE: Record<LinkState, PaymentStatus> = {
  [LinkState.DRAFT]: PaymentStatus.PENDING,
  [LinkState.ACTIVE]: PaymentStatus.PENDING,
  [LinkState.EXPIRED]: PaymentStatus.EXPIRED,
  [LinkState.PAID]: PaymentStatus.CONFIRMED,
  [LinkState.REFUNDED]: PaymentStatus.FAILED,
};

export function getPaymentStatus(state: LinkState): PaymentStatus {
  return PAYMENT_STATUS_BY_LINK_STATE[state];
}

const TRANSITIONS: Record<LinkState, LinkState[]> = {
  [LinkState.DRAFT]: [LinkState.ACTIVE],
  [LinkState.ACTIVE]: [LinkState.EXPIRED, LinkState.PAID],
  [LinkState.EXPIRED]: [LinkState.ACTIVE],
  [LinkState.PAID]: [LinkState.REFUNDED],
  [LinkState.REFUNDED]: [],
};

export function canTransition(from: LinkState, to: LinkState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function applyTransition(from: LinkState, to: LinkState): LinkState {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid link state transition: ${from} -> ${to}`);
  }
  return to;
}

export function getAvailableTransitions(state: LinkState): LinkState[] {
  return [...TRANSITIONS[state]];
}

/**
 * Canonical monotonic ranking of receipt/link states.
 *
 * Higher rank means "further along" in the receipt lifecycle. Reconciliation
 * uses this to ensure a late or duplicated chain event cannot regress the
 * canonical state to an earlier status.
 *
 * Note: EXPIRED is intentionally ranked below ACTIVE because an expiry
 * observation that arrives after an activation observation must not overwrite
 * the newer ACTIVE state. Re-activation is handled explicitly via the
 * LinkState transition table, not via receipt reconciliation.
 */
const RECEIPT_RANK: Record<LinkState, number> = {
  [LinkState.DRAFT]: 0,
  [LinkState.EXPIRED]: 1,
  [LinkState.ACTIVE]: 2,
  [LinkState.PAID]: 3,
  [LinkState.REFUNDED]: 4,
};

export function getReceiptRank(state: LinkState): number {
  return RECEIPT_RANK[state];
}

const PAYMENT_STATUS_RANK: Record<PaymentStatus, number> = {
  [PaymentStatus.PENDING]: 0,
  [PaymentStatus.EXPIRED]: 1,
  [PaymentStatus.CONFIRMED]: 2,
  [PaymentStatus.FAILED]: 3,
};

export function getPaymentStatusRank(status: PaymentStatus): number {
  return PAYMENT_STATUS_RANK[status];
}

export type ReceiptTransitionOutcome =
  | { kind: 'applied'; state: LinkState }
  | { kind: 'duplicate'; state: LinkState }
  | { kind: 'conflict'; state: LinkState; observed: LinkState; reason: string };

/**
 * Determine whether an observed receipt status may advance the canonical
 * state. Returns true for forward (monotonic) transitions and false for
 * regressions or unrelated states.
 */
export function canTransitionReceipt(from: LinkState, to: LinkState): boolean {
  if (from === to) {
    return false;
  }
  return RECEIPT_RANK[to] > RECEIPT_RANK[from];
}

/**
 * Apply an observed receipt status to the canonical state without throwing.
 *
 * - Forward transitions advance the canonical state (`applied`).
 * - Re-observing the current state is idempotent (`duplicate`).
 * - Regressions or unrelated observations are rejected and reported as a
 *   `conflict` so callers can retain conflict evidence rather than silently
 *   overwriting newer state.
 */
export function applyReceiptTransition(
  from: LinkState,
  to: LinkState,
): ReceiptTransitionOutcome {
  if (from === to) {
    return { kind: 'duplicate', state: from };
  }
  if (canTransitionReceipt(from, to)) {
    return { kind: 'applied', state: to };
  }
  return {
    kind: 'conflict',
    state: from,
    observed: to,
    reason: `Receipt status regression rejected: ${from} -> ${to}`,
  };
}

/**
 * Resolve the payment status label a surface should display for a receipt
 * transition outcome. Conflicting observations never change the displayed
 * label, so a rejected regression cannot surface an inconsistent status.
 */
export function getOutcomePaymentStatus(
  outcome: ReceiptTransitionOutcome,
): PaymentStatus {
  return getPaymentStatus(outcome.state);
}