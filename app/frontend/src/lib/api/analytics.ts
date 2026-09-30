import { apiClient } from './client';

export interface AnalyticsReport {
  revenue: number;
  orders: number;
  customers: number;
  conversionRate: number;
}

export interface TimeSeriesPoint {
  date: string;
  revenue: number;
  orders: number;
}

export interface TimeSeriesResponse {
  points: TimeSeriesPoint[];
  total: number;
}

export interface AssetBreakdownItem {
  asset: string;
  value: number;
  percentage: number;
}

export interface AssetsResponse {
  items: AssetBreakdownItem[];
  total: number;
}

export interface DateRangeParams {
  from: string;
  to: string;
}

export async function getAnalyticsReport(): Promise<AnalyticsReport> {
  const { data } = await apiClient.get<AnalyticsReport>('/analytics/report');
  return data;
}

export async function getTimeSeries(
  params: DateRangeParams,
): Promise<TimeSeriesResponse> {
  const { data } = await apiClient.get<TimeSeriesResponse>(
    '/analytics/time-series',
    { params },
  );
  return data;
}

export async function getAssets(
  params: DateRangeParams,
): Promise<AssetsResponse> {
  const { data } = await apiClient.get<AssetsResponse>('/analytics/assets', {
    params,
  });
  return data;
}
