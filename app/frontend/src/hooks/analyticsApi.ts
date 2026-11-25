import i18n from "i18next";
import { getQuickexApiBase } from "@/lib/api";
import { resolvePublicKey } from "@/lib/publicKey";

export type DateRange = "24h" | "7d" | "30d" | "all";

export interface VolumeDataPoint {
  date: string;
  volumeUSDC: number;
  volumeXLM: number;
  total: number;
}

export interface TxCountDataPoint {
  date: string;
  count: number;
}

export interface AssetSlice {
  name: string;
  value: number;
  color: string;
}

export interface AnalyticsData {
  volume: VolumeDataPoint[];
  txCount: TxCountDataPoint[];
  assetDist: AssetSlice[];
  summary: {
    totalVolume: number;
    totalTx: number;
    avgTxSize: number;
    changeVolumePercent: number;
    successfulTx: number;
    failedTx: number;
    conversionRate: number;
    refundCount: number;
    refundVolume: number;
  };
}

type ApiTimeSeriesItem = {
  period: string;
  transactionCount: number;
  successfulTransactions: number;
  volumeUsd: number;
  assetVolumes?: Record<string, number>;
};

type ApiReport = {
  summary: {
    totalTransactions: number;
    successfulTransactions: number;
    failedTransactions: number;
    conversionRate: number;
    totalVolumeUsd: number;
    averageTransactionUsd: number;
  };
  assetDistribution: Array<{
    asset: string;
    volumeUsd: number;
    percentage: number;
    transactionCount: number;
  }>;
  timeSeries: ApiTimeSeriesItem[];
};

// Keyed by `${publicKey}:${range}` — switching accounts must not serve a
// previous account's cached report for the same range.
const analyticsCache: Record<string, AnalyticsData> = {};

function analyticsCacheKey(publicKey: string, range: DateRange): string {
  return `${publicKey}:${range}`;
}

export function clearAnalyticsCache(): void {
  for (const key of Object.keys(analyticsCache)) {
    delete analyticsCache[key];
  }
}

const ASSET_COLORS: Record<string, string> = {
  USDC: "#6366f1",
  XLM: "#8b5cf6",
};

/**
 * Freshness metadata (retrieval time, cached/failed) for the last
 * `fetchAnalytics` call for a given range. Lets callers show "as of HH:MM"
 * and distinguish a cached/fallback value from a just-fetched live one.
 */
export function getAnalyticsFreshness(range: DateRange): AnalyticsFreshness | undefined {
  return lastFreshness[range];
}

/**
 * Drop cached analytics data so the next `fetchAnalytics` call hits the
 * network again. Call this when something changed upstream (a realtime
 * update event, a new payment) instead of relying on the in-memory cache
 * forever, which would otherwise keep serving the same snapshot.
 */
export function invalidateAnalyticsCache(range?: DateRange): void {
  if (range) {
    delete analyticsCache[range];
  } else {
    for (const key of Object.keys(analyticsCache) as DateRange[]) {
      delete analyticsCache[key];
    }
  }
}

function rangeToWindow(range: DateRange): {
  startDate: string;
  endDate: string;
  interval: "daily" | "weekly" | "monthly";
} {
  const end = new Date();
  const start = new Date(end);
  let interval: "daily" | "weekly" | "monthly" = "daily";

  if (range === "24h") {
    start.setHours(start.getHours() - 24);
    interval = "daily";
  } else if (range === "7d") {
    start.setDate(start.getDate() - 7);
    interval = "daily";
  } else if (range === "30d") {
    start.setDate(start.getDate() - 30);
    interval = "daily";
  } else {
    start.setFullYear(start.getFullYear() - 1);
    interval = "monthly";
  }

  return {
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    interval,
  };
}

function labelForPeriod(period: string): string {
  const locale = i18n.language || "en";

  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    const d = new Date(`${period}T00:00:00.000Z`);
    return d.toLocaleDateString(locale, { month: "numeric", day: "numeric" });
  }

  if (/^\d{4}-\d{2}$/.test(period)) {
    const [year, month] = period.split("-");
    const d = new Date(`${year}-${month}-01T00:00:00.000Z`);
    return d.toLocaleDateString(locale, { month: "short" });
  }

  if (/^\d{4}-W\d{2}$/.test(period)) {
    const [, week] = period.split("-W");
    return `W${week}`;
  }

  return period;
}

