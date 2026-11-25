"use client";

/**
 * AnalyticsDashboard.tsx
 *
 * Interactive analytics dashboard for QuickEx (Issue #175).
 * Charts: Area (volume), Line (tx count), Donut (asset distribution).
 * Fully responsive and themed to QuickEx dark-glass aesthetic.
 */

import { useEffect, useState, useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import type {
  ValueType,
  NameType,
} from "recharts/types/component/DefaultTooltipContent";
import {
  fetchAnalytics,
  exportAnalyticsReport,
  getAnalyticsFreshness,
  invalidateAnalyticsCache,
  type DateRange,
  type AnalyticsData,
  type AnalyticsFreshness,
} from "@/hooks/analyticsApi";
import { getQuickexApiBase } from "@/lib/api";
import { resolvePublicKey } from "@/lib/publicKey";

// ─── Date-range filter ────────────────────────────────────────────────────────

const RANGES: { label: string; value: DateRange }[] = [
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "All Time", value: "all" },
];

const RANGE_QUERY_PARAM = "range";

function isDateRange(value: string | null): value is DateRange {
  return value === "24h" || value === "7d" || value === "30d" || value === "all";
}

function DateRangeFilter({
  active,
  onChange,
}: {
  active: DateRange;
  onChange: (r: DateRange) => void;
}) {
  return (
    <div className="inline-flex gap-1 p-1 rounded-xl bg-surface border border-border">
      {RANGES.map((r) => (
        <button
          key={r.value}
          id={`analytics-range-${r.value}`}
          onClick={() => onChange(r.value)}
          className={`px-3 py-1.5 text-xs font-black rounded-lg transition-all ${
            active === r.value
              ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/20"
              : "text-subtle hover:text-foreground hover:bg-surface"
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

// ─── Shared tooltip styles ────────────────────────────────────────────────────

const tooltipStyle = {
  contentStyle: {
    background: "var(--chart-tooltip-bg)",
    border: "1px solid var(--chart-tooltip-border)",
    borderRadius: "12px",
    color: "var(--chart-tooltip-text)",
    fontSize: "12px",
    boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
  },
  labelStyle: { color: "var(--brand)", fontWeight: 800 },
  cursor: { stroke: "rgba(99,102,241,0.3)", strokeWidth: 2 },
};

// ─── Skeleton loader ──────────────────────────────────────────────────────────

function ChartSkeleton() {
  return (
    <div className="animate-pulse flex flex-col gap-3 h-full">
      <div className="h-4 bg-surface rounded w-1/3" />
      <div className="flex-1 bg-surface rounded-2xl" />
    </div>
  );
}

// ─── Stat card used in the summary row ───────────────────────────────────────

function StatCard({
  label,
  value,
  change,
}: {
  label: string;
  value: string;
  change?: number;
}) {
  const positive = (change ?? 0) >= 0;
  return (
    <div className="p-5 rounded-2xl bg-surface border border-border flex flex-col gap-1">
      <p className="text-[10px] font-black uppercase tracking-widest text-subtle">
        {label}
      </p>
      <p className="text-2xl font-black">{value}</p>
      {change !== undefined && (
        <span
          className={`text-[11px] font-black px-2 py-0.5 w-fit rounded-lg ${
            positive
              ? "text-emerald-400 bg-emerald-400/10"
              : "text-red-400 bg-red-400/10"
          }`}
        >
          {positive ? "+" : ""}
          {change}%
        </span>
      )}
    </div>
  );
}

// ─── Custom Donut label ───────────────────────────────────────────────────────

function DonutLabel({
  cx,
  cy,
  total,
}: {
  cx: number;
  cy: number;
  total: number;
}) {
  return (
    <>
      <text
        x={cx}
        y={cy - 8}
        textAnchor="middle"
        fill="var(--brand)"
        style={{ fontSize: 11, fontWeight: 900, letterSpacing: 2 }}
      >
        TOTAL
      </text>
      <text
        x={cx}
        y={cy + 12}
        textAnchor="middle"
        fill="var(--chart-tooltip-text)"
        style={{ fontSize: 18, fontWeight: 900 }}
      >
        {total}%
      </text>
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AnalyticsDashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialRange = isDateRange(searchParams.get(RANGE_QUERY_PARAM))
    ? (searchParams.get(RANGE_QUERY_PARAM) as DateRange)
    : "30d";
  const [range, setRangeState] = useState<DateRange>(initialRange);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [freshness, setFreshness] = useState<AnalyticsFreshness | null>(null);
  const [loading, setLoading] = useState(true);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [reportType, setReportType] = useState<"accounting" | "tax">("accounting");
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const load = useCallback((r: DateRange) => {
    setLoading(true);
    fetchAnalytics(r).then((d) => {
      setData(d);
      setFreshness(getAnalyticsFreshness(r) ?? null);
      setLoading(false);
    });
  }, []);

  const setRange = useCallback(
    (r: DateRange) => {
      setRangeState(r);
      const params = new URLSearchParams(searchParams.toString());
      params.set(RANGE_QUERY_PARAM, r);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  useEffect(() => {
    const fromUrl = searchParams.get(RANGE_QUERY_PARAM);
    if (isDateRange(fromUrl) && fromUrl !== range) {
      setRangeState(fromUrl);
    }
    // Only react to external URL changes (e.g. back/forward navigation);
    // `range` itself is intentionally excluded to avoid a feedback loop with `setRange`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    load(range);
  }, [range, load]);

  useEffect(() => {
    const streamUrl = new URL(`${getQuickexApiBase()}/analytics/events`);
    streamUrl.searchParams.set("publicKey", resolvePublicKey());
    const source = new EventSource(streamUrl.toString());
    const handleUpdate = () => {
      invalidateAnalyticsCache(range);
      load(range);
    };

    source.onopen = () => setRealtimeConnected(true);
    source.onerror = () => setRealtimeConnected(false);
    source.addEventListener("analytics.updated", handleUpdate);

    return () => {
      source.removeEventListener("analytics.updated", handleUpdate);
      source.close();
    };
  }, [load, range]);

  useEffect(() => {
    if (!exportMessage) return;
    const timer = window.setTimeout(() => setExportMessage(null), 3200);
    return () => window.clearTimeout(timer);
  }, [exportMessage]);

  const handleExport = useCallback(async (format: "csv" | "pdf") => {
    setExporting(format);
    setExportMessage(null);
    try {
      await exportAnalyticsReport(range, format, reportType);
      setExportMessage(`${format.toUpperCase()} report generated.`);
    } catch (error) {
      console.error(error);
      setExportMessage(`Failed to export ${format.toUpperCase()} report.`);
    } finally {
      setExporting(null);
    }
  }, [range, reportType]);

  const { summary, volume, txCount, assetDist } = data ?? {
    summary: null,
    volume: [],
    txCount: [],
    assetDist: [],
  };

  const fmt = (n: number) =>
    n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n}`;

  return (
    <section
      id="analytics-dashboard"
      className="rounded-3xl bg-card border border-border backdrop-blur-2xl shadow-2xl overflow-hidden"
    >
      {/* ── Header ── */}
      <div className="p-6 sm:p-10 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-black mb-1">
            Analytics Overview
          </h2>
          <p className="text-xs sm:text-sm text-subtle">
            Payment volume, transaction counts &amp; asset distribution
          </p>
          <p className="mt-2 text-[11px] font-bold text-muted" aria-live="polite">
            <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${realtimeConnected ? "bg-emerald-400" : "bg-amber-400"}`} />
            {realtimeConnected ? "Live updates enabled" : "Live updates reconnecting"}
          </p>
          {freshness ? (
            <p className="mt-1 text-[11px] font-bold text-muted" aria-live="polite">
              {freshness.failed ? (
                <span className="rounded-full bg-danger/10 px-2 py-0.5 text-danger">
                  Unavailable — showing last known values
                </span>
              ) : freshness.cached ? (
                <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-amber-500">
                  Cached as of{" "}
                  {new Date(freshness.fetchedAt).toLocaleTimeString()}
                </span>
              ) : (
                <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-success">
                  Updated as of{" "}
                  {new Date(freshness.fetchedAt).toLocaleTimeString()}
                </span>
              )}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-3 sm:items-end">
          <DateRangeFilter active={range} onChange={setRange} />
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
            <label className="text-[10px] font-black uppercase tracking-widest text-subtle sm:sr-only" htmlFor="analytics-report-type">
              Report type
            </label>
            <select
              id="analytics-report-type"
              value={reportType}
              onChange={(event) =>
                setReportType(event.target.value as "accounting" | "tax")
              }
              className="w-full rounded-lg border border-border-strong bg-surface px-2 py-2 text-xs font-black text-muted sm:w-auto"
            >
              <option value="accounting">Accounting</option>
              <option value="tax">Tax</option>
            </select>
            <fieldset className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-none">
              <legend className="text-[10px] font-black uppercase tracking-widest text-subtle">
                Export format
              </legend>
              <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border-strong bg-surface">
                {(["csv", "pdf"] as const).map((format) => (
                  <button
                    key={format}
                    type="button"
                    onClick={() => void handleExport(format)}
                    disabled={exporting !== null}
                    aria-label={`Export ${format.toUpperCase()} report`}
                    className={`min-w-0 px-3 py-2 text-xs font-black transition disabled:cursor-not-allowed disabled:opacity-60 ${
                      format === "pdf"
                        ? "text-brand hover:bg-indigo-500/20"
                        : "text-muted hover:bg-surface-strong"
                    } ${exporting === format ? "bg-indigo-500/10" : ""}`}
                  >
                    {exporting === format ? "Exporting..." : format.toUpperCase()}
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
          {exportMessage ? (
            <p className="text-[11px] font-bold text-muted">{exportMessage}</p>
          ) : null}
        </div>
      </div>

      <div className="p-6 sm:p-10 space-y-10">
        {/* ── Summary stats ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {loading || !summary ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="animate-pulse h-24 rounded-2xl bg-surface"
              />
            ))
          ) : (
            <>
              <StatCard
                label="Total Volume"
                value={fmt(summary.totalVolume)}
                change={summary.changeVolumePercent}
              />
              <StatCard
                label="Transactions"
                value={summary.totalTx.toLocaleString()}
              />
              <StatCard
                label="Avg Tx Size"
                value={fmt(summary.avgTxSize)}
              />
              <StatCard
                label="Top Asset"
                value={
                  assetDist.length > 0
                    ? `${assetDist.sort((a, b) => b.value - a.value)[0].name}`
                    : "—"
                }
              />
            </>
          )}
        </div>

        {/* ── Area Chart: Payment Volume ── */}
        <div>
          <h3 className="text-sm font-black uppercase tracking-widest text-subtle mb-5">
            Payment Volume
          </h3>
          <div className="h-64">
            {loading ? (
              <ChartSkeleton />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={volume}
                  margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="gUsdc" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gXlm" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--chart-grid)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "var(--chart-axis)", fontSize: 10, fontWeight: 700 }}
                    axisLine={false}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fill: "var(--chart-axis)", fontSize: 10, fontWeight: 700 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) => `$${v}`}
                  />
                  <Tooltip
                    {...tooltipStyle}
                    formatter={(v?: ValueType, name?: NameType) => [
                      `$${Number(v ?? 0).toLocaleString()}`,
                      name === "volumeUSDC" ? "USDC" : "XLM",
                    ]}
                  />
                  <Legend
                    wrapperStyle={{
                      fontSize: 11,
                      fontWeight: 800,
                      paddingTop: 12,
                    }}
                    formatter={(value) =>
                      value === "volumeUSDC" ? "USDC Volume" : "XLM Volume"
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="volumeUSDC"
                    stroke="#6366f1"
                    strokeWidth={2}
                    fill="url(#gUsdc)"
                    dot={false}
                    activeDot={{ r: 5, fill: "#6366f1" }}
                  />
                  <Area
                    type="monotone"
                    dataKey="volumeXLM"
                    stroke="#8b5cf6"
                    strokeWidth={2}
                    fill="url(#gXlm)"
                    dot={false}
                    activeDot={{ r: 5, fill: "#8b5cf6" }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* ── Bottom row: Tx Count line + Asset Donut ── */}
        <div className="grid md:grid-cols-2 gap-10">
          {/* Line Chart: Transaction Count */}
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-subtle mb-5">
              Transaction Count
            </h3>
            <div className="h-56">
              {loading ? (
                <ChartSkeleton />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={txCount}
                    margin={{ top: 4, right: 4, left: -20, bottom: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="var(--chart-grid)"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="date"
                      tick={{ fill: "var(--chart-axis)", fontSize: 10, fontWeight: 700 }}
                      axisLine={false}
                      tickLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tick={{ fill: "var(--chart-axis)", fontSize: 10, fontWeight: 700 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      {...tooltipStyle}
                      formatter={(v?: ValueType) => [Number(v ?? 0), "Transactions"]}
                    />
                    <Line
                      type="monotone"
                      dataKey="count"
                      stroke="#6366f1"
                      strokeWidth={2.5}
                      dot={false}
                      activeDot={{
                        r: 6,
                        fill: "#6366f1",
                        stroke: "rgba(99,102,241,0.3)",
                        strokeWidth: 6,
                      }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Donut Chart: Asset Distribution */}
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-subtle mb-5">
              Asset Distribution
            </h3>
            <div className="h-56 flex items-center justify-center">
              {loading ? (
                <ChartSkeleton />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={assetDist}
                      cx="50%"
                      cy="50%"
                      innerRadius="52%"
                      outerRadius="75%"
                      dataKey="value"
                      paddingAngle={3}
                      labelLine={false}
                    >
                      {assetDist.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      {...tooltipStyle}
                      formatter={(v?: ValueType, name?: NameType) => [
                        `${Number(v ?? 0)}%`,
                        name ?? "",
                      ]}
                    />
                    <Legend
                      wrapperStyle={{
                        fontSize: 11,
                        fontWeight: 800,
                      }}
                      formatter={(value) => {
                        const found = assetDist.find((d) => d.name === value);
                        return `${value} ${found ? `(${found.value}%)` : ""}`;
                      }}
                    />
                    {/* Centered label rendered manually below via absolute positioning */}
                    <DonutLabel
                      cx={0}
                      cy={0}
                      total={assetDist.reduce((s, d) => s + d.value, 0)}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
