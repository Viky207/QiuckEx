import { Injectable, OnModuleInit } from "@nestjs/common";
import * as client from "prom-client";

@Injectable()
export class MetricsService implements OnModuleInit {
  private register: client.Registry;
  private httpRequestDuration: client.Histogram<string>;
  private httpRequestTotal: client.Counter<string>;
  private rateLimitedRequestsTotal: client.Counter<string>;
  private activeConnections: client.Gauge<string>;
  private ingestionLagSeconds: client.Gauge<string>;
  private webhookRetryTotal: client.Counter<string>;
  private webhookDeliveryDuration: client.Histogram<string>;
  private webhookDeliverySuccessRate: client.Gauge<string>;
  private webhookDlqSize: client.Gauge<string>;
  private externalCallDuration: client.Histogram<string>;
  private errorRate: client.Counter<string>;
  private sorobanRpcFailoverTotal: client.Counter<string>;
  private sorobanRpcActiveEndpoint: client.Gauge<string>;
  private sorobanIndexerUnknownSchemaVersion: client.Counter<string>;
  private parityCheckResults: client.Gauge<string>;
  private shadowTrafficRequests: client.Counter<string>;
  private indexerLagLedgers: client.Gauge<string>;
  private indexerLagGuardBlockedRequests: client.Counter<string>;
  private indexerLagGuardStatus: client.Gauge<string>;
  private abuseSignalsTotal: client.Counter<string>;
  private abuseSignalsHighScore: client.Counter<string>;
  private abuseSignalsByOutcome: client.Counter<string>;
  private abuseScoresHistogram: client.Histogram<string>;
  private paymentLinksExpired: client.Counter<string>;
  // Escrow state transition metrics
  private escrowStateTransitions: client.Counter<string>;
  private escrowStateTransitionDuration: client.Histogram<string>;
  private escrowFinalizedTotal: client.Counter<string>;
  private escrowRefundedTotal: client.Counter<string>;
  private escrowDisputedTotal: client.Counter<string>;
  private escrowExtendedTotal: client.Counter<string>;
  private escrowCleanedTotal: client.Counter<string>;
  // Observability: SLO, alerting, tracing, dependency probes, operator replays
  private sloCompliance: client.Gauge<string>;
  private sloErrorBudgetRemaining: client.Gauge<string>;
  private sloBurnRate: client.Gauge<string>;
  private sloStatus: client.Gauge<string>;
  private alertsFiring: client.Gauge<string>;
  private dependencyProbeDuration: client.Histogram<string>;
  private dependencyProbeUp: client.Gauge<string>;
  private traceContexts: client.Counter<string>;
  private operatorReplayTotal: client.Counter<string>;
  private testnetFixtureTotal: client.Counter<string>;
  private testnetFixtureDuration: client.Histogram<string>;
  private initialized = false;

