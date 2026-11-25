import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';

import { AppConfigService } from '../config';
import { AuditService } from '../audit/audit.service';
import { PreviewScopeService } from '../preview-scope/preview-scope.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  FeatureFlagEvaluationContext,
  FeatureFlagEvaluationResult,
  FeatureFlagRecord,
  FeatureFlagSnapshotEntryDto,
  FeatureFlagSnapshotMetadataDto,
  FeatureFlagSnapshotResponseDto,
  FeatureFlagsListResponse,
  UpdateFeatureFlagDto,
} from './feature-flags.dto';

type CacheState = {
  flags: FeatureFlagRecord[];
  source: 'store' | 'bootstrap' | 'cache';
  storeAvailable: boolean;
  expiresAt: number;
};

/**
 * Environment-level deployment hold. While `frozen` is true, automatic
 * production promotion is blocked for the environment. Validation workflows
 * are unaffected.
 */
export type DeployFreezeState = {
  environment: string;
  frozen: boolean;
  reason: string | null;
  actor: string | null;
  frozenAt: string | null;
  overrideId: string | null;
  /** Increments on every clear so in-flight runs started before it are not resumed. */
  freezeGeneration: number;
};

export type DeployFreezeStatus = DeployFreezeState & {
  /** Generation a promotion run must have started at to be eligible to resume. */
  eligibleGeneration: number;
};

export type DeployFreezeOverrideResult = {
  environment: string;
  overrideId: string;
  actor: string;
  reason: string;
  timestamp: string;
  freezeGeneration: number;
};

