import { Injectable, Logger } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';

import { AppConfigService } from '../config';
import { MetricsService } from '../metrics/metrics.service';
import {
  deriveFixtureAccountId,
  FixtureDerivationError,
  isValidAccountId,
} from './fixture-derivation';
import {
  FIXTURE_ERROR_CODES,
  FixtureAccount,
  FixtureError,
  FixtureRunResult,
} from './fixture.types';

/** Testnet friendbot. Testnet-only by construction: it does not exist on mainnet. */
const FRIENDBOT_URL = 'https://friendbot.stellar.org';

/** Native asset, in stroops. */
const STROOPS_PER_XLM = 10_000_000;

/** Default balance to ensure a fixture holds, in XLM. */
export const DEFAULT_FIXTURE_BALANCE_XLM = 100;

/**
 * The Horizon operations the manager needs, narrowed to an interface so the
 * decision logic can be driven through every failure path without a network.
 */
export interface FixtureHorizon {
  /** `null` when the account does not exist yet. */
  loadAccount(publicKey: string): Promise<{ nativeBalance: number } | null>;
  /** Ask friendbot to create and fund the account. Throws on failure. */
  fundTestnetAccount(publicKey: string): Promise<void>;
}

/** Options for a single {@link TestnetFixtureManager.ensureFixtures} call. */
export interface EnsureFixturesOptions {
  /** Target native balance per account, in XLM. */
  balanceXlm?: number;
  /** Attempts per Horizon call before giving up with a stable error code. */
  maxAttempts?: number;
  /** Base delay for the bounded exponential backoff between attempts. */
  retryBaseDelayMs?: number;
}

/**
 * Deterministic testnet fixture manager (issue #283).
 *
 * Resolves a named set of fixture wallets to stable, funded testnet accounts.
 * Three properties matter, and each is enforced structurally rather than by
 * convention:
 *
 *  1. **Determinism.** The account id is a pure function of the fixture name, so
 *     two runs, two machines, and two contributors agree on which account a test
 *     is talking about.
 *  2. **Idempotency.** An account that already holds the target balance is left
 *     alone, so re-running a suite never re-funds or re-creates anything and a
 *     repeat run costs no network writes.
 *  3. **Network containment.** The manager refuses to do anything unless the
 *     backend is explicitly on testnet. Funding is the one operation here that
 *     would be genuinely harmful on mainnet, so the guard is a hard
 *     precondition rather than a warning.
 *
 * Self-custody is preserved: the manager only reads balances and asks friendbot
 * to create throwaway testnet accounts. It never signs on behalf of a user and
 * never moves an existing account's funds.
 */
@Injectable()
export class TestnetFixtureManager {
  private readonly logger = new Logger(TestnetFixtureManager.name);
  private readonly horizon: FixtureHorizon;

  constructor(
    private readonly config: AppConfigService,
    private readonly metrics: MetricsService,
    horizon?: FixtureHorizon,
  ) {
    this.horizon =
      horizon ??
      new HorizonFixtureClient(
        this.config.isMainnet
          ? 'https://horizon.stellar.org'
          : 'https://horizon-testnet.stellar.org',
      );
  }

  /**
   * Resolve the account id for a fixture name without touching the network.
   *
   * Useful for building a test's expected values, and for a dry run that should
   * still be able to report which accounts it *would* use.
   */
  resolveAccountId(name: string): string {
    try {
      return deriveFixtureAccountId(name);
    } catch (error) {
      if (error instanceof FixtureDerivationError) {
        throw new FixtureError(FIXTURE_ERROR_CODES.INVALID_FIXTURE_NAME, error.message, {
          cause: error,
        });
      }
      throw error;
    }
  }