  onModuleInit() {
    try {
      this.register = new client.Registry();

      client.collectDefaultMetrics({ register: this.register });

      this.httpRequestDuration = new client.Histogram({
        name: "http_request_duration_seconds",
        help: "Duration of HTTP requests in seconds",
        labelNames: ["method", "route", "status_code"],
        buckets: [0.1, 0.5, 1, 2, 5, 10],
      });

      this.httpRequestTotal = new client.Counter({
        name: "http_requests_total",
        help: "Total number of HTTP requests",
        labelNames: ["method", "route", "status_code"],
      });

      this.rateLimitedRequestsTotal = new client.Counter({
        name: "http_rate_limited_requests_total",
        help: "Total number of requests blocked by rate limiting",
        labelNames: ["method", "route", "group", "key_type"],
      });

      this.activeConnections = new client.Gauge({
        name: "http_active_connections",
        help: "Number of active connections",
      });

      this.ingestionLagSeconds = new client.Gauge({
        name: "ingestion_lag_seconds",
        help: "Lag between current ledger and last ingested ledger in seconds",
        labelNames: ["contract_id"],
      });

      this.webhookRetryTotal = new client.Counter({
        name: "webhook_retry_total",
        help: "Total number of webhook retry attempts",
        labelNames: ["event_type", "status"],
      });

      this.webhookDeliveryDuration = new client.Histogram({
        name: "webhook_delivery_duration_seconds",
        help: "Duration of webhook delivery attempts in seconds",
        labelNames: ["event_type", "status"],
        buckets: [0.1, 0.5, 1, 2, 5, 10],
      });

      this.webhookDeliverySuccessRate = new client.Gauge({
        name: "webhook_delivery_success_rate",
        help: "Ratio (0-1) of successful webhook deliveries over total attempts",
        labelNames: ["webhook_id"],
      });

      this.webhookDlqSize = new client.Gauge({
        name: "webhook_dlq_size",
        help: "Number of webhook deliveries currently in the dead-letter queue",
        labelNames: ["webhook_id"],
      });

      this.externalCallDuration = new client.Histogram({
        name: "external_call_duration_seconds",
        help: "Duration of external API calls in seconds",
        labelNames: ["service", "operation"],
        buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      });

      this.errorRate = new client.Counter({
        name: "error_total",
        help: "Total number of errors",
        labelNames: ["service", "error_type"],
      });

      this.sorobanRpcFailoverTotal = new client.Counter({
        name: "soroban_rpc_failover_total",
        help: "Total number of Soroban RPC failover events",
        labelNames: ["from_endpoint", "to_endpoint", "reason"],
      });

      this.sorobanRpcActiveEndpoint = new client.Gauge({
        name: "soroban_rpc_active_endpoint",
        help: "Currently active Soroban RPC endpoint (1=active, 0=inactive)",
        labelNames: ["endpoint"],
      });

      this.sorobanIndexerUnknownSchemaVersion = new client.Counter({
        name: "soroban_indexer_unknown_schema_version_total",
        help: "Events skipped because their schema_version exceeds the indexer maximum",
        labelNames: ["event_name", "schema_version"],
      });

      this.parityCheckResults = new client.Gauge({
        name: "environment_parity_check_results",
        help: "Environment parity check results by status",
        labelNames: ["status"],
      });

      this.shadowTrafficRequests = new client.Counter({
        name: "shadow_traffic_requests_total",
        help: "Total number of shadow traffic requests",
        labelNames: ["method", "route", "status_code", "shadow_status"],
      });

      this.indexerLagLedgers = new client.Gauge({
        name: "indexer_lag_ledgers",
        help: "Current indexer lag in ledgers",
      });

      this.indexerLagGuardBlockedRequests = new client.Counter({
        name: "indexer_lag_guard_blocked_requests_total",
        help: "Total number of requests blocked by indexer lag guard",
        labelNames: ["method", "route"],
      });

      this.indexerLagGuardStatus = new client.Gauge({
        name: "indexer_lag_guard_status",
        help: "Indexer lag guard status (0=disabled, 1=enabled, 2=overridden, 3=lagging)",
      });

      this.abuseSignalsTotal = new client.Counter({
        name: "abuse_signals_total",
        help: "Total number of abuse signals recorded",
        labelNames: ["action_type", "action_outcome"],
      });

      this.abuseSignalsHighScore = new client.Counter({
        name: "abuse_signals_high_score_total",
        help: "Total number of high-score abuse signals (above threshold)",
        labelNames: ["score_range", "top_tag"],
      });

      this.abuseSignalsByOutcome = new client.Counter({
        name: "abuse_signals_by_outcome_total",
        help: "Abuse signals broken down by outcome",
        labelNames: ["outcome"],
      });

      this.abuseScoresHistogram = new client.Histogram({
        name: "abuse_signal_score",
        help: "Distribution of computed abuse scores",
        labelNames: ["action_outcome"],
        buckets: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
      });

      this.paymentLinksExpired = new client.Counter({
        name: "paymentlinks_expired_count",
        help: "Total number of payment links marked as expired by the expiry sweep",
      });

      // Escrow state transition metrics
      this.escrowStateTransitions = new client.Counter({
        name: "escrow_state_transitions_total",
        help: "Total number of escrow state transitions",
        labelNames: ["from_state", "to_state", "trigger"],
      });

      this.escrowStateTransitionDuration = new client.Histogram({
        name: "escrow_state_transition_duration_seconds",
        help: "Duration of escrow state transitions in seconds",
        labelNames: ["from_state", "to_state", "trigger"],
        buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
      });

      this.escrowFinalizedTotal = new client.Counter({
        name: "escrow_finalized_total",
        help: "Total number of escrows finalized (spent)",
        labelNames: ["trigger"], // withdraw, resolve_dispute, resolve_dispute_multi_sig
      });

      this.escrowRefundedTotal = new client.Counter({
        name: "escrow_refunded_total",
        help: "Total number of escrows refunded",
        labelNames: ["trigger"], // refund, finalize_expired_escrow, resolve_dispute
      });

      this.escrowDisputedTotal = new client.Counter({
        name: "escrow_disputed_total",
        help: "Total number of escrows entering dispute state",
        labelNames: ["trigger"], // dispute
      });

      this.escrowExtendedTotal = new client.Counter({
        name: "escrow_extended_total",
        help: "Total number of escrow expiry extensions",
        labelNames: ["trigger"], // extend_escrow_expiry
      });

      this.escrowCleanedTotal = new client.Counter({
        name: "escrow_cleaned_total",
        help: "Total number of escrows cleaned up (storage reclaimed)",
        labelNames: ["status"], // spent, refunded
      });

      this.register.registerMetric(this.httpRequestDuration);
      this.register.registerMetric(this.httpRequestTotal);
      this.register.registerMetric(this.rateLimitedRequestsTotal);
      this.register.registerMetric(this.activeConnections);
      this.register.registerMetric(this.ingestionLagSeconds);
      this.register.registerMetric(this.webhookRetryTotal);
      this.register.registerMetric(this.webhookDeliveryDuration);
      this.register.registerMetric(this.webhookDeliverySuccessRate);
      this.register.registerMetric(this.webhookDlqSize);
      this.register.registerMetric(this.externalCallDuration);
      this.register.registerMetric(this.errorRate);
      this.register.registerMetric(this.sorobanRpcFailoverTotal);
      this.register.registerMetric(this.sorobanRpcActiveEndpoint);
      this.register.registerMetric(this.sorobanIndexerUnknownSchemaVersion);
      this.register.registerMetric(this.parityCheckResults);
      this.register.registerMetric(this.shadowTrafficRequests);
      this.register.registerMetric(this.indexerLagLedgers);
      this.register.registerMetric(this.indexerLagGuardBlockedRequests);
      this.register.registerMetric(this.indexerLagGuardStatus);
      this.register.registerMetric(this.abuseSignalsTotal);
      this.register.registerMetric(this.abuseSignalsHighScore);
      this.register.registerMetric(this.abuseSignalsByOutcome);
      this.register.registerMetric(this.abuseScoresHistogram);
      this.register.registerMetric(this.paymentLinksExpired);
      // Escrow state transition metrics
      this.register.registerMetric(this.escrowStateTransitions);
      this.register.registerMetric(this.escrowStateTransitionDuration);
      this.register.registerMetric(this.escrowFinalizedTotal);
      this.register.registerMetric(this.escrowRefundedTotal);
      this.register.registerMetric(this.escrowDisputedTotal);
      this.register.registerMetric(this.escrowExtendedTotal);
      this.register.registerMetric(this.escrowCleanedTotal);

      // Observability metrics (issues #278-#281). SLO and alert series are
      // published here rather than by the observability module so they always
      // land in the same registry the /metrics endpoint scrapes.
      this.sloCompliance = new client.Gauge({
        name: "quickex_slo_compliance_ratio",
        help: "Observed compliance ratio (0-1) per service level objective",
        labelNames: ["slo", "path", "kind"],
      });

      this.sloErrorBudgetRemaining = new client.Gauge({
        name: "quickex_slo_error_budget_remaining_ratio",
        help: "Remaining error budget ratio (0-1); negative means over budget",
        labelNames: ["slo", "path"],
      });

      this.sloBurnRate = new client.Gauge({
        name: "quickex_slo_error_budget_burn_rate",
        help: "Error budget burn rate as a multiple of the 30-day budget",
        labelNames: ["slo", "path"],
      });

      this.sloStatus = new client.Gauge({
        help: "Current SLO status (0=ok, 1=insufficient_data, 2=warning, 3=critical)",
        name: "quickex_slo_status",
        labelNames: ["slo", "path", "enforced"],
      });

      this.alertsFiring = new client.Gauge({
        name: "quickex_alerts_firing",
        help: "1 when an alert is firing, 0 otherwise",
        labelNames: ["alert", "severity"],
      });

      this.dependencyProbeDuration = new client.Histogram({
        name: "quickex_dependency_probe_duration_seconds",
        help: "Duration of dependency readiness probes in seconds",
        labelNames: ["dependency", "criticality", "status"],
        buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      });

      this.dependencyProbeUp = new client.Gauge({
        name: "quickex_dependency_probe_up",
        help: "Last result of a dependency readiness probe (1=healthy, 0=not)",
        labelNames: ["dependency", "criticality"],
      });

      this.traceContexts = new client.Counter({
        name: "quickex_trace_context_total",
        help: "Trace contexts established per request",
        labelNames: ["outcome"],
      });

      this.operatorReplayTotal = new client.Counter({
        name: "quickex_operator_replay_total",
        help: "Operator-initiated notification and webhook replays",
        labelNames: ["target", "outcome"],
      });

      // Testnet fixture manager (#283). The outcome label is a stable enum so
      // the cardinality stays bounded: a fixture name is never a label value.
      this.testnetFixtureTotal = new client.Counter({
        name: "quickex_testnet_fixture_total",
        help: "Testnet fixture accounts resolved by outcome",
        labelNames: ["outcome"],
      });

      this.testnetFixtureDuration = new client.Histogram({
        name: "quickex_testnet_fixture_duration_seconds",
        help: "Wall-clock duration of a testnet fixture resolution",
        labelNames: ["outcome"],
        buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      });

      this.register.registerMetric(this.sloCompliance);
      this.register.registerMetric(this.sloErrorBudgetRemaining);
      this.register.registerMetric(this.sloBurnRate);
      this.register.registerMetric(this.sloStatus);
      this.register.registerMetric(this.alertsFiring);
      this.register.registerMetric(this.dependencyProbeDuration);
      this.register.registerMetric(this.dependencyProbeUp);
      this.register.registerMetric(this.traceContexts);
      this.register.registerMetric(this.operatorReplayTotal);
      this.register.registerMetric(this.testnetFixtureTotal);
      this.register.registerMetric(this.testnetFixtureDuration);

      this.initialized = true;
    } catch (error) {
      console.error("Failed to initialize metrics:", error);
      this.initialized = false;
    }
  }

