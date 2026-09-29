import type { RegistryReader } from "../metrics/registry-reader";
import type { SloReport } from "../slo/slo.service";

/**
 * Alert rules for settlement latency, indexer lag and reconciliation.
 *
 * Rules are data, not code: the evaluator in `alerting.service.ts` is generic,
 * so adding an alert means adding one entry here. Each rule carries the
 * runbook step an on-call operator should take, so an alert is actionable
 * without leaving the alert payload.
 *
 * `forSamples` implements the "for" clause of a Prometheus alert: a condition
 * must hold for N consecutive evaluations before it fires. That is what keeps
 * a single noisy scrape from paging anyone.
 */
export type AlertSeverity = "critical" | "warning" | "info";

export interface AlertMeasurement {
  /** Observed value, in the rule's unit. */
  value: number;
  /** Threshold the value was compared against. */
  threshold: number;
  /** Unit label, e.g. `ledgers`, `seconds`, `ratio`. */
  unit: string;
  /** Short, secret-free description of what was measured. */
  detail: string;
}

export interface AlertEvaluationInput {
  /** Reads from the live Prometheus registry. */
  registry: RegistryReader;
  /** Evaluated SLO report, for the error-budget alerts. */
  sloReport: SloReport;
  /** Configured indexer-lag threshold in ledgers. */
  indexerLagThresholdLedgers: number;
  /** Configured settlement latency budget in seconds. */
  settlementLatencyBudgetSeconds: number;
}

export interface AlertRule {
  /** Stable identifier, used as a Prometheus label value. */
  id: string;
  severity: AlertSeverity;
  /** Operator-facing summary. */
  summary: string;
  /** Why this matters, in one sentence. */
  impact: string;
  /** First action for on-call. */
  runbook: string;
  /** Consecutive evaluations the condition must hold before firing. */
  forSamples: number;
  /**
   * Evaluate the rule. Returns the observed value and the threshold it was
   * compared against, or `null` when there is not enough data to judge.
   */
  evaluate: (
    input: AlertEvaluationInput,
  ) => Promise<AlertMeasurement | null>;
}

