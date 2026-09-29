/**
 * Canonical service-level objectives for QuickEx.
 *
 * Each objective is expressed against metrics that already exist in the
 * Prometheus registry (`MetricsService`), so an objective is never a second,
 * parallel source of truth: the SLI is derived from the same series the
 * dashboards and alerts read.
 *
 * SLO semantics:
 *  - `windowSeconds` is the rolling evaluation window. Because the backend keeps
 *    its counters in-process, the window is bounded by process uptime rather
 *    than by wall-clock history: a restart resets the observation. Every report
 *    therefore carries the actual observation window so an operator can tell a
 *    freshly started process from a settled one.
 *  - `target` is the compliance ratio (0-1) the path must hold.
 *  - `errorBudgetRatio` is `1 - target` — the share of events allowed to be bad
 *    before the budget is exhausted.
 *  - `burnRateCritical` / `burnRateWarning` use the multi-window burn-rate
 *    model: a burn rate of `B` consumes the whole 30-day budget in `30d / B`.
 *    The 14.4x/6x pairs are the standard fast/slow burn thresholds.
 */

/** Paths covered by the SLO catalog. Mirrors the issue scope. */
export type SloPath = "payment" | "link" | "indexing" | "notification";

export type SloKind = "availability" | "latency" | "freshness";

export interface SloDefinition {
  /** Stable, machine-readable identifier used as a Prometheus label value. */
  id: string;
  path: SloPath;
  kind: SloKind;
  /** Human-readable description surfaced in the admin report and docs. */
  description: string;
  /** Compliance ratio (0-1) the path must hold over the window. */
  target: number;
  /** Rolling evaluation window in seconds. */
  windowSeconds: number;
  /** Burn rate that exhausts the 30-day budget within ~2 days. */
  burnRateCritical: number;
  /** Burn rate that exhausts the 30-day budget within ~5 days. */
  burnRateWarning: number;
  /**
   * Whether a breach of this objective blocks mainnet promotion. Objectives
   * that are still settling are `false` and reported as advisory.
   */
  enforced: boolean;
}

/** Full 30-day window used by the burn-rate model. */
export const BURN_RATE_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/**
 * Standard burn-rate thresholds (multi-window, multi-burn-rate model).
 * 14.4x exhausts a 30-day budget in ~2 days; 6x in ~5 days.
 */
/**
 * Standard burn-rate thresholds (multi-window, multi-burn-rate model).
 * 14.4x exhausts a 30-day budget in ~2 days; 6x in ~5 days.
 */
const DEFAULT_BURN_CRITICAL = 14.4;
const DEFAULT_BURN_WARNING = 6;

export const SLO_DEFINITIONS: readonly SloDefinition[] = [
  {
    id: "payment_availability",
    path: "payment",
    kind: "availability",
    description:
      "Payment status and transaction endpoints return a non-5xx response for " +
      "at least 99.5% of requests over 7 days.",
    target: 0.995,
    windowSeconds: 7 * 24 * 60 * 60,
    burnRateCritical: DEFAULT_BURN_CRITICAL,
    burnRateWarning: DEFAULT_BURN_WARNING,
    enforced: true,
  },
  {
    id: "link_availability",
    path: "link",
    kind: "availability",
    description:
      "Payment-link resolution, status and generation endpoints return a " +
      "non-5xx response for at least 99.5% of requests over 7 days.",
    target: 0.995,
    windowSeconds: 7 * 24 * 60 * 60,
    burnRateCritical: DEFAULT_BURN_CRITICAL,
    burnRateWarning: DEFAULT_BURN_WARNING,
    enforced: true,
  },
  {
    id: "indexing_freshness",
    path: "indexing",
    kind: "freshness",
    description:
      "Contract event indexing keeps up with the network: observed indexer lag " +
      "stays within the configured ledger threshold for at least 99% of samples.",
    target: 0.99,
    windowSeconds: 24 * 60 * 60,
    burnRateCritical: DEFAULT_BURN_CRITICAL,
    burnRateWarning: DEFAULT_BURN_WARNING,
    enforced: true,
  },
  {
    id: "notification_delivery",
    path: "notification",
    kind: "availability",
    description:
      "Webhook notification deliveries succeed (2xx) for at least 99% of " +
      "attempts over 7 days, excluding operator-initiated replays.",
    target: 0.99,
    windowSeconds: 7 * 24 * 60 * 60,
    burnRateCritical: DEFAULT_BURN_CRITICAL,
    burnRateWarning: DEFAULT_BURN_WARNING,
    enforced: true,
  },
  {
    id: "settlement_latency",
    path: "payment",
    kind: "latency",
    description:
      "Settlement state transitions reach a terminal state within the " +
      "settlement latency budget for at least 99% of transitions over 7 days.",
    target: 0.99,
    windowSeconds: 7 * 24 * 60 * 60,
    burnRateCritical: DEFAULT_BURN_CRITICAL,
    burnRateWarning: DEFAULT_BURN_WARNING,
    enforced: false,
  },
] as const;

export function getSloDefinition(id: string): SloDefinition | undefined {
  return SLO_DEFINITIONS.find((slo) => slo.id === id);
}

export function listSloDefinitions(): readonly SloDefinition[] {
  return SLO_DEFINITIONS;
}

/** Ratio of events allowed to be bad before the error budget is exhausted. */
export function errorBudgetRatio(definition: SloDefinition): number {
  return 1 - definition.target;
}

/**
 * Burn rate = observed bad-event ratio / allowed bad-event ratio.
 * Returns `null` when there is nothing to measure yet (no observations).
 */
export function computeBurnRate(
  observedRatio: number | null,
  definition: SloDefinition,
): number | null {
  if (observedRatio === null) return null;

  const budget = errorBudgetRatio(definition);
  if (budget <= 0) return null;

  const badRatio = Math.max(0, 1 - observedRatio);
  return badRatio / budget;
}

/**
 * Remaining error budget as a ratio (0-1) of the total budget. `1` means the
 * budget is untouched, `0` means it is exhausted, and a negative value means
 * the path is over budget by that fraction.
 */
export function remainingErrorBudget(
  observedRatio: number | null,
  definition: SloDefinition,
): number | null {
  const burnRate = computeBurnRate(observedRatio, definition);
  if (burnRate === null) return null;
  return 1 - burnRate;
}

export type SloStatus = "ok" | "warning" | "critical" | "insufficient_data";

/**
 * Classify an objective from its burn rate. Burn-rate classification (rather
 * than a raw target comparison) is what makes the objective resistant to a
 * single noisy sample: a brief blip that does not sustain a burn rate stays
 * `ok`.
 */
export function classifySlo(
  observedRatio: number | null,
  definition: SloDefinition,
): SloStatus {
  const burnRate = computeBurnRate(observedRatio, definition);
  if (burnRate === null) return "insufficient_data";
  if (burnRate >= definition.burnRateCritical) return "critical";
  if (burnRate >= definition.burnRateWarning) return "warning";
  return "ok";
}