  getRegistry(): client.Registry {
    return this.register;
  }

  recordRequestDuration(
    method: string,
    route: string,
    statusCode: number,
    duration: number,
  ) {
    if (
      !this.initialized ||
      !this.httpRequestDuration ||
      !this.httpRequestTotal
    ) {
      return;
    }

    try {
      this.httpRequestDuration
        .labels(method, route, statusCode.toString())
        .observe(duration);
      this.httpRequestTotal.labels(method, route, statusCode.toString()).inc();
    } catch (error) {}
  }

  incrementActiveConnections() {
    if (!this.initialized || !this.activeConnections) {
      return;
    }

    try {
      this.activeConnections.inc();
    } catch (error) {}
  }

  decrementActiveConnections() {
    if (!this.initialized || !this.activeConnections) {
      return;
    }

    try {
      this.activeConnections.dec();
    } catch (error) {}
  }

  recordRateLimitedRequest(
    method: string,
    route: string,
    group: string,
    keyType: string,
  ) {
    if (!this.initialized || !this.rateLimitedRequestsTotal) {
      return;
    }

    try {
      this.rateLimitedRequestsTotal.labels(method, route, group, keyType).inc();
    } catch (error) {}
  }

  recordIngestionLag(contractId: string, lagSeconds: number) {
    if (!this.initialized || !this.ingestionLagSeconds) {
      return;
    }

    try {
      this.ingestionLagSeconds.labels(contractId).set(lagSeconds);
    } catch (error) {}
  }

