import * as client from "prom-client";

/**
 * Minimal read-only view over the Prometheus registry.
 *
 * The SLO engine and the alert evaluator both need to *read* the same series
 * the `/metrics` endpoint exports, without scraping themselves. Reading the
 * registry in-process keeps a single source of truth and avoids a Prometheus
 * round-trip from the API process back to itself.
 *
 * Every accessor is total: a missing metric, or a registry that was never
 * initialized, returns `null` (or `0` for counters) instead of throwing, so a
 * degraded metrics subsystem degrades the SLO report rather than the API.
 *
 * The accessors are async because prom-client v15 only exposes values through
 * `getMetricsAsJSON()`, which is promise-based. Callers therefore always see
 * the same shape whether the registry is healthy or not.
 */
export class RegistryReader {
  private readonly registry: client.Registry | undefined;

  constructor(registry: client.Registry | undefined) {
    this.registry = registry;
  }

  get isAvailable(): boolean {
    return Boolean(this.registry);
  }

  /**
   * Sum a counter across all series matching `labels`.
   * Returns `0` when the counter has not been incremented yet.
   */
  async sumCounter(
    name: string,
    labels: Record<string, string> = {},
  ): Promise<number> {
    const series = await this.findSeries(name);
    if (!series) return 0;

    return sumMatching(series, labels);
  }

  /**
   * Read a gauge, summing series that match `labels`.
   * Returns `null` when the gauge has never been set (no observation yet).
   */
  async gauge(
    name: string,
    labels: Record<string, string> = {},
  ): Promise<number | null> {
    const series = await this.findSeries(name);
    if (!series || series.length === 0) return null;

    return sumMatching(series, labels);
  }

  /**
   * Sum across every series of a counter that passes a predicate. Used for
   * path-scoped SLIs where the route is a label rather than an exact value.
   */
  async sumCounterWhere(
    name: string,
    predicate: (labels: Record<string, string>) => boolean,
  ): Promise<number> {
    const series = await this.findSeries(name);
    if (!series) return 0;

    return series
      .filter((entry) => predicate(entry.labels))
      .reduce((total, entry) => total + entry.value, 0);
  }

  /**
   * Total observation count of a histogram, optionally filtered by labels.
   * This is the denominator that turns "requests observed" into an SLI.
   */
  async histogramCount(
    name: string,
    labels: Record<string, string> = {},
  ): Promise<number | null> {
    const series = await this.findSeries(name, "_count");
    if (!series || series.length === 0) return null;

    return sumMatching(series, labels);
  }

  /**
   * Count of histogram observations at or below `upperBoundSeconds`.
   *
   * Prometheus histogram buckets are *cumulative*, so the answer is the single
   * bucket with the largest `le` that is still within the bound — summing the
   * buckets would multiply-count every observation. Series that differ only by
   * their label set are summed, because each is its own histogram.
   *
   * Returns `null` when no bucket falls within the bound (nothing to conclude
   * yet) so an unmeasured bound is never reported as "zero slow requests".
   */
  async histogramCountAtOrBelow(
    name: string,
    upperBoundSeconds: number,
    labels: Record<string, string> = {},
  ): Promise<number | null> {
    const buckets = await this.findSeries(name, "_bucket");
    if (!buckets || buckets.length === 0) return null;

    // Group by label set (ignoring `le`) so each histogram contributes once.
    const perHistogram = new Map<string, { le: number; value: number }>();

    for (const bucket of buckets) {
      if (!matchesLabels(bucket.labels, labels)) continue;

      const le = Number(bucket.labels["le"]);
      if (!Number.isFinite(le) || le > upperBoundSeconds) continue;

      const key = labelSetKey(bucket.labels);
      const current = perHistogram.get(key);

      if (!current || le > current.le) {
        perHistogram.set(key, { le, value: bucket.value });
      }
    }

    if (perHistogram.size === 0) return null;

    return [...perHistogram.values()].reduce(
      (total, entry) => total + entry.value,
      0,
    );
  }

  /** Histogram observation count restricted by a label predicate. */
  async histogramCountWhere(
    name: string,
    predicate: (labels: Record<string, string>) => boolean,
  ): Promise<number | null> {
    const series = await this.findSeries(name, "_count");
    if (!series) return null;

    const matching = series.filter((entry) => predicate(entry.labels));
    if (matching.length === 0) return null;

    return matching.reduce((total, entry) => total + entry.value, 0);
  }

  /**
   * Look up the series of a metric.
   *
   * A histogram is a single registry family whose values carry a `metricName`
   * of `<name>_count` / `<name>_sum` / `<name>_bucket`, so `suffix` selects
   * which projection of it is wanted. Counters and gauges need no suffix: their
   * values are already at the family level.
   */
  private async findSeries(
    name: string,
    suffix?: "_count" | "_bucket" | "_sum",
  ): Promise<RegistrySeries | null> {
    if (!this.registry) return null;

    let families: RegistryFamily[];
    try {
      families =
        (await this.registry.getMetricsAsJSON()) as unknown as RegistryFamily[];
    } catch {
      return null;
    }

    const family = (families ?? []).find((entry) => entry.name === name);
    if (!family?.values) return null;

    const values = suffix
      ? family.values.filter((entry) => entry.metricName === `${name}${suffix}`)
      : family.values;

    return values.map((entry) => ({
      labels: (entry.labels ?? {}) as Record<string, string>,
      value: entry.value,
    }));
  }
}

type RegistrySeries = Array<{
  labels: Record<string, string>;
  value: number;
}>;

type RegistryFamily = {
  name: string;
  values?: Array<{
    /** `<name>_count` / `<name>_sum` / `<name>_bucket` for histograms. */
    metricName?: string;
    labels?: Record<string, string>;
    value: number;
  }>;
};

function sumMatching(
  series: RegistrySeries,
  labels: Record<string, string>,
): number {
  return series
    .filter((entry) => matchesLabels(entry.labels, labels))
    .reduce((total, entry) => total + entry.value, 0);
}

/** Stable identity for a label set, ignoring the histogram's `le` label. */
function labelSetKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .filter(([key]) => key !== "le")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function matchesLabels(
  actual: Record<string, string>,
  expected: Record<string, string>,
): boolean {
  return Object.entries(expected).every(
    ([key, value]) => actual[key] === value,
  );
}
