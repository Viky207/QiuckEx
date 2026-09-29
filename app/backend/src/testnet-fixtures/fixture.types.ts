/**
 * Stable error codes for the testnet fixture manager.
 *
 * These are frozen strings rather than ad-hoc messages so a failing fixture run
 * is diagnosable from CI output alone, and so a caller can branch on the cause
 * without matching prose.
 */
export const FIXTURE_ERROR_CODES = {
  /** The manager was invoked while the backend is pointed at mainnet. */
  NETWORK_NOT_TESTNET: 'FIXTURE_NETWORK_NOT_TESTNET',
  /** The caller asked for a name outside the allowed alphabet. */
  INVALID_FIXTURE_NAME: 'FIXTURE_INVALID_NAME',
  /** A caller-supplied account id did not decode as an ed25519 public key. */
  INVALID_ACCOUNT_ID: 'FIXTURE_INVALID_ACCOUNT_ID',
  /** Horizon was unreachable or returned an error after the retry budget. */
  DEPENDENCY_UNAVAILABLE: 'FIXTURE_DEPENDENCY_UNAVAILABLE',
  /** The account exists but could not be funded within the retry budget. */
  FUNDING_FAILED: 'FIXTURE_FUNDING_FAILED',
} as const;

export type FixtureErrorCode =
  (typeof FIXTURE_ERROR_CODES)[keyof typeof FIXTURE_ERROR_CODES];

/**
 * Thrown for every expected failure so callers can branch on a stable code.
 *
 * `cause` is preserved so an underlying Horizon or network error is not lost,
 * but it is never rendered into a user-facing surface: the fixture manager is a
 * developer tool and its messages are read in CI logs.
 */
export class FixtureError extends Error {
  constructor(
    readonly code: FixtureErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'FixtureError';
  }
}

/** Outcome of ensuring a single fixture account is usable. */
export type FixtureStatus =
  /** The account already existed and already held the target balance. */
  | 'ready'
  /** The account was created on testnet by the funding call. */
  | 'created'
  /** The account existed but was topped up to reach the target balance. */
  | 'topped_up'
  /** Funding was attempted and the account still fell short of the target. */
  | 'underfunded';

/** A single fixture account's resolved state. */
export interface FixtureAccount {
  /** Canonical (normalized) fixture name. */
  name: string;
  /** Derived public account id. */
  publicKey: string;
  /** Best-known native balance, in XLM. `null` when it could not be read. */
  balanceXlm: number | null;
  status: FixtureStatus;
}

/** Aggregate result of one {@link TestnetFixtureManager.ensureFixtures} call. */
export interface FixtureRunResult {
  network: 'testnet';
  /** Public account ids only. Secret seeds are never included. */
  accounts: FixtureAccount[];
  /** Fixture names that could not be resolved or funded, with stable codes. */
  failures: Array<{ name: string; code: FixtureErrorCode; message: string }>;
  /** Wall-clock duration of the run, for the capacity/latency budget. */
  durationMs: number;
}