  recordWebhookRetry(eventType: string, status: string) {
    if (!this.initialized || !this.webhookRetryTotal) {
      return;
    }

    try {
      this.webhookRetryTotal.labels(eventType, status).inc();
    } catch (error) {}
  }

  recordWebhookDeliveryDuration(
    eventType: string,
    status: string,
    duration: number,
  ) {
    if (!this.initialized || !this.webhookDeliveryDuration) {
      return;
    }

    try {
      this.webhookDeliveryDuration.labels(eventType, status).observe(duration);
    } catch (error) {}
  }

  setWebhookDeliverySuccessRate(webhookId: string, rate: number) {
    if (!this.initialized || !this.webhookDeliverySuccessRate) {
      return;
    }
    try {
      this.webhookDeliverySuccessRate.labels(webhookId).set(rate);
    } catch (error) {}
  }

  setWebhookDlqSize(webhookId: string, size: number) {
    if (!this.initialized || !this.webhookDlqSize) {
      return;
    }
    try {
      this.webhookDlqSize.labels(webhookId).set(size);
    } catch (error) {}
  }

  recordExternalCall(service: string, operation: string, duration: number) {
    if (!this.initialized || !this.externalCallDuration) {
      return;
    }

    try {
      this.externalCallDuration.labels(service, operation).observe(duration);
    } catch (error) {}
  }

