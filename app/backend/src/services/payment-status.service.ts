export type PaymentStatus = 'pending' | 'success' | 'failed';

export interface PaymentStatusSnapshot {
  transactionHash: string;
  status: PaymentStatus;
  updatedAt: number;
}

export interface HorizonStatusResult {
  status: PaymentStatus;
  updatedAt?: number;
}

export type HorizonStatusFetcher = (
  transactionHash: string,
) => Promise<HorizonStatusResult>;

export class PaymentStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentStatusError';
  }
}

const TERMINAL_STATES: ReadonlySet<PaymentStatus> = new Set(['success', 'failed']);

export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL_STATES.has(status);
}

/**
 * Authoritative status transition rules:
 *   pending -> success | failed   (allowed)
 *   success -> success            (idempotent)
 *   failed  -> failed             (idempotent)
 *   success -> pending | failed   (rejected: terminal never regresses)
 *   failed  -> pending | success  (rejected: terminal never regresses)
 */
export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) {
    return true;
  }
  if (isTerminal(from)) {
    return false;
  }
  return isTerminal(to);
}

/**
 * Resolves the authoritative status for a transaction hash, guaranteeing
 * monotonic reads across retry windows.
 *
 * - Repeated reads for the same hash never regress a terminal state to pending.
 * - Transient upstream (Horizon) failures never fabricate settlement: the last
 *   known authoritative state is returned, or an error is raised if none exists.
 */
export class PaymentStatusService {
  private readonly snapshots = new Map<string, PaymentStatusSnapshot>();
  private readonly inFlight = new Map<string, Promise<PaymentStatusSnapshot>>();

  constructor(private readonly fetchHorizonStatus: HorizonStatusFetcher) {}

  getSnapshot(transactionHash: string): PaymentStatusSnapshot | undefined {
    return this.snapshots.get(transactionHash);
  }

  async getStatus(transactionHash: string): Promise<PaymentStatusSnapshot> {
    const existing = this.inFlight.get(transactionHash);
    if (existing) {
      return existing;
    }

    const pending = this.resolveStatus(transactionHash).finally(() => {
      this.inFlight.delete(transactionHash);
    });
    this.inFlight.set(transactionHash, pending);
    return pending;
  }

  private async resolveStatus(transactionHash: string): Promise<PaymentStatusSnapshot> {
    const current = this.snapshots.get(transactionHash);

    let upstream: HorizonStatusResult;
    try {
      upstream = await this.fetchHorizonStatus(transactionHash);
    } catch (error) {
      if (current) {
        return current;
      }
      throw new PaymentStatusError(
        `Unable to resolve payment status for ${transactionHash}: ${(error as Error).message}`,
      );
    }

    const next = this.applyTransition(transactionHash, current, upstream);
    this.snapshots.set(transactionHash, next);
    return next;
  }

  private applyTransition(
    transactionHash: string,
    current: PaymentStatusSnapshot | undefined,
    upstream: HorizonStatusResult,
  ): PaymentStatusSnapshot {
    const now = Date.now();

    if (!current) {
      return {
        transactionHash,
        status: upstream.status,
        updatedAt: upstream.updatedAt ?? now,
      };
    }

    if (canTransition(current.status, upstream.status)) {
      if (current.status === upstream.status) {
        return current;
      }
      return {
        transactionHash,
        status: upstream.status,
        updatedAt: upstream.updatedAt ?? now,
      };
    }

    // Reject regressions from a terminal state; keep the authoritative snapshot.
    return current;
  }
}
