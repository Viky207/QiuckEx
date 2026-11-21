# Metrics Reference

This page enumerates every Prometheus metric exported by the NestJS backend via
[`prom-client`](https://github.com/siimon/prom-client). Metrics are exposed on the
`/metrics` endpoint (default `http://localhost:4000/metrics`) and scraped by
Prometheus. Use this page as the on-call quick reference for what each metric
means and what to alert on.

> Verify the live set of metrics at any time with:
>
> ```bash
> curl -s localhost:4000/metrics
> ```

## Conventions

- All custom metrics are prefixed with `app_`.
- Default Node.js process metrics are also exported (prefixed `process_` and
  `nodejs_`); they are listed at the end for completeness.
- Histograms expose `_bucket`, `_sum`, and `_count` series.

## HTTP metrics

### `app_http_requests_total`

- **Type:** counter
- **Labels:** `method`, `route`, `status_code`
- **Description:** Total number of HTTP requests handled, partitioned by HTTP
  method, matched route, and response status code.
- **Example query** — request rate by status class over 5m:

  ```promql
  sum by (status_code) (rate(app_http_requests_total[5m]))
  ```

### `app_http_request_duration_seconds`

- **Type:** histogram
- **Labels:** `method`, `route`, `status_code`
- **Description:** HTTP request latency in seconds. Default buckets cover
  5ms–10s.
- **Example query** — p99 latency per route over 5m:

  ```promql
  histogram_quantile(
    0.99,
    sum by (le, route) (rate(app_http_request_duration_seconds_bucket[5m]))
  )
  ```

### `app_http_requests_in_flight`

- **Type:** gauge
- **Labels:** `method`
- **Description:** Number of HTTP requests currently being processed.
- **Example query** — concurrent requests:

  ```promql
  sum(app_http_requests_in_flight)
  ```

## Business metrics

### `app_escrow_operations_total`

- **Type:** counter
- **Labels:** `operation` (`create`, `release`, `refund`), `status` (`success`, `failure`)
- **Description:** Total escrow operations processed by the backend.
- **Example query** — escrow failure rate over 5m:

  ```promql
  sum(rate(app_escrow_operations_total{status="failure"}[5m]))
    /
  sum(rate(app_escrow_operations_total[5m]))
  ```

### `app_active_escrows`

- **Type:** gauge
- **Labels:** none
- **Description:** Number of escrows currently active (created but not yet
  released or refunded).
- **Example query** — active escrow count:

  ```promql
  app_active_escrows
  ```

### `app_db_query_duration_seconds`

- **Type:** histogram
- **Labels:** `operation` (`select`, `insert`, `update`, `delete`), `table`
- **Description:** Database query latency in seconds.
- **Example query** — p95 DB latency per table over 5m:

  ```promql
  histogram_quantile(
    0.95,
    sum by (le, table) (rate(app_db_query_duration_seconds_bucket[5m]))
  )
  ```

## Data freshness

Analytics and account-activity views may serve cached values when an upstream
dependency is unavailable. Cached responses are surfaced to clients with a
freshness signal so that stale values are never mistaken for live data.

### `app_cache_served_total`

- **Type:** counter
- **Labels:** `surface` (`analytics`, `account_activity`), `reason` (`fresh`, `stale`)
- **Description:** Number of read responses served from cache, partitioned by
  the user-facing surface and whether the cached value was still considered
  fresh or was served stale (e.g. during a dependency outage).
- **Example query** — share of stale responses per surface over 5m:

  ```promql
  sum by (surface) (rate(app_cache_served_total{reason="stale"}[5m]))
    /
  sum by (surface) (rate(app_cache_served_total[5m]))
  ```

### `app_cache_stale_age_seconds`

- **Type:** gauge
- **Labels:** `surface` (`analytics`, `account_activity`)
- **Description:** Age in seconds of the most recently served stale cached
  value. This is the same timestamp surfaced to clients in the stale-data
  label, so on-call can correlate the UI indicator with backend state.
- **Example query** — current stale age per surface:

  ```promql
  app_cache_stale_age_seconds
  ```

## Runtime metrics (default collectors)

These are emitted by `prom-client`'s default collectors and are useful for
capacity and saturation alerts.

| Metric | Type | Description |
| --- | --- | --- |
| `process_cpu_seconds_total` | counter | Total user + system CPU time in seconds. |
| `process_resident_memory_bytes` | gauge | Resident memory size in bytes. |
| `nodejs_heap_size_used_bytes` | gauge | V8 heap used in bytes. |
| `nodejs_heap_size_total_bytes` | gauge | V8 heap total in bytes. |
| `nodejs_eventloop_lag_seconds` | gauge | Event loop lag in seconds. |
| `nodejs_active_handles_total` | gauge | Number of active libuv handles. |

## Alert thresholds

Recommended PromQL alert rules. `for:` durations are chosen to avoid paging on
transient spikes.

### P0 — page immediately

**High error rate** — more than 1% of requests failing for 5 minutes:

```promql
sum(rate(app_http_requests_total{status_code=~"5.."}[5m]))
  /
sum(rate(app_http_requests_total[5m])) > 0.01
```

- `for: 5m`
- Severity: `critical`

**p99 latency** — p99 request latency above 2s for 5 minutes:

```promql
histogram_quantile(
  0.99,
  sum by (le) (rate(app_http_request_duration_seconds_bucket[5m]))
) > 2
```

- `for: 5m`
- Severity: `critical`

**Escrow operation failures** — any sustained escrow failure rate:

```promql
sum(rate(app_escrow_operations_total{status="failure"}[5m])) > 0.1
```

- `for: 5m`
- Severity: `critical`

### P1 — notify, investigate during business hours

**Elevated error rate** — more than 0.5% of requests failing for 10 minutes:

```promql
sum(rate(app_http_requests_total{status_code=~"5.."}[10m]))
  /
sum(rate(app_http_requests_total[10m])) > 0.005
```

- `for: 10m`
- Severity: `warning`

**p95 latency** — p95 request latency above 1s for 10 minutes:

```promql
histogram_quantile(
  0.95,
  sum by (le) (rate(app_http_request_duration_seconds_bucket[10m]))
) > 1
```

- `for: 10m`
- Severity: `warning`

**Slow database queries** — p95 DB latency above 500ms for 10 minutes:

```promql
histogram_quantile(
  0.95,
  sum by (le, table) (rate(app_db_query_duration_seconds_bucket[10m]))
) > 0.5
```

- `for: 10m`
- Severity: `warning`

**Stale data served** — any surface serving stale cached data for 5 minutes,
indicating a sustained dependency outage:

```promql
sum by (surface) (rate(app_cache_served_total{reason="stale"}[5m])) > 0
```

- `for: 5m`
- Severity: `warning`

**Event loop lag** — event loop lag above 100ms for 10 minutes:

```promql
nodejs_eventloop_lag_seconds > 0.1
```

- `for: 10m`
- Severity: `warning`

**Memory pressure** — resident memory above 1GiB for 15 minutes:

```promql
process_resident_memory_bytes > 1073741824
```

- `for: 15m`
- Severity: `warning`

## Grafana dashboard

The companion dashboard is committed at
[`grafana-dashboard.json`](./grafana-dashboard.json). Import it via
**Dashboards → Import → Upload JSON file** in Grafana. It includes panels for
request rate, error rate, latency percentiles, escrow operations, DB latency,
and runtime saturation.

## Related documentation

- [Observability & Operations](./OBSERVABILITY-OPERATIONS.md)
- [Backend README](../README.md)