  recordError(service: string, errorType: string) {
    if (!this.initialized || !this.errorRate) {
      return;
    }

    try {
      this.errorRate.labels(service, errorType).inc();
    } catch (error) {}
  }

  recordSorobanRpcFailover(
    fromEndpoint: string,
    toEndpoint: string,
    reason: string,
  ) {
    if (!this.initialized || !this.sorobanRpcFailoverTotal) {
      return;
    }
    try {
      this.sorobanRpcFailoverTotal
        .labels(fromEndpoint, toEndpoint, reason)
        .inc();
    } catch (error) {}
  }

  setSorobanRpcActiveEndpoint(endpoint: string, allEndpoints: string[]) {
    if (!this.initialized || !this.sorobanRpcActiveEndpoint) {
      return;
    }
    try {
      for (const url of allEndpoints) {
        this.sorobanRpcActiveEndpoint.labels(url).set(url === endpoint ? 1 : 0);
      }
    } catch (error) {}
  }

  recordUnknownSchemaVersion(eventName: string, schemaVersion: number) {
    if (!this.initialized || !this.sorobanIndexerUnknownSchemaVersion) return;
    try {
      this.sorobanIndexerUnknownSchemaVersion
        .labels(eventName, String(schemaVersion))
        .inc();
    } catch (error) {}
  }

  recordParityCheckResult(
    checkType: string,
    passed: number,
    failed: number,
    warnings: number,
  ) {
    if (!this.initialized || !this.parityCheckResults) return;
    try {
      this.parityCheckResults.labels("pass").set(passed);
      this.parityCheckResults.labels("fail").set(failed);
      this.parityCheckResults.labels("warning").set(warnings);
    } catch (error) {}
  }

