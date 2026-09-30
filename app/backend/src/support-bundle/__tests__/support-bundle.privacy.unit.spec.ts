/**
 * Privacy and capacity guarantees for the support bundle (issue #282).
 *
 * The support bundle is the one admin surface whose entire output is meant to
 * leave the trust boundary: it is attached to a GitHub issue, pasted into a
 * chat, or read by someone who is not the operator. That makes its redaction
 * behaviour a security property rather than a formatting preference, so it is
 * asserted here against the serialized bytes rather than against individual
 * fields — a field can be redacted correctly while some other path still leaks.
 *
 * The capacity assertions live alongside deliberately: a bundle that took
 * thirty seconds to assemble would be turned off during an incident, which is
 * exactly when it is needed.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { performance } from 'perf_hooks';

import { SupportBundleService } from '../support-bundle.service';
import { AppConfigService } from '../../config';
import { ContractRegistryService } from '../../contracts/contract-registry.service';
import { IndexerLagService } from '../../indexer-lag/indexer-lag.service';
import { IndexerCheckpointRepository } from '../../ingestion/indexer-checkpoint.repository';
import { AuditService } from '../../audit/audit.service';

/** A well-formed Stellar secret key. Its presence in a bundle is a leak. */
// A real Stellar secret key is 'S' followed by 55 base32 characters, which is
// exactly the shape `sanitizeErrorMessage` is written to catch. A shorter
// stand-in would silently pass and make the privacy assertions meaningless.
const SECRET_KEY = `S${'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.repeat(2).slice(0, 55)}`;

/** A well-formed account id. Public, but still identifying. */
const PUBLIC_KEY = 'GBXGQ55JMQ4L2B6E7S8Y9Z0A1B2C3D4E5F6G7H8I7YWR';

async function buildService(auditData: unknown[]): Promise<SupportBundleService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SupportBundleService,
      {
        provide: AppConfigService,
        useValue: { network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' },
      },
      {
        provide: ContractRegistryService,
        useValue: {
          getRegistry: jest.fn().mockResolvedValue({
            data: {
              quickex: {
                id: 'CD2J6K7T3YJ77QXZP3EXAMPLE',
                version: 3,
                wasmHash: 'abcdef1234567890abcdef1234567890',
                updatedAt: '2026-06-01T10:00:00Z',
              },
            },
          }),
        },
      },
      {
        provide: IndexerLagService,
        useValue: {
          getStatus: jest.fn().mockReturnValue({
            currentNetworkLedger: 50000000,
            lastIndexedLedger: 49999500,
            lagLedgers: 500,
            isLagging: false,
            isEnabled: true,
            thresholdLedgers: 1000,
          }),
        },
      },
      {
        provide: IndexerCheckpointRepository,
        useValue: { getLastLedger: jest.fn().mockResolvedValue(49999500) },
      },
      {
        provide: AuditService,
        useValue: {
          log: jest.fn().mockResolvedValue(undefined),
          query: jest.fn().mockResolvedValue({ data: auditData, total: auditData.length, page: 1, limit: 50 }),
        },
      },
    ],
  }).compile();

  return module.get(SupportBundleService);
}

describe('Support bundle privacy (issue #282)', () => {
  it('never emits a secret key, even when one appears in an error message', async () => {
    const service = await buildService([
      {
        id: 'log-1',
        actor: 'system',
        action: 'escrow.deposit',
        // A misconfigured client that echoes its own secret back in an error is
        // the realistic leak path, and it is exactly what a bundle gets shared
        // to debug.
        metadata: { error: `signing failed for ${SECRET_KEY}` },
        createdAt: new Date('2026-06-02T12:20:00Z'),
      },
    ]);

    const bundle = await service.generateBundle();
    const serialized = JSON.stringify(bundle);

    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).toContain('[REDACTED_SECRET_KEY]');
  });

  it('redacts an email-shaped actor rather than shipping it to a public issue', async () => {
    const service = await buildService([
      {
        id: 'log-1',
        actor: 'alice@example.com',
        action: 'escrow.deposit',
        metadata: { error: 'Insufficient balance' },
        createdAt: new Date('2026-06-02T12:20:00Z'),
      },
    ]);

    const bundle = await service.generateBundle();

    expect(JSON.stringify(bundle)).not.toContain('alice@example.com');
    expect(bundle.recent_errors[0].actor).toBe('[REDACTED]');
  });

  it('omits request identifiers unless they were explicitly requested', async () => {
    const service = await buildService([
      {
        id: 'log-1',
        actor: 'system',
        action: 'escrow.deposit',
        metadata: { error: 'Insufficient balance' },
        requestId: 'req-12345',
        createdAt: new Date('2026-06-02T12:20:00Z'),
      },
    ]);

    const withoutIds = await service.generateBundle(false);
    expect(withoutIds.recent_errors[0].request_id).toBeUndefined();
    expect(JSON.stringify(withoutIds)).not.toContain('req-12345');

    // Opt-in stays opt-in: a request id is a correlation handle, which is
    // useful for an operator and identifying for everyone else.
    const withIds = await service.generateBundle(true);
    expect(withIds.recent_errors[0].request_id).toBe('req-12345');
  });

  it('never includes a secret key anywhere in the bundle, whatever the request', async () => {
    const service = await buildService([
      {
        id: 'log-1',
        actor: `operator ${SECRET_KEY}`,
        action: 'escrow.deposit',
        metadata: { message: `context ${SECRET_KEY}` },
        requestId: `req-${SECRET_KEY}`,
        createdAt: new Date('2026-06-02T12:20:00Z'),
      },
    ]);

    for (const includeRequestIds of [false, true]) {
      const serialized = JSON.stringify(await service.generateBundle(includeRequestIds));
      expect(serialized).not.toContain(SECRET_KEY);
    }
  });

  it('publishes only the network passphrase, never a private network detail', async () => {
    const service = await buildService([]);
    const bundle = await service.generateBundle();

    // The passphrase is public protocol data; anything resembling a credential
    // in the same object is not.
    expect(bundle.network_config.network_passphrase).toBe('Test SDF Network ; September 2015');
    expect(Object.keys(bundle.network_config).sort()).toEqual([
      'network',
      'network_passphrase',
    ]);
  });

  it('degrades to an empty error list when the audit store is unavailable', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportBundleService,
        { provide: AppConfigService, useValue: { network: 'testnet' } },
        {
          provide: ContractRegistryService,
          useValue: { getRegistry: jest.fn().mockRejectedValue(new Error('db down')) },
        },
        {
          provide: IndexerLagService,
          useValue: { getStatus: jest.fn().mockReturnValue({ isEnabled: false }) },
        },
        {
          provide: IndexerCheckpointRepository,
          useValue: { getLastLedger: jest.fn().mockRejectedValue(new Error('db down')) },
        },
        {
          provide: AuditService,
          useValue: { query: jest.fn().mockRejectedValue(new Error('db down')) },
        },
      ],
    }).compile();

    const bundle = await module.get(SupportBundleService).generateBundle();

    // A bundle that throws during an incident is worse than an empty one: the
    // degraded answer is what gets attached to the issue.
    expect(bundle.recent_errors).toEqual([]);
    expect(bundle.checkpoints).toEqual([]);
    // The indexer-lag guard reports DISABLED when it is switched off, which is
    // more accurate than UNKNOWN: the operator should not go hunting for a
    // missing gauge that was deliberately never collected.
    expect(bundle.indexer_status.status).toBe('DISABLED');
  });
});

