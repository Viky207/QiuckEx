import { Injectable, Logger } from "@nestjs/common";

import { AppConfigService } from "../../config/app-config.service";
import { MetricsService } from "../../metrics/metrics.service";
import { RegistryReader } from "../metrics/registry-reader";
import { SloService } from "../slo/slo.service";
import { AlertMeasurement, AlertRule, listAlertRules } from "./alert-rules";

/** Settlement latency budget, shared with the SLO engine. */
export const SETTLEMENT_LATENCY_BUDGET_SECONDS = 60;

export type AlertState = "ok" | "pending" | "firing" | "no_data";

export interface AlertStatus {
  id: string;
  severity: AlertRule["severity"];
  summary: string;
  impact: string;
  runbook: string;
  state: AlertState;
  /** Consecutive evaluations the condition has currently held. */
  consecutiveHits: number;
  /** Consecutive evaluations required before the alert fires. */
  forSamples: number;
  /** Latest measurement, or `null` when the rule could not be evaluated. */
  measurement: AlertMeasurement | null;
  /** ISO timestamp of the first evaluation in the current pending run. */
  pendingSince: string | null;
  /** ISO timestamp the alert transitioned into `firing`. */
  firingSince: string | null;
  lastEvaluatedAt: string;
}

export interface AlertEvaluationReport {
  evaluatedAt: string;
  metricsAvailable: boolean;
  firing: number;
  pending: number;
  alerts: AlertStatus[];
}

interface RuleState {
  consecutiveHits: number;
  pendingSince: string | null;
  firingSince: string | null;
  lastState: AlertState;
  measurement: AlertMeasurement | null;
}

/**
 * Evaluates the alert rules and keeps the resulting state machine.
 *
 * The service is deliberately pull-based: `evaluate()` is called on a schedule
 * and on demand by the admin endpoint, and the same function produces the state
 * either way. There is no separate "notification" path, so an operator reading
 * `/admin/observability/alerts` sees exactly what the scheduler saw.
 *
 * Degraded-mode behaviour: if the metrics registry is unavailable, or a rule
 * cannot be evaluated, that rule reports `no_data` and does not fire. Losing
 * observability must not manufacture an incident.
 */
@Injectable()
export class AlertingService {
  private readonly logger = new Logger(AlertingService.name);
  private readonly states = new Map<string, RuleState>();

  constructor(
    private readonly metrics: MetricsService,
    private readonly sloService: SloService,
    private readonly config: AppConfigService,
  ) {}

  listRules(): readonly AlertRule[] {
    return listAlertRules();
  }

  /** Evaluate every rule once and return the resulting states. */
  async evaluate(): Promise<AlertEvaluationReport> {
    const registry = new RegistryReader(this.metrics.getRegistry());
    const sloReport = await this.sloService.getReport();
    const evaluatedAt = new Date().toISOString();

    const input = {
      registry,
      sloReport,
      indexerLagThresholdLedgers: this.config.indexerLagThresholdLedgers,
      settlementLatencyBudgetSeconds: SETTLEMENT_LATENCY_BUDGET_SECONDS,
    };

    const alerts = await Promise.all(
      listAlertRules().map((rule) =>
        this.evaluateRule(rule, input, evaluatedAt),
      ),
    );

    return {
      evaluatedAt,
      metricsAvailable: registry.isAvailable,
      firing: alerts.filter((alert) => alert.state === "firing").length,
      pending: alerts.filter((alert) => alert.state === "pending").length,
      alerts,
    };
  }

  private async evaluateRule(
    rule: AlertRule,
    input: Parameters<AlertRule["evaluate"]>[0],
    evaluatedAt: string,
  ): Promise<AlertStatus> {
    const state: RuleState = this.states.get(rule.id) ?? {
      consecutiveHits: 0,
      pendingSince: null,
      firingSince: null,
      lastState: "ok",
      measurement: null,
    };

    state.measurement = await this.measure(rule, input);
    state.lastState = this.nextState(rule, state, evaluatedAt);

    this.states.set(rule.id, state);

    return {
      id: rule.id,
      severity: rule.severity,
      summary: rule.summary,
      impact: rule.impact,
      runbook: rule.runbook,
      state: state.lastState,
      consecutiveHits: state.consecutiveHits,
      forSamples: rule.forSamples,
      measurement: state.measurement,
      pendingSince: state.pendingSince,
      firingSince: state.firingSince,
      lastEvaluatedAt: evaluatedAt,
    };
  }

  /**
   * Measure a rule defensively. A rule that throws is reported as unmeasured
   * rather than allowed to take the whole evaluator down, and the rule id is
   * logged so a broken rule is identifiable in the logs.
   */
  private async measure(
    rule: AlertRule,
    input: Parameters<AlertRule["evaluate"]>[0],
  ): Promise<AlertMeasurement | null> {
    try {
      return await rule.evaluate(input);
    } catch (error) {
      this.logger.error(
        `Alert rule ${rule.id} threw during evaluation: ` +
          `${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Advance the `for`-clause state machine and announce transitions.
   *
   * `pending` is the state between "the condition is true" and "the condition
   * has held long enough to fire"; surfacing it lets an operator watch an alert
   * build before it pages anyone.
   */
  private nextState(
    rule: AlertRule,
    state: RuleState,
    evaluatedAt: string,
  ): AlertState {
    if (state.measurement === null) {
      state.consecutiveHits = 0;
      state.pendingSince = null;
      state.firingSince = null;
      return "no_data";
    }

    if (!isBreaching(state.measurement)) {
      // Recovery path: reset the counter and announce the resolution once, so a
      // recovered alert does not silently disappear from the operator's view.
      const wasFiring = state.firingSince !== null;
      state.consecutiveHits = 0;
      state.pendingSince = null;
      state.firingSince = null;

      if (wasFiring) {
        this.logger.log(`Alert resolved: ${rule.id} (${rule.severity})`);
      }
      return "ok";
    }

    state.consecutiveHits += 1;
    state.pendingSince = state.pendingSince ?? evaluatedAt;

    if (state.consecutiveHits < rule.forSamples) return "pending";

    if (!state.firingSince) {
      state.firingSince = evaluatedAt;
      this.logger.error(
        `Alert firing: ${rule.id} (${rule.severity}) — ` +
          `${state.measurement.detail}`,
      );
    }
    return "firing";
  }

  /** Test seam: drop all accumulated `for`-clause state. */
  resetState(): void {
    this.states.clear();
  }
}

/**
 * A measurement breaches its rule when it exceeds the rule's threshold. Rules
 * with a zero threshold are "any occurrence is a breach" rules (a non-empty
 * DLQ, a reconciliation discrepancy), which is exactly what an operator needs
 * to be told about even once.
 */
function isBreaching(measurement: AlertMeasurement): boolean {
  return measurement.value > measurement.threshold;
}
