import { Injectable } from "@nestjs/common";

import { MetricsService } from "../../metrics/metrics.service";
import { RegistryReader } from "../metrics/registry-reader";
import {
  BURN_RATE_WINDOW_SECONDS,
  SLO_DEFINITIONS,
  SloDefinition,
  SloStatus,
  classifySlo,
  computeBurnRate,
  errorBudgetRatio,
  listSloDefinitions,
  remainingErrorBudget,
} from "./slo.definitions";

/** Raw counters behind an objective's ratio, so an operator can audit the math. */
export interface SloEvidence {
  /** Total events counted for the path. */
  total: number;
  /** Events counted as good for the path. */
  good: number;
  /** Events counted as bad for the path. */
  bad: number;
  /** Series consulted, for traceability. */
  source: string;
}

/** One objective's evaluated state, as returned to operators. */
export interface SloEvaluation {
  id: string;
  path: SloDefinition["path"];
  kind: SloDefinition["kind"];
  description: string;
  enforced: boolean;
  target: number;
  windowSeconds: number;
  errorBudgetRatio: number;
  /** Observed compliance ratio (0-1), or `null` when nothing was observed. */
  observedRatio: number | null;
  /** Burn rate as a multiple of the budget. `null` when unobserved. */
  burnRate: number | null;
  /** Remaining budget as a ratio (0-1). Negative means over budget. */
  remainingBudgetRatio: number | null;
  status: SloStatus;
  /** Seconds of real elapsed time behind the observation. */
  observationSeconds: number;
  evidence: SloEvidence;
}

export interface SloReport {
  generatedAt: string;
  /** False when the metrics registry is unavailable; the report is advisory. */
  metricsAvailable: boolean;
  /** Burn-rate model window (always 30 days). */
  burnRateWindowSeconds: number;
  /** Worst status across all enforced objectives. */
  overallStatus: SloStatus;
  objectives: SloEvaluation[];
}

/**
 * Route prefixes owned by each SLO path. Kept as prefix matching (rather than
 * exact routes) so a newly added endpoint under an owned prefix is covered by
 * the objective automatically instead of silently escaping it.
 */
const ROUTE_PREFIXES: Record<"payment" | "link", string[]> = {
  payment: ["/payments", "/transactions"],
  link: ["/links", "/payment-links"],
};

/** Settlement latency budget: 60s from transition start to terminal state. */
const SETTLEMENT_LATENCY_BUDGET_SECONDS = 60;

const UNMEASURED_EVIDENCE: SloEvidence = {
  total: 0,
  good: 0,
  bad: 0,
  source: "unmeasured",
};

/**
 * Computes the SLI for each objective from the live Prometheus registry and
 * derives the error-budget burn rate.
 *
 * Degraded-mode behaviour: when the registry is not initialized the service
 * still returns a well-formed report, with every objective marked
 * `insufficient_data` and `metricsAvailable: false`. Operators can therefore
 * always ask "what are the SLOs?" and get a stable, documented shape.
 */
@Injectable()
export class SloService {
  private readonly startedAtMs = Date.now();

  constructor(private readonly metrics: MetricsService) {}

  /** Uptime-bounded observation window, in seconds. */
  get observationSeconds(): number {
    return Math.max(1, Math.floor((Date.now() - this.startedAtMs) / 1000));
  }

  listObjectives(): readonly SloDefinition[] {
    return listSloDefinitions();
  }

  getDefinition(id: string): SloDefinition | undefined {
    return SLO_DEFINITIONS.find((slo) => slo.id === id);
  }

  /** Evaluate every objective in the catalog. */
  async getReport(): Promise<SloReport> {
    const reader = new RegistryReader(this.metrics.getRegistry());
    const objectives = await Promise.all(
      SLO_DEFINITIONS.map((definition) => this.evaluate(definition, reader)),
    );

    return {
      generatedAt: new Date().toISOString(),
      metricsAvailable: reader.isAvailable,
      burnRateWindowSeconds: BURN_RATE_WINDOW_SECONDS,
      overallStatus: worstStatus(objectives),
      objectives,
    };
  }

  /** Evaluate a single objective by id, or `undefined` when unknown. */
  async getObjective(id: string): Promise<SloEvaluation | undefined> {
    const definition = this.getDefinition(id);
    if (!definition) return undefined;

    return this.evaluate(
      definition,
      new RegistryReader(this.metrics.getRegistry()),
    );
  }

  private async evaluate(
    definition: SloDefinition,
    reader: RegistryReader,
  ): Promise<SloEvaluation> {
    const { observedRatio, evidence } = await this.measure(definition, reader);

    return {
      id: definition.id,
      path: definition.path,
      kind: definition.kind,
      description: definition.description,
      enforced: definition.enforced,
      target: definition.target,
      windowSeconds: definition.windowSeconds,
      errorBudgetRatio: errorBudgetRatio(definition),
      observedRatio,
      burnRate: computeBurnRate(observedRatio, definition),
      remainingBudgetRatio: remainingErrorBudget(observedRatio, definition),
      status: classifySlo(observedRatio, definition),
      observationSeconds: this.observationSeconds,
      evidence,
    };
  }

