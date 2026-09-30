import { AppConfigService } from '../config';
import { MetricsService } from '../metrics/metrics.service';
import { deriveFixtureAccountId, isValidAccountId } from './fixture-derivation';
import { FIXTURE_ERROR_CODES, FixtureError } from './fixture.types';
import { FixtureHorizon, TestnetFixtureManager } from './testnet-fixture.manager';

const STROOPS_PER_XLM = 10_000_000;

/**
 * A scriptable Horizon double.
 *
 * Every state transition is explicit so a test can assert not just the outcome
 * but which calls were made, which is how idempotency is proven: a second run
 * must issue no `fundTestnetAccount` call at all.
 */
class FakeHorizon implements FixtureHorizon {
  readonly fundCalls: string[] = [];
  readonly loadCalls: string[] = [];

  constructor(
    private readonly accounts: Map<string, number> = new Map(),
    private readonly behaviour: {
      loadError?: (publicKey: string, attempt: number) => unknown;
      fundError?: (publicKey: string, attempt: number) => unknown;
      fundAmountStroops?: number;
    } = {},
  ) {}

  private attempts = new Map<string, number>();

  private nextAttempt(key: string): number {
    const next = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, next);
    return next;
  }

  async loadAccount(publicKey: string): Promise<{ nativeBalance: number } | null> {
    this.loadCalls.push(publicKey);
    const error = this.behaviour.loadError?.(publicKey, this.nextAttempt(`load:${publicKey}`));
    if (error) {
      throw error;
    }
    const balance = this.accounts.get(publicKey);
    return balance === undefined ? null : { nativeBalance: balance };
  }

  async fundTestnetAccount(publicKey: string): Promise<void> {
    this.fundCalls.push(publicKey);
    const error = this.behaviour.fundError?.(publicKey, this.nextAttempt(`fund:${publicKey}`));
    if (error) {
      throw error;
    }
    this.accounts.set(publicKey, this.behaviour.fundAmountStroops ?? 100 * STROOPS_PER_XLM);
  }

  /** Pre-seed an existing account, simulating a previous run. */
  seed(publicKey: string, balanceXlm: number): this {
    this.accounts.set(publicKey, balanceXlm * STROOPS_PER_XLM);
    return this;
  }
}

/**
 * Build a manager directly against the Horizon double.
 *
 * The manager takes its Horizon client as an optional constructor argument
 * precisely so the decision logic is testable without a network; instantiating
 * it here keeps the test honest about that seam rather than relying on Nest's
 * provider resolution to pick the right token.
 */
function buildManager(
  horizon: FixtureHorizon,
  network: 'testnet' | 'mainnet' = 'testnet',
): TestnetFixtureManager {
  const config = {
    network,
    isTestnet: network === 'testnet',
    isMainnet: network === 'mainnet',
  } as AppConfigService;
  const metrics = {
    recordTestnetFixture: jest.fn(),
    recordError: jest.fn(),
  } as unknown as MetricsService;

  return new TestnetFixtureManager(config, metrics, horizon);
}