export const ALERT_RULES: readonly AlertRule[] = [
  {
    id: "indexer_lag_over_threshold",
    severity: "critical",
    summary: "Indexer lag exceeds the configured ledger threshold",
    impact:
      "New on-chain events are not reaching the system of record, so balances " +
      "and notifications are stale until the indexer catches up.",
    runbook:
      "Check `GET /admin/operations/indexer` for the current and last indexed " +
      "ledger, then confirm Horizon and the indexer worker are healthy before " +
      "considering a replay.",
    forSamples: 2,
    evaluate: async (input) => {
      const value = await input.registry.gauge("indexer_lag_ledgers");
      if (value === null) return null;

      return {
        value,
        threshold: input.indexerLagThresholdLedgers,
        unit: "ledgers",
        detail:
          `indexer_lag_ledgers vs threshold ` +
          `${input.indexerLagThresholdLedgers}`,
      };
    },
  },
  {
    id: "indexer_lag_guard_blocking_traffic",
    severity: "warning",
    summary: "The indexer-lag guard is actively rejecting requests",
    impact:
      "Read traffic on guarded routes is refused because the indexer is behind, " +
      "which surfaces to end users as degraded reads.",
    runbook:
      "Confirm the lag is real before overriding the guard; the override is " +
      "recorded in the audit log and must be reverted once the indexer catches up.",
    forSamples: 2,
    evaluate: async (input) => {
      const status = await input.registry.gauge("indexer_lag_guard_status");
      if (status === null) return null;

      return {
        value: status,
        threshold: 3,
        unit: "state",
        detail: `indexer_lag_guard_status=${status} (3 = lagging)`,
      };
    },
  },
  {
    id: "settlement_latency_over_budget",
    severity: "critical",
    summary: "Settlement transitions exceed the latency budget",
    impact:
      "Escrow state transitions are taking longer than the agreed budget, so " +
      "settlement is slower than the product and SLO promise.",
    runbook:
      "Inspect the `escrow_state_transition_duration_seconds` histogram split " +
      "by `trigger` to identify which transition slowed, then check Horizon " +
      "and Soroban RPC latency for the matching window.",
    forSamples: 3,
    evaluate: async (input) => {
      const total = await input.registry.histogramCount(
        "escrow_state_transition_duration_seconds",
      );
      const good = await input.registry.histogramCountAtOrBelow(
        "escrow_state_transition_duration_seconds",
        input.settlementLatencyBudgetSeconds,
      );

      if (total === null || good === null || total === 0) return null;

      return {
        value: total - good,
        threshold: 0,
        unit: "transitions_over_budget",
        detail:
          `${total - good} of ${total} transitions exceeded ` +
          `${input.settlementLatencyBudgetSeconds}s`,
      };
    },
  },
  {
    id: "reconciliation_discrepancies",
    severity: "critical",
    summary: "Reconciliation detected on-chain/off-chain discrepancies",
    impact:
      "A record in the system of record disagrees with chain state. This is " +
      "the signal that precedes an invariant breach, so it is blocking.",
    runbook:
      "Run the reconciliation report and compare the divergence against " +
      "INV-01/INV-04 before any manual repair.",
    forSamples: 1,
    evaluate: async (input) => {
      const critical = await input.registry.sumCounter("error_total", {
        service: "reconciliation",
        error_type: "critical_discrepancy",
      });
      const warning = await input.registry.sumCounter("error_total", {
        service: "reconciliation",
        error_type: "warning_discrepancy",
      });

      const total = critical + warning;
      if (total === 0) return null;

      return {
        value: total,
        threshold: 0,
        unit: "discrepancies",
        detail: `${critical} critical, ${warning} warning`,
      };
    },
  },
  {
    id: "error_budget_burn_rate_critical",
    severity: "critical",
    summary: "An enforced SLO is burning its error budget too fast",
    impact:
      "At this burn rate the 30-day error budget is exhausted in days rather " +
      "than weeks, so a release decision has to be made deliberately.",
    runbook:
      "Open `GET /admin/observability/slo`, find the breaching objective, and " +
      "use its `evidence` block to identify the failing route or dependency " +
      "before shipping anything else.",
    forSamples: 2,
    evaluate: async (input) => {
      const breaching = input.sloReport.objectives.filter(
        (objective) => objective.enforced && objective.status === "critical",
      );
      if (breaching.length === 0) return null;

      const worst = breaching.reduce((a, b) =>
        (b.burnRate ?? 0) > (a.burnRate ?? 0) ? b : a,
      );

      // The rule only fires for objectives already classified `critical`, so
      // by construction the burn rate has passed the objective's critical
      // threshold. The reported threshold is the worst objective's own budget
      // multiple, kept for display only.
      return {
        value: worst.burnRate ?? 0,
        threshold: 0,
        unit: "burn_rate",
        detail:
          `${breaching.map((o) => o.id).join(", ")} over budget ` +
          `(worst burn rate ${(worst.burnRate ?? 0).toFixed(1)}x)`,
      };
    },
  },
  {
    id: "webhook_dead_letter_queue_backlog",
    severity: "warning",
    summary: "Webhook deliveries are parked in the dead-letter queue",
    impact:
      "Subscribers are not receiving events. Delivery has already exhausted " +
      "its retry budget and now requires an operator replay.",
    runbook:
      "Inspect `GET /admin/operations/webhooks` for the backlog, then replay " +
      "individual deliveries through the operator replay tooling once the " +
      "subscriber endpoint is confirmed healthy.",
    forSamples: 2,
    evaluate: async (input) => {
      const dlq = await input.registry.gauge("webhook_dlq_size");
      if (dlq === null || dlq === 0) return null;

      return {
        value: dlq,
        threshold: 0,
        unit: "deliveries",
        detail: "DLQ non-empty",
      };
    },
  },
] as const;

export function listAlertRules(): readonly AlertRule[] {
  return ALERT_RULES;
}

export function getAlertRule(id: string): AlertRule | undefined {
  return ALERT_RULES.find((rule) => rule.id === id);
}