  /**
   * Ensure every named fixture exists on testnet and holds `balanceXlm`.
   *
   * Resolution is per-account and non-fatal: one unreachable account is reported
   * in `failures` with a stable code while the rest of the set still resolves. A
   * run that aborted on the first transient Horizon error would be far harder to
   * diagnose than one that reports exactly what worked.
   */
  async ensureFixtures(
    names: readonly string[],
    options: EnsureFixturesOptions = {},
  ): Promise<FixtureRunResult> {
    if (!this.config.isTestnet) {
      // Thrown, not reported: on mainnet the entire operation is invalid, and a
      // partially-applied fixture set would be worse than a hard stop.
      throw new FixtureError(
        FIXTURE_ERROR_CODES.NETWORK_NOT_TESTNET,
        `The testnet fixture manager refuses to run on network "${this.config.network}". ` +
          'Set NETWORK=testnet. No account was created or funded.',
      );
    }

    const balanceXlm = options.balanceXlm ?? DEFAULT_FIXTURE_BALANCE_XLM;
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    const retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 250);

    if (!Number.isFinite(balanceXlm) || balanceXlm <= 0) {
      throw new FixtureError(
        FIXTURE_ERROR_CODES.INVALID_FIXTURE_NAME,
        `Target balance must be a positive number of XLM, received ${balanceXlm}`,
      );
    }

    const startedAt = Date.now();
    const accounts: FixtureAccount[] = [];
    const failures: FixtureRunResult['failures'] = [];

    // De-duplicate on the *normalized* name, not the raw string: `alice`,
    // `Alice` and ` alice ` all derive the same account, so keying on the raw
    // input would resolve one account three times and report it three times.
    // Invalid names are kept so each one still surfaces its own failure.
    const requested = new Map<string, string>();
    for (const name of names) {
      try {
        const canonical = this.resolveAccountId(name);
        if (!requested.has(canonical)) {
          requested.set(canonical, name);
        }
      } catch {
        requested.set(`invalid:${name}`, name);
      }
    }

    for (const name of requested.values()) {
      const accountStartedAt = Date.now();
      try {
        const publicKey = this.resolveAccountId(name);
        const account = await this.ensureAccount(publicKey, name, balanceXlm, {
          maxAttempts,
          retryBaseDelayMs,
        });

        accounts.push(account);
        this.metrics.recordTestnetFixture(account.status, (Date.now() - accountStartedAt) / 1000);
      } catch (error) {
        const code =
          error instanceof FixtureError ? error.code : FIXTURE_ERROR_CODES.DEPENDENCY_UNAVAILABLE;
        const message = error instanceof Error ? error.message : String(error);

        failures.push({ name, code, message });
        this.metrics.recordTestnetFixture('failed');
        this.metrics.recordError('testnet_fixtures', code);
        this.logger.warn(`Fixture "${name}" failed: ${code} ${message}`);
      }
    }

    const durationMs = Date.now() - startedAt;
    this.logger.log(
      `Resolved ${accounts.length} testnet fixture(s) in ${durationMs}ms (${failures.length} failed)`,
    );