  recordShadowTrafficRequest(
    method: string,
    route: string,
    statusCode: number,
    shadowStatus: "success" | "error" | "skipped",
  ) {
    if (!this.initialized || !this.shadowTrafficRequests) return;
    try {
      this.shadowTrafficRequests
        .labels(method, route, statusCode.toString(), shadowStatus)
        .inc();
    } catch (error) {}
  }

  recordIndexerLag(lagLedgers: number) {
    if (!this.initialized || !this.indexerLagLedgers) return;
    try {
      this.indexerLagLedgers.set(lagLedgers);
    } catch (error) {}
  }

  recordIndexerLagGuardBlockedRequest(method: string, route: string) {
    if (!this.initialized || !this.indexerLagGuardBlockedRequests) return;
    try {
      this.indexerLagGuardBlockedRequests.labels(method, route).inc();
    } catch (error) {}
  }

  setIndexerLagGuardStatus(status: 0 | 1 | 2 | 3) {
    if (!this.initialized || !this.indexerLagGuardStatus) return;
    try {
      this.indexerLagGuardStatus.set(status);
    } catch (error) {}
  }

  recordAbuseSignal(
    actionType: string,
    actionOutcome: string,
    score: number,
    tags: string[],
  ) {
    if (!this.initialized) return;
    try {
      this.abuseSignalsTotal?.labels(actionType, actionOutcome).inc();
      this.abuseSignalsByOutcome?.labels(actionOutcome).inc();
      this.abuseScoresHistogram?.labels(actionOutcome).observe(score);

      if (score >= 30) {
        const scoreRange =
          score >= 80 ? "80-100" : score >= 50 ? "50-79" : "30-49";
        const topTag = tags[0] ?? "none";
        this.abuseSignalsHighScore?.labels(scoreRange, topTag).inc();
      }
    } catch (error) {}
  }

  recordPaymentLinkExpired() {
    if (!this.initialized || !this.paymentLinksExpired) return;
    try {
      this.paymentLinksExpired.inc();
    } catch (error) {}
  }

  // Escrow state transition metrics
  recordEscrowStateTransition(
    fromState: string,
    toState: string,
    trigger: string,
    durationSeconds?: number,
  ) {
    if (!this.initialized || !this.escrowStateTransitions) {
      return;
    }
    try {
      this.escrowStateTransitions.labels(fromState, toState, trigger).inc();
      if (durationSeconds !== undefined && this.escrowStateTransitionDuration) {
        this.escrowStateTransitionDuration.labels(fromState, toState, trigger).observe(durationSeconds);
      }
    } catch (error) {}
  }

  recordEscrowFinalized(trigger: "withdraw" | "resolve_dispute" | "resolve_dispute_multi_sig") {
    if (!this.initialized || !this.escrowFinalizedTotal) {
      return;
    }
    try {
      this.escrowFinalizedTotal.labels(trigger).inc();
    } catch (error) {}
  }

  recordEscrowRefunded(trigger: "refund" | "finalize_expired_escrow" | "resolve_dispute") {
    if (!this.initialized || !this.escrowRefundedTotal) {
      return;
    }
    try {
      this.escrowRefundedTotal.labels(trigger).inc();
    } catch (error) {}
  }

  recordEscrowDisputed(trigger: "dispute") {
    if (!this.initialized || !this.escrowDisputedTotal) {
      return;
    }
    try {
      this.escrowDisputedTotal.labels(trigger).inc();
    } catch (error) {}
  }

  recordEscrowExtended(trigger: "extend_escrow_expiry") {
    if (!this.initialized || !this.escrowExtendedTotal) {
      return;
    }
    try {
      this.escrowExtendedTotal.labels(trigger).inc();
    } catch (error) {}
  }

  recordEscrowCleaned(status: "spent" | "refunded") {
    if (!this.initialized || !this.escrowCleanedTotal) {
      return;
    }
    try {
      this.escrowCleanedTotal.labels(status).inc();
    } catch (error) {}
  }