describe('TestnetFixtureManager', () => {
  describe('network containment', () => {
    it('refuses to run on mainnet and touches no account', async () => {
      const horizon = new FakeHorizon();
      const manager = buildManager(horizon, 'mainnet');

      await expect(manager.ensureFixtures(['alice'])).rejects.toMatchObject({
        code: FIXTURE_ERROR_CODES.NETWORK_NOT_TESTNET,
      });

      // The guard must run before any I/O, not merely report an error after it.
      expect(horizon.loadCalls).toHaveLength(0);
      expect(horizon.fundCalls).toHaveLength(0);
    });
  });

  describe('determinism', () => {
    it('derives the same account id for the same fixture name', () => {
      expect(deriveFixtureAccountId('alice')).toBe(deriveFixtureAccountId('alice'));
    });

    it('normalizes case and surrounding whitespace to one fixture', () => {
      expect(deriveFixtureAccountId('Alice')).toBe(deriveFixtureAccountId('  alice  '));
    });

    it('derives a distinct account per fixture name', () => {
      expect(deriveFixtureAccountId('alice')).not.toBe(deriveFixtureAccountId('bob'));
    });

    it('produces a valid Stellar account id', () => {
      expect(isValidAccountId(deriveFixtureAccountId('alice'))).toBe(true);
    });

    it('rejects a fixture name outside the allowed alphabet', () => {
      expect(() => deriveFixtureAccountId('Alice Smith')).toThrow(/lowercase/);
      expect(() => deriveFixtureAccountId('../etc/passwd')).toThrow();
      expect(() => deriveFixtureAccountId('')).toThrow();
    });

    it('surfaces an invalid name as a stable error code', async () => {
      const manager = buildManager(new FakeHorizon());
      const result = await manager.ensureFixtures(['Not A Name']);

      expect(result.accounts).toHaveLength(0);
      expect(result.failures).toEqual([
        expect.objectContaining({ code: FIXTURE_ERROR_CODES.INVALID_FIXTURE_NAME }),
      ]);
    });
  });

  describe('funding', () => {
    it('creates and funds an account that does not yet exist', async () => {
      const horizon = new FakeHorizon();
      const manager = buildManager(horizon);

      const result = await manager.ensureFixtures(['alice'], { balanceXlm: 50 });

      expect(result.failures).toEqual([]);
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0]).toMatchObject({
        name: 'alice',
        publicKey: deriveFixtureAccountId('alice'),
        status: 'created',
      });
      expect(result.accounts[0].balanceXlm).toBe(100);
      expect(horizon.fundCalls).toEqual([deriveFixtureAccountId('alice')]);
    });

    it('is idempotent: a funded account is not funded again', async () => {
      const horizon = new FakeHorizon();
      const manager = buildManager(horizon);

      await manager.ensureFixtures(['alice'], { balanceXlm: 50 });
      const firstRunFunds = horizon.fundCalls.length;

      const second = await manager.ensureFixtures(['alice'], { balanceXlm: 50 });

      expect(horizon.fundCalls).toHaveLength(firstRunFunds);
      expect(second.accounts[0].status).toBe('ready');
    });

    it('tops up an existing account that is below the target balance', async () => {
      const publicKey = deriveFixtureAccountId('alice');
      const horizon = new FakeHorizon().seed(publicKey, 1);
      const manager = buildManager(horizon);

      const result = await manager.ensureFixtures(['alice'], { balanceXlm: 50 });

      expect(result.accounts[0].status).toBe('topped_up');
      expect(horizon.fundCalls).toEqual([publicKey]);
    });

    it('reports underfunded rather than claiming success when the balance falls short', async () => {
      const horizon = new FakeHorizon(new Map(), { fundAmountStroops: 1 * STROOPS_PER_XLM });
      const manager = buildManager(horizon);

      const result = await manager.ensureFixtures(['alice'], { balanceXlm: 500 });

      // A fixture that silently reported success here would fail much later,
      // inside the test that actually needed the funds.
      expect(result.accounts[0].status).toBe('underfunded');
      expect(result.accounts[0].balanceXlm).toBe(1);
    });

    it('de-duplicates repeated fixture names so the report is honest', async () => {
      const horizon = new FakeHorizon();
      const manager = buildManager(horizon);

      const result = await manager.ensureFixtures(['alice', 'alice', 'ALICE']);

      expect(result.accounts).toHaveLength(1);
      expect(horizon.fundCalls).toHaveLength(1);
    });
  });

  describe('validation', () => {
    it('rejects a non-positive or non-finite target balance', async () => {
      const manager = buildManager(new FakeHorizon());

      await expect(manager.ensureFixtures(['alice'], { balanceXlm: 0 })).rejects.toBeInstanceOf(
        FixtureError,
      );
      await expect(manager.ensureFixtures(['alice'], { balanceXlm: -5 })).rejects.toBeInstanceOf(
        FixtureError,
      );
      await expect(
        manager.ensureFixtures(['alice'], { balanceXlm: Number.POSITIVE_INFINITY }),
      ).rejects.toBeInstanceOf(FixtureError);
    });
  });

  describe('dependency failure and retry', () => {
    it('retries a transient Horizon error and succeeds', async () => {
      const publicKey = deriveFixtureAccountId('alice');
      const horizon = new FakeHorizon(new Map(), {
        loadError: (_key, attempt) => (attempt === 1 ? Object.assign(new Error('reset'), { status: 503 }) : undefined),
      });
      const manager = buildManager(horizon);

      const result = await manager.ensureFixtures(['alice'], {
        retryBaseDelayMs: 0,
        maxAttempts: 3,
      });

      expect(result.failures).toEqual([]);
      expect(result.accounts[0].publicKey).toBe(publicKey);
    });

    it('gives up with a stable dependency code once the retry budget is spent', async () => {
      const horizon = new FakeHorizon(new Map(), {
        loadError: () => Object.assign(new Error('reset'), { status: 503 }),
      });
      const manager = buildManager(horizon);

      const result = await manager.ensureFixtures(['alice'], {
        retryBaseDelayMs: 0,
        maxAttempts: 2,
      });

      expect(result.accounts).toHaveLength(0);
      expect(result.failures[0].code).toBe(FIXTURE_ERROR_CODES.DEPENDENCY_UNAVAILABLE);
    });

    it('does not retry a 4xx, because the request itself is wrong', async () => {
      const horizon = new FakeHorizon(new Map(), {
        fundError: () => Object.assign(new Error('bad request'), { status: 400 }),
      });
      const manager = buildManager(horizon);

      const result = await manager.ensureFixtures(['alice'], {
        retryBaseDelayMs: 0,
        maxAttempts: 5,
      });

      expect(horizon.fundCalls).toHaveLength(1);
      expect(result.failures[0].code).toBe(FIXTURE_ERROR_CODES.DEPENDENCY_UNAVAILABLE);
    });

    it('treats a 429 as retryable', async () => {
      const horizon = new FakeHorizon(new Map(), {
        fundError: (_key, attempt) =>
          attempt === 1 ? Object.assign(new Error('slow down'), { status: 429 }) : undefined,
      });
      const manager = buildManager(horizon);

      const result = await manager.ensureFixtures(['alice'], { retryBaseDelayMs: 0 });

      expect(horizon.fundCalls).toHaveLength(2);
      expect(result.failures).toEqual([]);
    });

    it('keeps resolving the rest of the set when one account fails', async () => {
      const good = deriveFixtureAccountId('alice');
      const horizon = new FakeHorizon();
      const original = horizon.loadAccount.bind(horizon);
      jest.spyOn(horizon, 'loadAccount').mockImplementation(async (publicKey: string) => {
        if (publicKey === deriveFixtureAccountId('broken')) {
          throw Object.assign(new Error('boom'), { status: 503 });
        }
        return original(publicKey);
      });
      const manager = buildManager(horizon);

      const result = await manager.ensureFixtures(['broken', 'alice'], {
        retryBaseDelayMs: 0,
        maxAttempts: 1,
      });

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].name).toBe('broken');
      expect(result.accounts.map((account) => account.publicKey)).toEqual([good]);
    });
  });

  describe('observability', () => {
    it('records a bounded status label and never the fixture name', async () => {
      const metrics = { recordTestnetFixture: jest.fn(), recordError: jest.fn() };
      const config = {
        network: 'testnet',
        isTestnet: true,
        isMainnet: false,
      } as AppConfigService;
      const manager = new TestnetFixtureManager(
        config,
        metrics as unknown as MetricsService,
        new FakeHorizon(),
      );

      await manager.ensureFixtures(['alice']);

      expect(metrics.recordTestnetFixture).toHaveBeenCalledWith('created', expect.any(Number));
      // A fixture name as a label value would grow the registry without bound.
      expect(JSON.stringify(metrics.recordTestnetFixture.mock.calls)).not.toContain('alice');
    });

    it('never returns a secret seed in the run result', async () => {
      const manager = buildManager(new FakeHorizon());
      const result = await manager.ensureFixtures(['alice']);

      // `S...` is the Stellar secret-key prefix; a leak here would hand over a
      // signing key for the fixture account.
      expect(JSON.stringify(result)).not.toMatch(/"S[A-Z2-7]{55}"/);
    });

    it('reports a wall-clock duration for the run', async () => {
      const manager = buildManager(new FakeHorizon());
      const result = await manager.ensureFixtures(['alice']);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.network).toBe('testnet');
    });
  });
});