const DEFAULT_FLAGS: FeatureFlagRecord[] = [
  // ── Network safety gates (BE-31) ──────────────────────────────────────────
  // Safe default: disabled. Must be explicitly enabled by an admin on mainnet.
  {
    key: 'mainnet.refunds',
    name: 'Mainnet Refunds',
    description: 'Allows refund initiation on mainnet.',
    enabled: false,
    killSwitch: false,
    rolloutPercentage: 0,
    allowedUsers: [],
    environments: ['production'],
    metadata: { highRisk: true, flow: 'refunds' },
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'bootstrap',
  },
  {
    key: 'mainnet.dispute_actions',
    name: 'Mainnet Dispute Actions',
    description: 'Allows escrow dispute actions on mainnet.',
    enabled: false,
    killSwitch: false,
    rolloutPercentage: 0,
    allowedUsers: [],
    environments: ['production'],
    metadata: { highRisk: true, flow: 'dispute_actions' },
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'bootstrap',
  },
  {
    key: 'mainnet.contract_writes',
    name: 'Mainnet Contract Writes',
    description: 'Allows Soroban contract write operations on mainnet.',
    enabled: false,
    killSwitch: false,
    rolloutPercentage: 0,
    allowedUsers: [],
    environments: ['production'],
    metadata: { highRisk: true, flow: 'contract_writes' },
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'bootstrap',
  },
  {
    key: 'mainnet.operator_replay',
    name: 'Mainnet Operator Replay',
    description:
      'Allows operators to replay failed notification and webhook deliveries on ' +
      'mainnet. Replay re-sends a customer notification, so it is disabled by ' +
      'default and must be enabled deliberately.',
    enabled: false,
    killSwitch: false,
    rolloutPercentage: 0,
    allowedUsers: [],
    environments: ['production'],
    metadata: { highRisk: true, flow: 'operator_replay', network: 'mainnet' },
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'bootstrap',
  },
  // ── API compatibility gate ───────────────────────────────────────────────
  // Safe default: disabled on mainnet (production), enabled on development/test.
  {
    key: 'api.compatibility_gate',
    name: 'API Compatibility Gate',
    description:
      'Enforces API version compatibility checks on incoming requests. ' +
      'Disabled by default on mainnet and enabled on development/test.',
    enabled: true,
    killSwitch: false,
    rolloutPercentage: 100,
    allowedUsers: [],
    environments: ['development', 'test'],
    metadata: { highRisk: false, flow: 'api_compatibility', network: 'testnet' },
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'bootstrap',
  },
  // ── Governance flags (issues #306, #307) ─────────────────────────────────
  // Enabled on local/test only: mainnet enforcement requires the policy review
  // sign-off recorded in docs/policies/*.json (defaultDisabledNetworks).
  {
    key: 'assets.listing_policy',
    name: 'Asset Listing Policy Enforcement',
    description: 'Filters the served asset list by the published asset listing policy.',
    enabled: true,
    killSwitch: false,
    rolloutPercentage: 100,
    allowedUsers: [],
    environments: ['development', 'test'],
    metadata: { highRisk: false, flow: 'asset_listing', policy: 'quickex.asset-listing', network: 'testnet' },
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'bootstrap',
  },
  {
    key: 'assets.listing_decisions',
    name: 'Asset Listing Decisions',
    description: 'Allows governed list/suspend/delist/re-list decisions via the admin API.',
    enabled: true,
    killSwitch: false,
    rolloutPercentage: 100,
    allowedUsers: [],
    environments: ['development', 'test'],
    metadata: { highRisk: true, flow: 'asset_listing', policy: 'quickex.asset-listing', network: 'testnet' },
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'bootstrap',
  },
  {
    key: 'privacy.deletion_requests',
    name: 'Privacy Deletion Requests',
    description: 'Enables signed proof-of-control deletion request intake.',
    enabled: true,
    killSwitch: false,
    rolloutPercentage: 100,
    allowedUsers: [],
    environments: ['development', 'test'],
    metadata: { highRisk: false, flow: 'privacy', policy: 'quickex.data-retention', network: 'testnet' },
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'bootstrap',
  },
  {
    key: 'privacy.retention_sweep',
    name: 'Privacy Retention Sweep',
    description: 'Enables the scheduled retention sweep and its admin trigger.',
    enabled: true,
    killSwitch: false,
    rolloutPercentage: 100,
    allowedUsers: [],
    environments: ['development', 'test'],
    metadata: { highRisk: true, flow: 'privacy', policy: 'quickex.data-retention', network: 'testnet' },
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'bootstrap',
  },
  // ── Existing flags ────────────────────────────────────────────────────────
  {
    key: 'testnet.contract_writes',
    name: 'Testnet Contract Writes',
    description: 'Allows Soroban contract write operations on testnet.',
    enabled: true,
    killSwitch: false,
    rolloutPercentage: 100,
    allowedUsers: [],
    environments: ['development', 'test', 'production'],
    metadata: { highRisk: true, flow: 'contract_writes', network: 'testnet' },
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'bootstrap',
  },
  {
    key: 'bulk_invoicing_v2',
    name: 'Bulk Invoicing v2',
    description: 'Enables templates, saved customers, and preview flow in bulk invoicing.',
    enabled: true,
    killSwitch: false,
    rolloutPercentage: 100,
    allowedUsers: [],
    environments: ['development', 'test', 'production'],
    metadata: { surface: 'generator' },
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'bootstrap',
  },
  {
    key: 'bulk_link_generation',
    name: 'Bulk Link Generation',
    description: 'Controls new bulk payment-link creation requests.',
    enabled: true,
    killSwitch: false,
    rolloutPercentage: 100,
    allowedUsers: [],
    environments: ['development', 'test', 'production'],
    metadata: { surface: 'links/bulk', riskyAction: true },
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'bootstrap',
  },
  // ── Username search ranking weights (issue #28) ───────────────────────────
  // Defaults: isFeatured and lastActiveAt have the highest priority.
  // Weights are relative (they are normalised internally before use).
  {
    key: 'username.ranking_weights',
    name: 'Username Search Ranking Weights',
    description:
      'Configurable weights for the username search ranking formula. ' +
      'Fields: similarity, transactionVolume, lastActiveAt, isFeatured. ' +
      'Weights are normalised to sum to 1 before scoring.',
    enabled: true,
    killSwitch: false,
    rolloutPercentage: 100,
    allowedUsers: [],
    environments: ['development', 'test', 'production'],
    metadata: {
      similarity: 1,
      transactionVolume: 0.5,
      lastActiveAt: 1,
      isFeatured: 2,
    },
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'bootstrap',
  },
  // ── Username key rotation ────────────────────────────────────────────────
  // Enabled on local/test only. Mainnet enablement requires operational sign-off
  // and review of key-rotation endpoint exposure at production scale.
  {
    key: 'username.key_rotation',
    name: 'Username Key Rotation',
    description:
      'Enables username key rotation endpoints. Disabled on mainnet by default ' +
      'and must be enabled deliberately after operational sign-off.',
    enabled: true,
    killSwitch: false,
    rolloutPercentage: 100,
    allowedUsers: [],
    environments: ['development', 'test'],
    metadata: { highRisk: true, flow: 'username_key_rotation', network: 'testnet' },
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'bootstrap',
  },
  // ── Username on-chain claim reconciliation (issue #193) ──────────────────
  // Enabled on local/test only. Mainnet enablement requires operational sign-off
  // and review of Horizon call volume at production scale.
  {
    key: 'username.claim_reconciliation',
    name: 'Username Claim Reconciliation',
    description:
      'Enables on-chain username claim reconciliation against Stellar Horizon. ' +
      'Flags claimed usernames whose owning Stellar account is no longer active.',
    enabled: true,
    killSwitch: false,
    rolloutPercentage: 100,
    allowedUsers: [],
    environments: ['development', 'test'],
    metadata: {
      batchSize: 50,
      retryMaxAttempts: 3,
      retryBaseMs: 500,
    },
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'bootstrap',
  },
  {
    key: 'merchant.payment_preferences',
    name: 'Merchant Payment Preferences',
    description:
      'Enables wallet-authorized accepted asset and settlement preference management on Stellar testnet. ' +
      'This setting never initiates or authorizes a payment or asset conversion.',
    enabled: true,
    killSwitch: false,
    rolloutPercentage: 100,
    allowedUsers: [],
    environments: ['development', 'test'],
    metadata: { highRisk: false, flow: 'merchant_payment_preferences', network: 'testnet' },
    updatedAt: new Date(0).toISOString(),
    updatedBy: 'bootstrap',
  },
];