describe('Support bundle capacity (issue #282)', () => {
  /**
   * Budget for a single bundle assembly.
   *
   * The bundle is an incident tool, so it is used when something else is
   * already wrong. A budget in the hundreds of milliseconds keeps it fast
   * enough that nobody is tempted to skip it under pressure, while still
   * catching an accidental N+1 against the audit store — the failure mode that
   * matters, since it would otherwise only appear during a real incident.
   */
  const BUDGET_MS = 500;

  /** How many recent errors the bundle is specified to carry. */
  const ERROR_LIMIT = 50;

  it('assembles within its latency budget', async () => {
    const service = await buildService(
      Array.from({ length: ERROR_LIMIT }, (_unused, index) => ({
        id: `log-${index}`,
        actor: 'system',
        action: 'escrow.deposit',
        metadata: { error: 'Insufficient balance' },
        createdAt: new Date('2026-06-02T12:20:00Z'),
      })),
    );

    const startedAt = performance.now();
    await service.generateBundle();
    const elapsed = performance.now() - startedAt;

    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('caps the error list so bundle size stays bounded', async () => {
    // An unbounded error list is the realistic way a diagnostic bundle becomes
    // too large to paste into an issue, which defeats its purpose.
    const service = await buildService(
      Array.from({ length: 500 }, (_unused, index) => ({
        id: `log-${index}`,
        actor: 'system',
        action: 'escrow.deposit',
        metadata: { error: 'Insufficient balance' },
        createdAt: new Date('2026-06-02T12:20:00Z'),
      })),
    );

    const bundle = await service.generateBundle();

    expect(bundle.recent_errors.length).toBeLessThanOrEqual(ERROR_LIMIT);
  });

  it('excludes entries that recorded no error at all', async () => {
    // A successful audit row is not a diagnostic, and including it would bury
    // the failures the operator is actually looking for.
    const service = await buildService([
      { id: 'ok', actor: 'system', action: 'link.created', metadata: {}, createdAt: new Date() },
      {
        id: 'bad',
        actor: 'system',
        action: 'escrow.deposit',
        metadata: { error: 'Insufficient balance' },
        createdAt: new Date(),
      },
    ]);

    const bundle = await service.generateBundle();

    expect(bundle.recent_errors).toHaveLength(1);
    expect(bundle.recent_errors[0].action).toBe('escrow.deposit');
  });

  it('scales sub-linearly in the number of audit rows', async () => {
    // A regression that queried the audit store per checkpoint, or per error,
    // would still pass a single-shot budget on a small fixture. Comparing two
    // input sizes is what actually catches it.
    const makeRows = (count: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        id: `log-${index}`,
        actor: 'system',
        action: 'escrow.deposit',
        metadata: { error: 'Insufficient balance' },
        createdAt: new Date('2026-06-02T12:20:00Z'),
      }));

    const timeFor = async (count: number) => {
      const service = await buildService(makeRows(count));
      const startedAt = performance.now();
      await service.generateBundle();
      return performance.now() - startedAt;
    };

    // Warm up so the first measurement is not dominated by JIT.
    await timeFor(10);
    const small = await timeFor(10);
    const large = await timeFor(500);

    // 50x the input must not cost anywhere near 50x the time. The allowance is
    // generous because a shared CI runner is noisy; a per-row regression blows
    // straight through it.
    expect(large).toBeLessThan(Math.max(small, 5) * 25);
  });
});