  /**
   * Derive the raw good/bad event counts behind an objective.
   *
   * Every path returns `observedRatio: null` when the denominator is zero, so
   * "no traffic" is never reported as "100% healthy".
   */
  private async measure(
    definition: SloDefinition,
    reader: RegistryReader,
  ): Promise<{ observedRatio: number | null; evidence: SloEvidence }> {
    switch (definition.id) {
      case "payment_availability":
        return this.measureRouteAvailability(reader, ROUTE_PREFIXES.payment);
      case "link_availability":
        return this.measureRouteAvailability(reader, ROUTE_PREFIXES.link);
      case "indexing_freshness":
        return this.measureIndexerFreshness(reader);
      case "notification_delivery":
        return this.measureNotificationDelivery(reader);
      case "settlement_latency":
        return this.measureSettlementLatency(reader);
      default:
        return { observedRatio: null, evidence: { ...UNMEASURED_EVIDENCE } };
    }
  }

  /**
   * Availability = 1 - (5xx responses / all responses) for the owned routes.
   * 4xx responses count as good: a malformed request is the caller's problem
   * and must not burn the availability budget.
   */
  private async measureRouteAvailability(
    reader: RegistryReader,
    prefixes: string[],
  ): Promise<{ observedRatio: number | null; evidence: SloEvidence }> {
    const matches = (labels: Record<string, string>): boolean =>
      prefixes.some((prefix) => (labels["route"] ?? "").startsWith(prefix));

    const source = "http_requests_total{route,status_code}";
    const total = await reader.sumCounterWhere("http_requests_total", matches);
    const bad = await reader.sumCounterWhere(
      "http_requests_total",
      (labels) => matches(labels) && isServerError(labels["status_code"]),
    );

    return {
      observedRatio: ratioOrNull(total - bad, total),
      evidence: { total, good: total - bad, bad, source },
    };
  }

  /**
   * Freshness: the indexer-lag gauge is sampled, and the objective is met while
   * the lag guard reports the indexer is within its threshold. A single gauge
   * reading can only prove "the last sample was good", so the evidence carries
   * the observed lag explicitly.
   */
  private async measureIndexerFreshness(
    reader: RegistryReader,
  ): Promise<{ observedRatio: number | null; evidence: SloEvidence }> {
    const lag = await reader.gauge("indexer_lag_ledgers");
    const guardStatus = await reader.gauge("indexer_lag_guard_status");

    if (lag === null) {
      return { observedRatio: null, evidence: { ...UNMEASURED_EVIDENCE } };
    }

    // Guard status 3 means the guard is currently reporting lag over threshold.
    const lagging = guardStatus === 3;
    const good = lagging ? 0 : 1;

    return {
      observedRatio: good,
      evidence: {
        total: 1,
        good,
        bad: 1 - good,
        source: `indexer_lag_ledgers=${lag} (lagging=${lagging})`,
      },
    };
  }

  /**
   * Notification delivery: success ratio over recorded webhook delivery
   * durations. Replays are excluded because they are operator-initiated and
   * their outcome is not a property of the notification path.
   */
  private async measureNotificationDelivery(
    reader: RegistryReader,
  ): Promise<{ observedRatio: number | null; evidence: SloEvidence }> {
    const metric = "webhook_delivery_duration_seconds";
    const source = `${metric}{status}`;
    const notReplay = (labels: Record<string, string>): boolean =>
      (labels["trigger"] ?? "delivery") !== "replay";

    const total = await reader.histogramCountWhere(metric, notReplay);
    const good = await reader.histogramCountWhere(
      metric,
      (labels) => notReplay(labels) && isSuccessStatus(labels["status"]),
    );

    if (total === null || good === null || total === 0) {
      return {
        observedRatio: null,
        evidence: { total: total ?? 0, good: 0, bad: 0, source },
      };
    }

    return {
      observedRatio: good / total,
      evidence: { total, good, bad: total - good, source },
    };
  }

  /**
   * Settlement latency: the share of escrow state transitions that completed
   * inside the latency budget. Transitions longer than the budget are bad
   * events and burn the budget exactly like a failed settlement would.
   */
  private async measureSettlementLatency(
    reader: RegistryReader,
  ): Promise<{ observedRatio: number | null; evidence: SloEvidence }> {
    const metric = "escrow_state_transition_duration_seconds";
    const source = `${metric} <= ${SETTLEMENT_LATENCY_BUDGET_SECONDS}s`;
    const total = await reader.histogramCount(metric);
    const good = await reader.histogramCountAtOrBelow(
      metric,
      SETTLEMENT_LATENCY_BUDGET_SECONDS,
    );

    if (total === null || good === null || total === 0) {
      return {
        observedRatio: null,
        evidence: { total: total ?? 0, good: 0, bad: 0, source },
      };
    }

    return {
      observedRatio: good / total,
      evidence: {
        total,
        good,
        bad: total - good,
        source,
      },
    };
  }
}

function isServerError(statusCode: string | undefined): boolean {
  const parsed = Number(statusCode);
  return Number.isFinite(parsed) && parsed >= 500;
}

function isSuccessStatus(status: string | undefined): boolean {
  return status === "success" || status === "sent";
}

function ratioOrNull(good: number, total: number): number | null {
  if (total <= 0) return null;
  return good / total;
}

const STATUS_SEVERITY: Record<SloStatus, number> = {
  ok: 0,
  insufficient_data: 1,
  warning: 2,
  critical: 3,
};

/**
 * Worst status across the enforced objectives. Advisory (`enforced: false`)
 * objectives are excluded so a settling objective can never make an operator
 * think mainnet is blocked.
 */
function worstStatus(objectives: SloEvaluation[]): SloStatus {
  const enforced = objectives.filter((objective) => objective.enforced);
  if (enforced.length === 0) return "insufficient_data";

  return enforced.reduce<SloStatus>((worst, objective) => {
    return STATUS_SEVERITY[objective.status] > STATUS_SEVERITY[worst]
      ? objective.status
      : worst;
  }, "ok");
}