  // ── Observability recorders (issues #278-#281) ─────────────────────────────
  // Every recorder is a silent no-op when the registry is not initialized and
  // swallows its own errors, matching the behaviour of the existing
  // recorders: a metrics failure must never become an API failure.

  /**
   * Publish the evaluated SLO report. `null` ratios are published as NaN so
   * Prometheus distinguishes "no observation" from "0% compliant" — writing 0
   * for an unobserved objective would page an operator for no reason.
   */
  recordSloEvaluation(evaluation: {
    id: string;
    path: string;
    kind: string;
    enforced: boolean;
    observedRatio: number | null;
    burnRate: number | null;
    remainingBudgetRatio: number | null;
    status: string;
  }) {
    if (!this.initialized) return;

    const toNaN = (value: number | null) => (value === null ? NaN : value);

    try {
      this.sloCompliance
        .labels(evaluation.id, evaluation.path, evaluation.kind)
        .set(toNaN(evaluation.observedRatio));
      this.sloBurnRate
        .labels(evaluation.id, evaluation.path)
        .set(toNaN(evaluation.burnRate));
      this.sloErrorBudgetRemaining
        .labels(evaluation.id, evaluation.path)
        .set(toNaN(evaluation.remainingBudgetRatio));
      this.sloStatus
        .labels(
          evaluation.id,
          evaluation.path,
          evaluation.enforced ? "true" : "false",
        )
        .set(SLO_STATUS_CODES[evaluation.status] ?? 1);
    } catch (error) {}
  }

  /** Publish whether an alert is currently firing (1) or not (0). */
  recordAlertState(alertId: string, severity: string, firing: boolean) {
    if (!this.initialized || !this.alertsFiring) return;
    try {
      this.alertsFiring.labels(alertId, severity).set(firing ? 1 : 0);
    } catch (error) {}
  }

  recordDependencyProbe(
    dependency: string,
    status: string,
    durationMs: number,
    criticality = "unknown",
  ) {
    if (!this.initialized) return;
    try {
      this.dependencyProbeDuration
        .labels(dependency, criticality, status)
        .observe(durationMs / 1000);
      this.dependencyProbeUp
        .labels(dependency, criticality)
        .set(status === "healthy" ? 1 : 0);
    } catch (error) {}
  }

  /**
   * `outcome` is one of `started`, `continued` or `replaced_malformed`, and
   * `hasBaggage` is a boolean, never the baggage contents, so user-controlled
   * values can never become a label.
   */
  recordTraceContext(outcome: string, hasBaggage: boolean) {
    if (!this.initialized || !this.traceContexts) return;
    try {
      this.traceContexts.labels(outcome).inc();
      if (hasBaggage) {
        this.traceContexts.labels("baggage_forwarded").inc();
      }
    } catch (error) {}
  }

  /** `target` is `notification` or `webhook`; `outcome` is a stable code. */
  recordOperatorReplay(target: string, outcome: string) {
    if (!this.initialized || !this.operatorReplayTotal) return;
    try {
      this.operatorReplayTotal.labels(target, outcome).inc();
    } catch (error) {}
  }

  /**
   * Record a resolved testnet fixture account (#283).
   *
   * `outcome` is one of the bounded `FixtureStatus` values. The fixture *name*
   * is deliberately not a label: labels are a permanent, unbounded cost in the
   * registry, and a fixture set is expected to grow over time.
   */
  recordTestnetFixture(outcome: string, durationSeconds?: number) {
    if (!this.initialized || !this.testnetFixtureTotal) return;
    try {
      this.testnetFixtureTotal.labels(outcome).inc();
      if (
        typeof durationSeconds === 'number' &&
        Number.isFinite(durationSeconds) &&
        this.testnetFixtureDuration
      ) {
        this.testnetFixtureDuration.labels(outcome).observe(durationSeconds);
      }
    } catch (error) {}
  }
}

const SLO_STATUS_CODES: Record<string, number> = {
  ok: 0,
  insufficient_data: 1,
  warning: 2,
  critical: 3,
};