    return { network: 'testnet', accounts, failures, durationMs };
  }

  /**
   * Ensure a single account exists and is funded to at least `balanceXlm`.
   *
   * The read-then-act order is what makes the operation idempotent: an already
   * funded account short-circuits before any write is attempted, and the
   * post-funding re-read confirms the balance actually landed rather than
   * trusting the write's own success status.
   */
  private async ensureAccount(
    publicKey: string,
    name: string,
    balanceXlm: number,
    retry: { maxAttempts: number; retryBaseDelayMs: number },
  ): Promise<FixtureAccount> {
    const existing = await this.withRetry(
      () => this.horizon.loadAccount(publicKey),
      retry,
      publicKey,
    );

    const targetStroops = balanceXlm * STROOPS_PER_XLM;
    if (existing && existing.nativeBalance >= targetStroops) {
      return {
        name,
        publicKey,
        balanceXlm: existing.nativeBalance / STROOPS_PER_XLM,
        status: 'ready',
      };
    }

    await this.withRetry(() => this.horizon.fundTestnetAccount(publicKey), retry, publicKey);

    // Re-read rather than assume: friendbot is eventually consistent, and a
    // fixture reporting success without a confirmed balance produces a far more
    // confusing failure later, inside the test that actually needed the funds.
    const funded = await this.withRetry(() => this.horizon.loadAccount(publicKey), retry, publicKey);
    const balance = funded?.nativeBalance ?? null;
    const fundedEnough = balance !== null && balance >= targetStroops;

    if (balance === null) {
      throw new FixtureError(
        FIXTURE_ERROR_CODES.FUNDING_FAILED,
        `Funded ${publicKey} but its balance could not be read back`,
      );
    }

    return {
      name,
      publicKey,
      balanceXlm: balance / STROOPS_PER_XLM,
      status: fundedEnough ? (existing ? 'topped_up' : 'created') : 'underfunded',
    };
  }

  /**
   * Run `operation` with bounded exponential backoff.
   *
   * Only transport-level failures are retried. A 4xx from friendbot means the
   * request itself is wrong, and retrying it just multiplies the failure.
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    retry: { maxAttempts: number; retryBaseDelayMs: number },
    publicKey: string,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (isHttpClientError(error)) {
          break;
        }

        this.metrics.recordError('testnet_fixtures', 'horizon_retry');
        if (attempt < retry.maxAttempts && retry.retryBaseDelayMs > 0) {
          await delay(retry.retryBaseDelayMs * 2 ** (attempt - 1));
        }
      }
    }

    throw new FixtureError(
      FIXTURE_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
      `Horizon request for ${publicKey} failed after ${retry.maxAttempts} attempt(s)`,
      { cause: lastError },
    );
  }
}

/**
 * Default {@link FixtureHorizon} backed by a real Horizon server.
 *
 * Split out so the manager's decision logic can be tested exhaustively without a
 * network, and so the one place that performs I/O is obvious in review.
 */
class HorizonFixtureClient implements FixtureHorizon {
  private readonly server: Horizon.Server;

  constructor(
    horizonUrl: string,
    private readonly friendbotUrl: string = FRIENDBOT_URL,
  ) {
    this.server = new Horizon.Server(horizonUrl);
  }

  async loadAccount(publicKey: string): Promise<{ nativeBalance: number } | null> {
    assertValidAccountId(publicKey);

    try {
      const account = await this.server.loadAccount(publicKey);
      const balance = account.balances?.find((entry) => entry.asset_type === 'native');
      // `balance` is a string of stroops in the Horizon payload.
      return { nativeBalance: Number(balance?.balance ?? '0') };
    } catch (error) {
      // 404 is the expected "not created yet" answer, not a failure.
      if (extractStatus(error) === 404) {
        return null;
      }
      throw error;
    }
  }

  async fundTestnetAccount(publicKey: string): Promise<void> {
    assertValidAccountId(publicKey);

    const response = await fetch(
      `${this.friendbotUrl}/?addr=${encodeURIComponent(publicKey)}`,
    );
    if (!response.ok) {
      throw new Error(`friendbot responded ${response.status} for ${publicKey}`);
    }
  }
}

function assertValidAccountId(publicKey: string): void {
  if (!isValidAccountId(publicKey)) {
    throw new FixtureError(
      FIXTURE_ERROR_CODES.INVALID_ACCOUNT_ID,
      `"${publicKey}" is not a valid Stellar account id`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A 4xx (other than 404) means the request is wrong, so retrying cannot help.
 * 408 and 429 are the exceptions: both are explicitly retryable.
 */
function isHttpClientError(error: unknown): boolean {
  const status = extractStatus(error);
  if (status === null) {
    return false;
  }
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function extractStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [candidate.status, candidate.statusCode, candidate.response?.status]) {
    if (typeof value === 'number') {
      return value;
    }
  }
  return null;
}
