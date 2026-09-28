import { Injectable, Logger } from '@nestjs/common';
import { Horizon } from '@stellar/stellar-sdk';
import { v4 as uuidv4 } from 'uuid';

import { AppConfigService } from '../config/app-config.service';
import { SupabaseService } from '../supabase/supabase.service';
import { MetricsService } from '../metrics/metrics.service';
import {
  DivergenceRecord,
  EscrowDbStatus,
  EscrowRecord,
  EscrowReconciliationResult,
  OnChainState,
  PaymentDbStatus,
  PaymentRecord,
  PaymentReconciliationResult,
  ReconciliationAction,
  ReconciliationReport,
  ReconciliationMetrics,
} from './types/reconciliation.types';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private readonly server: Horizon.Server;

  /** Statuses that need to be reconciled against the chain. */
  private readonly ACTIONABLE_ESCROW_STATUSES: EscrowDbStatus[] = [
    EscrowDbStatus.Pending,
    EscrowDbStatus.Active,
  ];

  private readonly ACTIONABLE_PAYMENT_STATUSES: PaymentDbStatus[] = [
    PaymentDbStatus.Pending,
    PaymentDbStatus.Processing,
  ];

  constructor(
    private readonly config: AppConfigService,
    private readonly supabase: SupabaseService,
    private readonly metrics: MetricsService,
  ) {
    const horizonUrl =
      config.network === 'mainnet'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org';

    this.server = new Horizon.Server(horizonUrl);
    this.logger.log(
      `ReconciliationService initialized against ${config.network} (${horizonUrl})`,
    );
  }

  // ---------------------------------------------------------------------------
  // Public entry point
  // ---------------------------------------------------------------------------

  async runReconciliation(batchSize: number): Promise<ReconciliationReport> {
    const runId = uuidv4();
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    this.logger.log(`[${runId}] Reconciliation run started (batchSize=${batchSize})`);

    const [escrowResults, paymentResults] = await Promise.all([
      this.reconcileEscrows(runId, batchSize),
      this.reconcilePayments(runId, batchSize),
    ]);

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;

    const report: ReconciliationReport = {
      runId,
      startedAt,
      completedAt,
      durationMs,
      escrows: this.summarise(escrowResults),
      payments: this.summarise(paymentResults),
    };

    const divergences = await this.detectDivergences(runId, batchSize);
    report.divergences = divergences;
    report.metrics = this.buildMetrics(report, divergences.length);
    report.divergence_rate = report.metrics.divergence_rate;
    report.auto_match_rate = report.metrics.auto_match_rate;

    // Add totals comparison for payments
    report.totalsComparison = await this.comparePaymentTotals(runId);

    // Generate alert if discrepancies exceed threshold
    report.alert = this.generateDiscrepancyAlert(report);

    if (typeof this.supabase.getClient === 'function') {
      const { error } = await this.supabase
        .getClient()
        .from('reconciliation_runs')
        .upsert(
          {
            run_id: report.runId,
            completed_at: report.completedAt,
            divergence_count: report.metrics?.total_divergences ?? 0,
            divergence_rate: report.divergence_rate ?? 0,
            report,
          },
          { onConflict: 'run_id' },
        );
      if (error) {
        this.logger.error(`Failed to persist reconciliation report: ${error.message}`);
      }
    }

    this.logReport(report);
    return report;
  }

  async getLatestReport(): Promise<ReconciliationReport | null> {
    const { data, error } = await this.supabase
      .getClient()
      .from('reconciliation_runs')
      .select('report')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load latest reconciliation report: ${error.message}`);
    }
    return (data?.report as ReconciliationReport | undefined) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Escrow reconciliation
  // ---------------------------------------------------------------------------

  private async reconcileEscrows(
    runId: string,
    batchSize: number,
  ): Promise<EscrowReconciliationResult[]> {
    const records = await this.supabase.fetchPendingEscrows(
      this.ACTIONABLE_ESCROW_STATUSES,
      batchSize,
    );

    this.logger.log(
      `[${runId}] Found ${records.length} escrow(s) to reconcile`,
    );

    const results: EscrowReconciliationResult[] = [];

    for (const record of records) {
      const result = await this.reconcileEscrow(runId, record);
      results.push(result);
    }

    return results;
  }

  private async reconcileEscrow(
    runId: string,
    record: EscrowRecord,
  ): Promise<EscrowReconciliationResult> {
    const base: Omit<EscrowReconciliationResult, 'onChainState' | 'resolvedDbStatus' | 'action' | 'irreconcilable' | 'irreconcilableReason'> = {
      id: record.id,
      contractAddress: record.contract_address,
      previousDbStatus: record.status,
    };

    let onChainState: OnChainState;
    try {
      onChainState = await this.resolveEscrowOnChainState(record);
    } catch (err) {
      this.logger.warn(
        `[${runId}] Skipping escrow ${record.id}: Horizon unavailable — ${(err as Error).message}`,
      );
      return {
        ...base,
        onChainState: OnChainState.Unknown,
        resolvedDbStatus: null,
        action: ReconciliationAction.Skipped,
        irreconcilable: false,
      };
    }

    return this.applyEscrowTransition(runId, record, onChainState, base);
  }

  /**
   * Resolves the authoritative on-chain state for an escrow account.
   *
   * Strategy:
   *  1. Load the Stellar account (contract_address).
   *  2. If the account does not exist → NonExistent.
   *  3. If the account exists, check whether the XLM balance is zero (merged indicator).
   *  4. Cross-check the DB `expires_at` field against wall-clock time.
   */
  private async resolveEscrowOnChainState(record: EscrowRecord): Promise<OnChainState> {
    const startTime = Date.now();
    try {
      const account = await this.server.loadAccount(record.contract_address);
      const duration = (Date.now() - startTime) / 1000;
      this.metrics.recordExternalCall('horizon', 'loadAccount', duration);

      // Check balance — a merged / swept account will have no native balance entry
      const nativeLine = (account.balances as Horizon.HorizonApi.BalanceLine[]).find(
        (b) => b.asset_type === 'native',
      );

      const nativeBalance = nativeLine ? parseFloat(nativeLine.balance) : 0;

      if (nativeBalance === 0) {
        // Account merged or all funds removed → treat as claimed
        return OnChainState.Claimed;
      }

      // Check expiry using DB field (Stellar doesn't natively expose time-bounds per-account)
      if (record.expires_at) {
        const expiresAt = new Date(record.expires_at).getTime();
        if (Date.now() > expiresAt) {
          return OnChainState.Expired;
        }
      }

      return OnChainState.Active;
    } catch (err: unknown) {
      const duration = (Date.now() - startTime) / 1000;
      this.metrics.recordExternalCall('horizon', 'loadAccount', duration);
      const errorType = err instanceof Error ? err.constructor.name : 'UnknownError';
      this.metrics.recordError('horizon', errorType);

      const horizonErr = err as { response?: { status?: number } };
      if (horizonErr?.response?.status === 404) {
        return OnChainState.NonExistent;
      }
      throw err; // Let the caller handle unexpected errors
    }
  }

  private async applyEscrowTransition(
    runId: string,
    record: EscrowRecord,
    onChainState: OnChainState,
    base: Omit<EscrowReconciliationResult, 'onChainState' | 'resolvedDbStatus' | 'action' | 'irreconcilable' | 'irreconcilableReason'>,
  ): Promise<EscrowReconciliationResult> {
    const { id, status: dbStatus } = record;

    // ── Transition table ─────────────────────────────────────────────────────
    // DB: pending | active  → chain says Claimed  → DB: claimed
    // DB: pending | active  → chain says Expired  → DB: expired
    // DB: pending | active  → chain says Active   → DB: no change (consistent)
    // DB: pending | active  → chain says NonExistent → irreconcilable (alert)
    // ─────────────────────────────────────────────────────────────────────────

    if (onChainState === OnChainState.Claimed) {
      await this.supabase.updateEscrowStatus(id, EscrowDbStatus.Claimed);
      this.logger.log(
        `[${runId}] Escrow ${id}: DB was '${dbStatus}' but chain is Claimed → updated to 'claimed'`,
      );
      return { ...base, onChainState, resolvedDbStatus: EscrowDbStatus.Claimed, action: ReconciliationAction.Updated, irreconcilable: false };
    }

    if (onChainState === OnChainState.Expired) {
      await this.supabase.updateEscrowStatus(id, EscrowDbStatus.Expired);
      this.logger.log(
        `[${runId}] Escrow ${id}: DB was '${dbStatus}' but chain indicates Expired → updated to 'expired'`,
      );
      return { ...base, onChainState, resolvedDbStatus: EscrowDbStatus.Expired, action: ReconciliationAction.Updated, irreconcilable: false };
    }

    if (onChainState === OnChainState.NonExistent) {
      const reason = `DB status is '${dbStatus}' but escrow account does not exist on-chain`;
      await this.supabase.flagIrreconcilableEscrow(id, reason);
      this.logger.error(
        `[${runId}] IRRECONCILABLE escrow ${id} (${record.contract_address}): ${reason}`,
      );
      return { ...base, onChainState, resolvedDbStatus: null, action: ReconciliationAction.Flagged, irreconcilable: true, irreconcilableReason: reason };
    }

    // Active on-chain and active in DB → consistent
    return { ...base, onChainState, resolvedDbStatus: dbStatus, action: ReconciliationAction.NoOp, irreconcilable: false };
  }

  // ---------------------------------------------------------------------------
  // Payment reconciliation
  // ---------------------------------------------------------------------------

  private async reconcilePayments(
    runId: string,
    batchSize: number,
  ): Promise<PaymentReconciliationResult[]> {
    const records = await this.supabase.fetchPendingPayments(
      this.ACTIONABLE_PAYMENT_STATUSES,
      batchSize,
    );

    this.logger.log(
      `[${runId}] Found ${records.length} payment(s) to reconcile`,
    );

    const results: PaymentReconciliationResult[] = [];

    for (const record of records) {
      const result = await this.reconcilePayment(runId, record);
      results.push(result);
    }

    return results;
  }

  private async reconcilePayment(
    runId: string,
    record: PaymentRecord,
  ): Promise<PaymentReconciliationResult> {
    const base: Omit<PaymentReconciliationResult, 'onChainState' | 'resolvedDbStatus' | 'action' | 'irreconcilable' | 'irreconcilableReason'> = {
      id: record.id,
      txHash: record.stellar_tx_hash,
      previousDbStatus: record.status,
    };

    let onChainState: OnChainState;
    try {
      onChainState = await this.resolvePaymentOnChainState(record.stellar_tx_hash);
    } catch (err) {
      this.logger.warn(
        `[${runId}] Skipping payment ${record.id}: Horizon unavailable — ${(err as Error).message}`,
      );
      return {
        ...base,
        onChainState: OnChainState.Unknown,
        resolvedDbStatus: null,
        action: ReconciliationAction.Skipped,
        irreconcilable: false,
      };
    }

    return this.applyPaymentTransition(runId, record, onChainState, base);
  }

  /**
   * Checks whether a transaction hash is confirmed on-chain via Horizon.
   */
  private async resolvePaymentOnChainState(txHash: string): Promise<OnChainState> {
    const startTime = Date.now();
    try {
      const tx = await this.server.transactions().transaction(txHash).call();
      const duration = (Date.now() - startTime) / 1000;
      this.metrics.recordExternalCall('horizon', 'getTransaction', duration);
      return tx.successful ? OnChainState.Confirmed : OnChainState.NonExistent;
    } catch (err: unknown) {
      const duration = (Date.now() - startTime) / 1000;
      this.metrics.recordExternalCall('horizon', 'getTransaction', duration);
      const errorType = err instanceof Error ? err.constructor.name : 'UnknownError';
      this.metrics.recordError('horizon', errorType);

      const horizonErr = err as { response?: { status?: number } };
      if (horizonErr?.response?.status === 404) {
        return OnChainState.NonExistent;
      }
      throw err;
    }
  }

  private async applyPaymentTransition(
    runId: string,
    record: PaymentRecord,
    onChainState: OnChainState,
    base: Omit<PaymentReconciliationResult, 'onChainState' | 'resolvedDbStatus' | 'action' | 'irreconcilable' | 'irreconcilableReason'>,
  ): Promise<PaymentReconciliationResult> {
    const { id, status: dbStatus } = record;

    // ── Transition table ─────────────────────────────────────────────────────
    // DB: pending | processing  → chain Confirmed     → DB: paid
    // DB: pending | processing  → chain NonExistent   → DB: failed  (irreconcilable if DB was 'paid')
    // DB: paid                  → chain NonExistent   → irreconcilable
    // ─────────────────────────────────────────────────────────────────────────

    if (onChainState === OnChainState.Confirmed) {
      if (dbStatus === PaymentDbStatus.Paid) {
        // Already consistent
        return { ...base, onChainState, resolvedDbStatus: PaymentDbStatus.Paid, action: ReconciliationAction.NoOp, irreconcilable: false };
      }
      await this.supabase.updatePaymentStatus(id, PaymentDbStatus.Paid);
      this.logger.log(
        `[${runId}] Payment ${id}: DB was '${dbStatus}' but chain confirms tx → updated to 'paid'`,
      );
      return { ...base, onChainState, resolvedDbStatus: PaymentDbStatus.Paid, action: ReconciliationAction.Updated, irreconcilable: false };
    }

    if (onChainState === OnChainState.NonExistent) {
      if (dbStatus === PaymentDbStatus.Paid) {
        const reason = `DB status is 'paid' but transaction ${record.stellar_tx_hash} not found on-chain`;
        await this.supabase.flagIrreconcilablePayment(id, reason);
        this.logger.error(
          `[${runId}] IRRECONCILABLE payment ${id}: ${reason}`,
        );
        return { ...base, onChainState, resolvedDbStatus: null, action: ReconciliationAction.Flagged, irreconcilable: true, irreconcilableReason: reason };
      }

      // pending/processing with no on-chain record — mark failed
      await this.supabase.updatePaymentStatus(id, PaymentDbStatus.Failed);
      this.logger.warn(
        `[${runId}] Payment ${id}: DB was '${dbStatus}' but tx not found on-chain → updated to 'failed'`,
      );
      return { ...base, onChainState, resolvedDbStatus: PaymentDbStatus.Failed, action: ReconciliationAction.Updated, irreconcilable: false };
    }

    // Unknown / skip
    return { ...base, onChainState, resolvedDbStatus: dbStatus, action: ReconciliationAction.NoOp, irreconcilable: false };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private summarise<T extends { action: ReconciliationAction; irreconcilable: boolean }>(
    results: T[],
  ) {
    return {
      processed: results.length,
      updated: results.filter((r) => r.action === ReconciliationAction.Updated).length,
      noOp: results.filter((r) => r.action === ReconciliationAction.NoOp).length,
      skipped: results.filter((r) => r.action === ReconciliationAction.Skipped).length,
      irreconcilable: results.filter((r) => r.irreconcilable).length,
      results,
    };
  }

  private normalizeAmountToBaseUnits(amount: string): bigint {
    const trimmed = amount.trim();
    if (!trimmed || trimmed === '0') {
      return 0n;
    }

    const [whole, fraction = ''] = trimmed.split('.');
    const sign = whole.startsWith('-') ? '-' : '';
    const normalizedWhole = sign ? whole.slice(1) : whole;
    const normalizedFraction = fraction.padEnd(7, '0').slice(0, 7);
    const digits = `${normalizedWhole || '0'}${normalizedFraction}`;
    return BigInt(`${sign}${digits}`);
  }

  private async observePaymentOnLedger(payment: PaymentRecord): Promise<
    | { kind: 'observed'; asset: string; amount: string }
    | { kind: 'missing' }
    | { kind: 'unresolved' }
  > {
    try {
      const tx = await this.server.transactions().transaction(payment.stellar_tx_hash).call();
      if (!tx.successful) return { kind: 'missing' };

      const response = await this.server
        .operations()
        .forTransaction(payment.stellar_tx_hash)
        .limit(200)
        .call();
      const records = (response as { records?: Array<Record<string, unknown>> }).records ?? [];
      const expectedAsset = payment.asset.trim();
      const matches = records.flatMap((operation) => {
        const type = String(operation.type ?? '');
        if (!['payment', 'path_payment_strict_send', 'path_payment_strict_receive'].includes(type)) return [];
        if (operation.from !== payment.from_address || operation.to !== payment.to_address) return [];

        const isPathPayment = type.startsWith('path_payment_');
        const assetType = String(operation[isPathPayment ? 'destination_asset_type' : 'asset_type'] ?? '');
        const assetCode = String(operation[isPathPayment ? 'destination_asset_code' : 'asset_code'] ?? '');
        const assetIssuer = String(operation[isPathPayment ? 'destination_asset_issuer' : 'asset_issuer'] ?? '');
        const observedAsset = assetType === 'native' ? 'XLM' : `${assetCode}:${assetIssuer}`;
        const assetMatches = expectedAsset === 'XLM'
          ? assetType === 'native'
          : observedAsset === expectedAsset;
        const amount = operation[isPathPayment ? 'destination_amount' : 'amount'];
        if (!assetMatches || typeof amount !== 'string') return [];
        return [{ asset: observedAsset, amount }];
      });

      if (matches.length !== 1) return { kind: 'unresolved' };
      return { kind: 'observed', ...matches[0] };
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 404) return { kind: 'missing' };
      this.metrics.recordError('horizon', error instanceof Error ? error.constructor.name : 'UnknownError');
      return { kind: 'unresolved' };
    }
  }

  private buildMetrics(report: ReconciliationReport, divergenceCount: number): ReconciliationMetrics {
    const processedTotal = (report.escrows.processed ?? 0) + (report.payments.processed ?? 0);
    const totalReviewed = Math.max(0, processedTotal - divergenceCount);
    const autoMatched = Math.max(0, (report.escrows.updated ?? 0) + (report.payments.updated ?? 0));

    return {
      divergence_rate: processedTotal > 0 ? divergenceCount / processedTotal : 0,
      auto_match_rate: processedTotal > 0 ? autoMatched / processedTotal : 0,
      total_divergences: divergenceCount,
      auto_matched: autoMatched,
      reviewed: totalReviewed,
    };
  }

  private async detectDivergences(runId: string, batchSize: number): Promise<DivergenceRecord[]> {
    const divergences: DivergenceRecord[] = [];

    try {
      const dbEscrows = await this.supabase.fetchAllEscrows();
      const dbPayments = await this.supabase.fetchAllPayments();
      const onChainEscrows = await Promise.all(
        dbEscrows.map(async (escrow) => {
          try {
            const account = await this.server.loadAccount(escrow.contract_address);
            const nativeLine = (account.balances as Horizon.HorizonApi.BalanceLine[]).find(
              (b) => b.asset_type === 'native',
            );
            const balance = nativeLine ? this.normalizeAmountToBaseUnits(nativeLine.balance) : 0n;
            return {
              contractAddress: escrow.contract_address,
              amount: escrow.amount,
              exists: true,
              balance,
              status: nativeLine && Number.parseFloat(nativeLine.balance) > 0 ? 'active' : 'claimed',
            };
          } catch (error) {
            const status = (error as { response?: { status?: number } })?.response?.status === 404 ? 'missing' : 'unknown';
            return {
              contractAddress: escrow.contract_address,
              amount: escrow.amount,
              exists: status !== 'missing',
              balance: 0n,
              status,
            };
          }
        }),
      );

      const escrowByAddress = new Map<string, EscrowRecord[]>();
      for (const escrow of dbEscrows) {
        const list = escrowByAddress.get(escrow.contract_address) ?? [];
        list.push(escrow);
        escrowByAddress.set(escrow.contract_address, list);
      }

      for (const [address, rows] of escrowByAddress) {
        if (rows.length > 1) {
          divergences.push({
            entity: 'escrow',
            type: 'duplicate',
            contractAddress: address,
            details: `Duplicate escrow records found for ${address}: ${rows.length} rows`,
          });
        }

        const expected = rows[0];
        const observed = onChainEscrows.find((record) => record.contractAddress === address);

        if (!observed) {
          if (rows.length > 0) {
            divergences.push({
              entity: 'escrow',
              type: 'missing',
              contractAddress: address,
              expectedAmount: expected.amount,
              details: `Escrow ${address} is missing from Horizon`,
            });
          }
          continue;
        }

        if (observed.status === 'missing') {
          divergences.push({
            entity: 'escrow',
            type: 'missing',
            contractAddress: address,
            expectedAmount: expected.amount,
            details: `Escrow ${address} is absent on-chain`,
          });
        }

        const dbAmount = this.normalizeAmountToBaseUnits(expected.amount);
        const onChainAmount = observed.balance;
        if (dbAmount !== onChainAmount) {
          divergences.push({
            entity: 'escrow',
            type: 'amount_mismatch',
            contractAddress: address,
            expectedAmount: expected.amount,
            observedAmount: onChainAmount.toString(),
            details: `Escrow ${address} amount mismatch: DB=${expected.amount}, Horizon=${onChainAmount.toString()}`,
          });
        }
      }

      const paymentByHash = new Map<string, PaymentRecord[]>();
      for (const payment of dbPayments) {
        const list = paymentByHash.get(payment.stellar_tx_hash) ?? [];
        list.push(payment);
        paymentByHash.set(payment.stellar_tx_hash, list);
      }

      for (const [txHash, rows] of paymentByHash) {
        if (rows.length > 1) {
          divergences.push({
            entity: 'payment',
            type: 'duplicate',
            txHash,
            details: `Duplicate payment rows for tx ${txHash}: ${rows.length} rows`,
          });
        }
      }

      const txHashes = new Set(dbPayments.map((p) => p.stellar_tx_hash));
      for (const payment of dbPayments) {
        try {
          const tx = await this.server.transactions().transaction(payment.stellar_tx_hash).call();
          const onChainStatus = tx.successful ? 'confirmed' : 'failed';
          if (payment.status === PaymentDbStatus.Paid && onChainStatus !== 'confirmed') {
            divergences.push({
              entity: 'payment',
              type: 'status_mismatch',
              txHash: payment.stellar_tx_hash,
              expectedStatus: payment.status,
              observedStatus: onChainStatus,
              details: `Payment ${payment.stellar_tx_hash} expected paid but Horizon reports ${onChainStatus}`,
            });
          }
        } catch (error) {
          const status = (error as { response?: { status?: number } })?.response?.status === 404 ? 'missing' : 'unknown';
          if (payment.status === PaymentDbStatus.Paid || payment.status === PaymentDbStatus.Pending) {
            divergences.push({
              entity: 'payment',
              type: 'missing',
              txHash: payment.stellar_tx_hash,
              expectedStatus: payment.status,
              observedStatus: status,
              details: `Payment ${payment.stellar_tx_hash} missing from Horizon`,
            });
          }
        }
      }

      this.logger.log(`[${runId}] Detected ${divergences.length} divergence(s) against Horizon (batchSize=${batchSize})`);
      return divergences;
    } catch (error) {
      this.logger.warn(`[${runId}] Horizon divergence scan failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * Compare expected vs observed payment totals to detect discrepancies.
   * Expected: Count and sum of payments in 'paid' status in DB
   * Observed: Count and sum of confirmed transactions on-chain
   */
  private async comparePaymentTotals(runId: string) {
    try {
      const dbPayments = await this.supabase.fetchPaidPayments();
      const expectedCount = dbPayments.length;
      const observations: Array<Awaited<ReturnType<ReconciliationService['observePaymentOnLedger']>>> = [];
      for (let offset = 0; offset < dbPayments.length; offset += 20) {
        observations.push(...await Promise.all(
          dbPayments.slice(offset, offset + 20).map((payment) => this.observePaymentOnLedger(payment)),
        ));
      }

      const assetTotals = new Map<string, {
        expectedCount: number;
        observedCount: number;
        expectedTotal: bigint;
        observedTotal: bigint;
      }>();
      let observedCount = 0;
      let unresolvedCount = 0;
      let countDiscrepancy = 0;
      let amountMismatchCount = 0;
      let expectedTotal = 0n;
      let observedTotal = 0n;

      for (let index = 0; index < dbPayments.length; index += 1) {
        const payment = dbPayments[index];
        const observation = observations[index];
        const expectedAmount = this.normalizeAmountToBaseUnits(payment.amount);
        expectedTotal += expectedAmount;
        const assetName = payment.asset;
        const totals = assetTotals.get(assetName) ?? {
          expectedCount: 0,
          observedCount: 0,
          expectedTotal: 0n,
          observedTotal: 0n,
        };
        totals.expectedCount += 1;
        totals.expectedTotal += expectedAmount;

        if (observation.kind === 'observed') {
          const observedAmount = this.normalizeAmountToBaseUnits(observation.amount);
          observedCount += 1;
          observedTotal += observedAmount;
          totals.observedCount += 1;
          totals.observedTotal += observedAmount;
          if (observedAmount !== expectedAmount) amountMismatchCount += 1;
        } else if (observation.kind === 'missing') {
          countDiscrepancy += 1;
        } else {
          unresolvedCount += 1;
        }
        assetTotals.set(assetName, totals);
      }

      const assets = Object.fromEntries([...assetTotals.entries()].map(([asset, totals]) => {
        const amountDiscrepancy = totals.expectedTotal - totals.observedTotal;
        return [asset, {
          expectedCount: totals.expectedCount,
          observedCount: totals.observedCount,
          expectedTotalAmount: totals.expectedTotal.toString(),
          observedTotalAmount: totals.observedTotal.toString(),
          amountDiscrepancy: amountDiscrepancy.toString(),
        }];
      }));
      const amountDiscrepancy = expectedTotal - observedTotal;
      const complete = unresolvedCount === 0;
      const exceedsThreshold = countDiscrepancy > 0 || amountMismatchCount > 0;

      this.logger.log(
        `[${runId}] Payment totals comparison: expected=${expectedCount}/${expectedTotal}, observed=${observedCount}/${observedTotal}, unresolved=${unresolvedCount}, exceedsThreshold=${exceedsThreshold}`,
      );

      return {
        payments: {
          expectedCount,
          observedCount,
          countDiscrepancy,
          expectedTotalAmount: expectedTotal.toString(),
          observedTotalAmount: observedTotal.toString(),
          amountDiscrepancy: amountDiscrepancy.toString(),
          amountMismatchCount,
          unresolvedCount,
          complete,
          exceedsThreshold,
          assets,
        },
      };
    } catch (error) {
      this.logger.warn(
        `[${runId}] Failed to compare payment totals: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Generate alert if discrepancies exceed configured threshold.
   */
  private generateDiscrepancyAlert(report: ReconciliationReport): { severity: 'critical' | 'warning'; message: string; details: string } | undefined {
    const paymentTotals = report.totalsComparison?.payments;
    if (!paymentTotals || (!paymentTotals.exceedsThreshold && paymentTotals.complete)) {
      return undefined;
    }

    const { countDiscrepancy, amountDiscrepancy, amountMismatchCount, unresolvedCount, complete } = paymentTotals;

    const isCritical = amountMismatchCount > 0 || (complete && countDiscrepancy > 10);

    const message = isCritical
      ? 'Critical payment discrepancy detected'
      : !complete
        ? 'Payment totals comparison incomplete'
        : 'Payment discrepancy detected';

    const details = `Count discrepancy: ${countDiscrepancy}, amount discrepancy: ${amountDiscrepancy}, amount mismatches: ${amountMismatchCount}, unresolved: ${unresolvedCount}`;

    this.logger.error(
      `[${report.runId}] ${message}: ${details}`,
    );

    // Record metric for alert
    this.metrics.recordError('reconciliation', isCritical ? 'critical_discrepancy' : 'warning_discrepancy');

    return {
      severity: isCritical ? ('critical' as const) : ('warning' as const),
      message,
      details,
    };
  }

  private logReport(report: ReconciliationReport): void {
    const { runId, durationMs, escrows, payments } = report;

    this.logger.log(
      `[${runId}] Run complete in ${durationMs}ms | ` +
      `Escrows — processed:${escrows.processed} updated:${escrows.updated} ` +
      `noOp:${escrows.noOp} skipped:${escrows.skipped} irreconcilable:${escrows.irreconcilable} | ` +
      `Payments — processed:${payments.processed} updated:${payments.updated} ` +
      `noOp:${payments.noOp} skipped:${payments.skipped} irreconcilable:${payments.irreconcilable}`,
    );

    // Warn loudly for any irreconcilable records
    const allIrreconcilable = [
      ...escrows.results.filter((r) => r.irreconcilable),
      ...payments.results.filter((r) => r.irreconcilable),
    ];

    if (allIrreconcilable.length > 0) {
      this.logger.error(
        `[${runId}] ⚠  ${allIrreconcilable.length} irreconcilable record(s) flagged for manual review`,
      );
      allIrreconcilable.forEach((r) => {
        this.logger.error(
          `  • ${'contractAddress' in r ? `escrow ${r.id}` : `payment ${r.id}`}: ${(r as { irreconcilableReason?: string }).irreconcilableReason}`,
        );
      });
    }
  }
}