function toUiModel(report: ApiReport): AnalyticsData {
  const volume = report.timeSeries.map((item) => {
    const volumeUSDC = item.assetVolumes?.USDC ?? 0;
    const volumeXLM = item.assetVolumes?.XLM ?? 0;
    return {
      date: labelForPeriod(item.period),
      volumeUSDC,
      volumeXLM,
      total: item.volumeUsd,
    };
  });

  const txCount: TxCountDataPoint[] = report.timeSeries.map((item) => ({
    date: labelForPeriod(item.period),
    count: item.transactionCount,
  }));

  const assetDist: AssetSlice[] = report.assetDistribution
    .slice()
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .map((item, index) => ({
      name: item.asset,
      value: Number(item.percentage.toFixed(2)),
      color: ASSET_COLORS[item.asset] ?? (index % 2 === 0 ? "#334155" : "#64748b"),
    }));

  return {
    volume,
    txCount,
    assetDist,
    summary: {
      totalVolume: report.summary.totalVolumeUsd,
      totalTx: report.summary.totalTransactions,
      avgTxSize: report.summary.averageTransactionUsd,
      changeVolumePercent: 0,
      successfulTx: report.summary.successfulTransactions,
      failedTx: report.summary.failedTransactions,
      conversionRate: report.summary.conversionRate ?? (report.summary.totalTransactions > 0 ? (report.summary.successfulTransactions / report.summary.totalTransactions) * 100 : 100),
      refundCount: report.summary.failedTransactions,
      refundVolume: 0,
    },
  };
}

function fallbackEmpty(): AnalyticsData {
  return {
    volume: [],
    txCount: [],
    assetDist: [],
    summary: {
      totalVolume: 0,
      totalTx: 0,
      avgTxSize: 0,
      changeVolumePercent: 0,
      successfulTx: 0,
      failedTx: 0,
      conversionRate: 100,
      refundCount: 0,
      refundVolume: 0,
    },
  };
}

export async function fetchAnalytics(
  range: DateRange,
  publicKey: string = resolvePublicKey(),
): Promise<AnalyticsData> {
  const cacheKey = analyticsCacheKey(publicKey, range);
  if (analyticsCache[cacheKey]) {
    return Promise.resolve(analyticsCache[cacheKey]);
  }

  const { startDate, endDate, interval } = rangeToWindow(range);
  const url = new URL(`${getQuickexApiBase()}/analytics/report`);
  url.searchParams.set("publicKey", publicKey);
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("interval", interval);

  try {
    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) {
      throw new Error(`Analytics request failed with status ${res.status}`);
    }
    const report = (await res.json()) as ApiReport;
    const parsed = toUiModel(report);
    analyticsCache[cacheKey] = parsed;
    return parsed;
  } catch (error) {
    console.warn("Falling back to empty analytics data:", error);
    const empty = fallbackEmpty();
    analyticsCache[cacheKey] = empty;
    return empty;
  }
}

export async function exportAnalyticsReport(
  range: DateRange,
  format: "csv" | "pdf",
  reportType: "tax" | "accounting" = "accounting",
): Promise<void> {
  const publicKey = resolvePublicKey();
  const { startDate, endDate, interval } = rangeToWindow(range);
  const url = new URL(`${getQuickexApiBase()}/analytics/export`);
  url.searchParams.set("publicKey", publicKey);
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  url.searchParams.set("interval", interval);
  url.searchParams.set("format", format);
  url.searchParams.set("reportType", reportType);

  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) {
    throw new Error(`Export request failed with status ${res.status}`);
  }

  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition");
  const fallbackName = `quickex-analytics-report.${format}`;
  const fileName = parseFilename(disposition) ?? fallbackName;
  const objectUrl = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(objectUrl);
}

function parseFilename(disposition: string | null): string | null {
  if (!disposition) return null;
  const match = /filename="?([^"]+)"?/i.exec(disposition);
  return match?.[1] ?? null;
}