@Injectable()
export class FeatureFlagsService {
  private readonly logger = new Logger(FeatureFlagsService.name);
  private cache: CacheState | null = null;
  private readonly deployFreezes = new Map<string, DeployFreezeState>();

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly configService: AppConfigService,
    private readonly auditService: AuditService,
    private readonly previewScopeService: PreviewScopeService,
  ) {}

  async listFlags(): Promise<FeatureFlagsListResponse> {
    const snapshot = await this.loadFlags();
    return {
      flags: snapshot.flags,
      source: snapshot.source,
      storeAvailable: snapshot.storeAvailable,
    };
  }

  async getFlagOrThrow(key: string): Promise<FeatureFlagRecord> {
    const { flags } = await this.loadFlags();
    const flag = flags.find((entry) => entry.key === key);
    if (!flag) {
      throw new NotFoundException(`Feature flag "${key}" not found`);
    }
    return flag;
  }

  async evaluateFlag(
    key: string,
    context: FeatureFlagEvaluationContext = {},
  ): Promise<FeatureFlagEvaluationResult> {
    const snapshot = await this.loadFlags();
    return this.evaluateFlagFromSnapshot(key, context, snapshot);
  }

  async evaluateFlagFresh(
    key: string,
    context: FeatureFlagEvaluationContext = {},
  ): Promise<FeatureFlagEvaluationResult> {
    const snapshot = await this.loadFlags(true);
    return this.evaluateFlagFromSnapshot(key, context, snapshot);
  }

  private evaluateFlagFromSnapshot(
    key: string,
    context: FeatureFlagEvaluationContext,
    snapshot: CacheState,
  ): FeatureFlagEvaluationResult {
    const flag = snapshot.flags.find((entry) => entry.key === key);

    if (!flag) {
      return {
        key,
        enabled: false,
        reason: 'missing-flag',
        source: snapshot.source,
      };
    }

    const environment = (context.environment ?? this.configService.nodeEnv).toLowerCase();
    const allowedEnvironments = flag.environments.map((value) => value.toLowerCase());

    if (flag.killSwitch) {
      return { key, enabled: false, reason: 'kill-switch', source: snapshot.source };
    }

    if (!flag.enabled) {
      return { key, enabled: false, reason: 'disabled', source: snapshot.source };
    }

    if (allowedEnvironments.length > 0 && !allowedEnvironments.includes(environment)) {
      return {
        key,
        enabled: false,
        reason: 'environment-mismatch',
        source: snapshot.source,
      };
    }

    const normalizedUserId = context.userId?.trim();
    if (normalizedUserId && flag.allowedUsers.includes(normalizedUserId)) {
      return {
        key,
        enabled: true,
        reason: 'allowlist-match',
        source: snapshot.source,
      };
    }

    if (flag.rolloutPercentage >= 100) {
      return { key, enabled: true, reason: 'enabled', source: snapshot.source };
    }

    if (flag.rolloutPercentage <= 0) {
      return { key, enabled: false, reason: 'rollout-miss', source: snapshot.source };
    }

    if (!normalizedUserId) {
      return {
        key,
        enabled: false,
        reason: 'missing-user-context',
        source: snapshot.source,
      };
    }

    const bucket = this.computeRolloutBucket(key, normalizedUserId);
    const enabled = bucket < flag.rolloutPercentage;
    return {
      key,
      enabled,
      reason: enabled ? 'rollout-match' : 'rollout-miss',
      source: snapshot.source,
    };
  }

  async assertActionEnabled(
    key: string,
    context: FeatureFlagEvaluationContext = {},
  ): Promise<void> {
    const evaluation = await this.evaluateFlag(key, context);
    if (!evaluation.enabled) {
      throw new ServiceUnavailableException({
        error: 'FEATURE_DISABLED',
        flag: key,
        reason: evaluation.reason,
        message: `Feature flag "${key}" is currently blocking this write action.`,
      });
    }
  }

  async updateFlag(
    key: string,
    patch: UpdateFeatureFlagDto,
    actor: string,
  ): Promise<FeatureFlagRecord> {
    const current = await this.getFlagOrThrow(key);
    const next: FeatureFlagRecord = {
      ...current,
      ...patch,
      allowedUsers: patch.allowedUsers?.map((value) => value.trim()).filter(Boolean) ?? current.allowedUsers,
      environments: patch.environments?.map((value) => value.trim()).filter(Boolean) ?? current.environments,
      metadata: patch.metadata ?? current.metadata,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    };

    try {
      const client = this.supabaseService.getClient();
      const { data, error } = await client
        .from('feature_flags')
        .upsert({
          key: next.key,
          name: next.name,
          description: next.description,
          enabled: next.enabled,
          kill_switch: next.killSwitch,
          rollout_percentage: next.rolloutPercentage,
          allowed_users: next.allowedUsers,
          environments: next.environments,
          metadata: next.metadata,
          updated_at: next.updatedAt,
          updated_by: next.updatedBy,
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      const persisted = this.mapRowToFlag(data);
      this.cache = {
        flags: this.upsertFlagInCollection((await this.loadFlags()).flags, persisted),
        source: 'store',
        storeAvailable: true,
        expiresAt: Date.now() + this.configService.featureFlagsCacheTtlMs,
      };

      return persisted;
    } catch (error) {
      this.logger.warn(
        `Feature flag store unavailable during update for ${key}: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException({
        error: 'FEATURE_FLAG_STORE_UNAVAILABLE',
        message: 'Feature flag store is unavailable; safe defaults remain active.',
      });
    }
  }

  // ── Deploy freeze ─────────────────────────────────────────────────────────

  private normalizeEnvironment(environment: string): string {
    const normalized = environment?.trim().toLowerCase();
    if (!normalized) {
      throw new BadRequestException({
        error: 'INVALID_ENVIRONMENT',
        message: 'An environment is required for deploy freeze operations.',
      });
    }
    return normalized;
  }

  private getFreezeState(environment: string): DeployFreezeState {
    const normalized = this.normalizeEnvironment(environment);
    const existing = this.deployFreezes.get(normalized);
    if (existing) {
      return existing;
    }
    return {
      environment: normalized,
      frozen: false,
      reason: null,
      actor: null,
      frozenAt: null,
      overrideId: null,
      freezeGeneration: 0,
    };
  }

  async setFreeze(
    environment: string,
    reason: string,
    actor: string,
  ): Promise<DeployFreezeState> {
    const normalized = this.normalizeEnvironment(environment);
    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
      throw new BadRequestException({
        error: 'FREEZE_REASON_REQUIRED',
        message: 'A reason is required to set a deploy freeze.',
      });
    }

    const previous = this.getFreezeState(normalized);
    const next: DeployFreezeState = {
      ...previous,
      frozen: true,
      reason: trimmedReason,
      actor,
      frozenAt: new Date().toISOString(),
      overrideId: null,
    };
    this.deployFreezes.set(normalized, next);

    await this.recordFreezeAudit('deploy_freeze.set', next, actor, trimmedReason);
    return { ...next };
  }

  async clearFreeze(environment: string, actor: string): Promise<DeployFreezeState> {
    const normalized = this.normalizeEnvironment(environment);
    const previous = this.getFreezeState(normalized);
    const next: DeployFreezeState = {
      ...previous,
      frozen: false,
      reason: null,
      actor,
      frozenAt: null,
      overrideId: null,
      freezeGeneration: previous.freezeGeneration + 1,
    };
    this.deployFreezes.set(normalized, next);

    await this.recordFreezeAudit(
      'deploy_freeze.clear',
      next,
      actor,
      previous.reason ?? 'freeze cleared',
    );
    return { ...next };
  }

  async isFrozen(environment: string): Promise<boolean> {
    return this.getFreezeState(environment).frozen;
  }

  async getFreezeStatus(environment: string): Promise<DeployFreezeStatus> {
    const state = this.getFreezeState(environment);
    return { ...state, eligibleGeneration: state.freezeGeneration };
  }

  /**
   * Authorized override of a deploy freeze. The override is logged and returns
   * an override id that must be presented by the promotion run.
   */
  async overrideFreeze(
    environment: string,
    reason: string,
    actor: string,
  ): Promise<DeployFreezeOverrideResult> {
    const normalized = this.normalizeEnvironment(environment);
    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
      throw new BadRequestException({
        error: 'OVERRIDE_REASON_REQUIRED',
        message: 'A reason is required to override a deploy freeze.',
      });
    }

    const state = this.getFreezeState(normalized);
    if (!state.frozen) {
      throw new BadRequestException({
        error: 'NOT_FROZEN',
        message: `Environment "${normalized}" is not frozen; no override is required.`,
      });
    }

    const timestamp = new Date().toISOString();
    const overrideId = createHash('sha256')
      .update(`${normalized}:${actor}:${timestamp}:${state.freezeGeneration}`)
      .digest('hex')
      .slice(0, 32);

    const next: DeployFreezeState = { ...state, overrideId };
    this.deployFreezes.set(normalized, next);

    await this.recordFreezeAudit(
      'deploy_freeze.override',
      next,
      actor,
      trimmedReason,
      { overrideId, timestamp },
    );

    return {
      environment: normalized,
      overrideId,
      actor,
      reason: trimmedReason,
      timestamp,
      freezeGeneration: next.freezeGeneration,
    };
  }

  /**
   * Gate for promotion. Returns true only when the environment is not frozen,
   * or when a valid override id is presented for the current freeze.
   */
  async assertPromotionAllowed(
    environment: string,
    options: { overrideId?: string } = {},
  ): Promise<void> {
    const state = this.getFreezeState(environment);
    if (!state.frozen) {
      return;
    }
    if (options.overrideId && state.overrideId && options.overrideId === state.overrideId) {
      return;
    }
    throw new ServiceUnavailableException({
      error: 'DEPLOY_FROZEN',
      environment: state.environment,
      reason: state.reason,
      frozenAt: state.frozenAt,
      message: `Deploy freeze is active for "${state.environment}"; promotion is blocked.`,
    });
  }

  /**
   * A promotion run is eligible to resume only if it started at or after the
   * current freeze generation. Runs started before a clear are not resumed.
   */
  async isRunEligibleToResume(environment: string, runGeneration: number): Promise<boolean> {
    const state = this.getFreezeState(environment);
    return runGeneration >= state.freezeGeneration;
  }

  private async recordFreezeAudit(
    action: string,
    state: DeployFreezeState,
    actor: string,
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.auditService.log({
        action,
        actor,
        resourceType: 'deploy_freeze',
        resourceId: state.environment,
        metadata: {
          environment: state.environment,
          frozen: state.frozen,
          reason,
          timestamp: new Date().toISOString(),
          freezeGeneration: state.freezeGeneration,
          ...extra,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to record deploy freeze audit entry (${action}) for ${state.environment}: ${(error as Error).message}`,
      );
    }
  }

  async getOperationalState(): Promise<{ source: string; storeAvailable: boolean; cacheExpiresAt: number | null }> {
    const snapshot = await this.loadFlags();
    return {
      source: snapshot.source,
      storeAvailable: snapshot.storeAvailable,
      cacheExpiresAt: this.cache?.expiresAt ?? null,
    };
  }

  async getSnapshot(
    environment?: string,
    previewScope?: string,
  ): Promise<FeatureFlagSnapshotResponseDto> {
    const snapshot = await this.loadFlags();

    const normalizedEnv = environment?.toLowerCase();
    const filtered = normalizedEnv
      ? snapshot.flags.filter((flag) => {
          const allowed = flag.environments.map((e) => e.toLowerCase());
          return allowed.length === 0 || allowed.includes(normalizedEnv);
        })
      : snapshot.flags;

    let previewScopeValid: boolean | undefined;
    if (previewScope) {
      try {
        previewScopeValid = await this.previewScopeService.isValidScope(previewScope);
      } catch {
        previewScopeValid = undefined;
      }
    }

    const sensitiveCount = filtered.filter((flag) => this.isSensitiveFlag(flag)).length;
    const visibleFlags = filtered.filter((flag) => !this.isSensitiveFlag(flag));

    const flags: FeatureFlagSnapshotEntryDto[] = visibleFlags.map((flag) => ({
      key: flag.key,
      name: flag.name,
      description: flag.description,
      enabled: flag.enabled,
      killSwitch: flag.killSwitch,
      rolloutPercentage: flag.rolloutPercentage,
      environments: flag.environments,
      updatedAt: flag.updatedAt,
      updatedBy: flag.updatedBy,
      previewOverrideActive: previewScope ? (previewScopeValid ?? undefined) : undefined,
    }));

    const metadata: FeatureFlagSnapshotMetadataDto = {
      source: snapshot.source,
      storeAvailable: snapshot.storeAvailable,
      environment: normalizedEnv,
      flagCount: flags.length,
      sensitiveFlagCount: sensitiveCount,
      timestamp: new Date().toISOString(),
      previewScope: previewScope ?? undefined,
      previewScopeValid: previewScope ? previewScopeValid : undefined,
    };

    return { metadata, flags };
  }

  private isSensitiveFlag(flag: FeatureFlagRecord): boolean {
    const meta = flag.metadata;
    if (!meta || typeof meta !== 'object') return false;
    return meta.internal === true || meta.sensitive === true;
  }

  private async loadFlags(forceRefresh = false): Promise<CacheState> {
    if (!forceRefresh && this.cache && this.cache.expiresAt > Date.now()) {
      return { ...this.cache, source: this.cache.source === 'store' ? 'cache' : this.cache.source };
    }

    const bootstrapFlags = this.getBootstrapFlags();

    try {
      const client = this.supabaseService.getClient();
      const { data, error } = await client.from('feature_flags').select('*').order('key');
      if (error) {
        throw error;
      }

      const storedFlags = (data ?? []).map((row) => this.mapRowToFlag(row));
      const mergedFlags = this.mergeFlags(bootstrapFlags, storedFlags);
      this.cache = {
        flags: mergedFlags,
        source: 'store',
        storeAvailable: true,
        expiresAt: Date.now() + this.configService.featureFlagsCacheTtlMs,
      };
      return this.cache;
    } catch (error) {
      this.logger.warn(
        `Falling back to bootstrap feature flags: ${(error as Error).message}`,
      );
      this.cache = {
        flags: bootstrapFlags,
        source: 'bootstrap',
        storeAvailable: false,
        expiresAt: Date.now() + this.configService.featureFlagsCacheTtlMs,
      };
      return this.cache;
    }
  }

  private getBootstrapFlags(): FeatureFlagRecord[] {
    const raw = this.configService.featureFlagsBootstrapJson;
    if (!raw) {
      return DEFAULT_FLAGS.map((flag) => ({ ...flag }));
    }

    try {
      const parsed = JSON.parse(raw) as Array<Partial<FeatureFlagRecord> & { key: string }>;
      return this.mergeFlags(
        DEFAULT_FLAGS,
        parsed.map((entry) => ({
          key: entry.key,
          name: entry.name ?? entry.key,
          description: entry.description ?? '',
          enabled: entry.enabled ?? false,
          killSwitch: entry.killSwitch ?? false,
          rolloutPercentage: this.normalizeRollout(entry.rolloutPercentage),
          allowedUsers: entry.allowedUsers ?? [],
          environments: entry.environments ?? [],
          metadata: entry.metadata ?? {},
          updatedAt: entry.updatedAt ?? new Date(0).toISOString(),
          updatedBy: entry.updatedBy ?? 'bootstrap',
        })),
      );
    } catch (error) {
      this.logger.warn(
        `Invalid FEATURE_FLAGS_BOOTSTRAP_JSON; using defaults: ${(error as Error).message}`,
      );
      return DEFAULT_FLAGS.map((flag) => ({ ...flag }));
    }
  }

  private mergeFlags(
    bootstrapFlags: FeatureFlagRecord[],
    storedFlags: FeatureFlagRecord[],
  ): FeatureFlagRecord[] {
    const index = new Map<string, FeatureFlagRecord>();
    for (const flag of bootstrapFlags) {
      index.set(flag.key, { ...flag });
    }
    for (const flag of storedFlags) {
      index.set(flag.key, { ...flag });
    }
    return Array.from(index.values()).sort((left, right) => left.key.localeCompare(right.key));
  }

  private mapRowToFlag(row: Record<string, unknown>): FeatureFlagRecord {
    return {
      key: String(row.key),
      name: String(row.name ?? row.key),
      description: String(row.description ?? ''),
      enabled: Boolean(row.enabled),
      killSwitch: Boolean(row.kill_switch),
      rolloutPercentage: this.normalizeRollout(row.rollout_percentage),
      allowedUsers: Array.isArray(row.allowed_users)
        ? row.allowed_users.map((value) => String(value))
        : [],
      environments: Array.isArray(row.environments)
        ? row.environments.map((value) => String(value))
        : [],
      metadata:
        row.metadata && typeof row.metadata === 'object'
          ? (row.metadata as Record<string, unknown>)
          : {},
      updatedAt: String(row.updated_at ?? new Date(0).toISOString()),
      updatedBy: String(row.updated_by ?? 'system'),
    };
  }

  private upsertFlagInCollection(
    flags: FeatureFlagRecord[],
    next: FeatureFlagRecord,
  ): FeatureFlagRecord[] {
    const remaining = flags.filter((flag) => flag.key !== next.key);
    remaining.push(next);
    return remaining.sort((left, right) => left.key.localeCompare(right.key));
  }

  private computeRolloutBucket(key: string, userId: string): number {
    const hash = createHash('sha256').update(`${key}:${userId}`).digest('hex');
    return parseInt(hash.slice(0, 8), 16) % 100;
  }

  private normalizeRollout(value: unknown): number {
    const numeric = Number(value);
    if (Number.isNaN(numeric)) {
      return 0;
    }
    return Math.max(0, Math.min(100, numeric));
  }
}
