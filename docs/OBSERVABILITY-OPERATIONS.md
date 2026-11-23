# Observability & Operations

This document describes how to observe and operate the backend in production.

## Metrics

The NestJS backend exposes Prometheus metrics via `prom-client` on the `/metrics` endpoint (default port `4000`).

```bash
curl localhost:4000/metrics
```

### Metric Reference

| Metric | Type | Labels | Description |
| --- | --- | --- | --- |
| `http_requests_total` | counter | `method`, `route`, `status_code` | Total number of HTTP requests handled by the backend. |
| `http_request_duration_seconds` | histogram | `method`, `route`, `status_code` | HTTP request latency in seconds. |
| `http_requests_in_flight` | gauge | `method`, `route` | Number of HTTP requests currently being processed. |
| `process_cpu_seconds_total` | counter | — | Total user and system CPU time spent in seconds. |
| `process_resident_memory_bytes` | gauge | — | Resident memory size in bytes. |
| `nodejs_eventloop_lag_seconds` | gauge | — | Event loop lag in seconds. |
| `nodejs_heap_size_used_bytes` | gauge | — | Node.js heap memory used in bytes. |
| `nodejs_heap_size_total_bytes` | gauge | — | Node.js heap memory allocated in bytes. |
| `nodejs_active_handles_total` | gauge | — | Number of active handles in the Node.js event loop. |
| `nodejs_active_requests_total` | gauge | — | Number of active requests in the Node.js event loop. |

### Example Queries

Request rate by route:

```promql
sum by (route) (rate(http_requests_total[5m]))
```

Error rate (5xx responses):

```promql
sum(rate(http_requests_total{status_code=~"5.."}[5m]))
  /
sum(rate(http_requests_total[5m]))
```

p99 request latency:

```promql
histogram_quantile(
  0.99,
  sum by (le, route) (rate(http_request_duration_seconds_bucket[5m]))
)
```

In-flight requests:

```promql
sum by (route) (http_requests_in_flight)
```

Event loop lag:

```promql
nodejs_eventloop_lag_seconds
```

Heap usage ratio:

```promql
nodejs_heap_size_used_bytes / nodejs_heap_size_total_bytes
```

## Alert Thresholds

Recommended PromQL alert rules for P0/P1 scenarios.

### P0 — Error rate > 1% for 5 minutes

```promql
(
  sum(rate(http_requests_total{status_code=~"5.."}[5m]))
    /
  sum(rate(http_requests_total[5m]))
) > 0.01
```

### P0 — p99 latency > 2s for 5 minutes

```promql
histogram_quantile(
  0.99,
  sum by (le) (rate(http_request_duration_seconds_bucket[5m]))
) > 2
```

### P1 — Event loop lag > 0.5s for 5 minutes

```promql
nodejs_eventloop_lag_seconds > 0.5
```

### P1 — Heap usage > 90% for 10 minutes

```promql
(nodejs_heap_size_used_bytes / nodejs_heap_size_total_bytes) > 0.9
```

### P1 — In-flight requests sustained above 100

```promql
sum(http_requests_in_flight) > 100
```

## Link metadata replay cache

`POST /links/metadata` accepts an optional `Idempotency-Key`. Concurrent requests with the same key and payload are coalesced onto one in-flight generation, and a small process-local replay cache (five-minute TTL, maximum 500 entries) returns the original response to a retry after a client timeout.

- The cache is in memory only. Restarting a backend instance clears it; this is safe because metadata generation is stateless and persists no link or ledger state.
- Instances do not share replay state. A retry routed to a different instance may regenerate the same metadata; the response remains identical for the same payload.
- A malformed key returns `400 INVALID_IDEMPOTENCY_KEY`; a key reused with a different payload returns `409 IDEMPOTENCY_CONFLICT`. Neither case mutates cache state.
- Cached entries hold only public link parameters and generated metadata. No secret keys, signatures, or unnecessary personal data are stored or logged.
- No extra metric is required: observe `http_requests_total{route="/links/metadata"}` and `http_request_duration_seconds` for traffic and latency changes.

## Grafana Dashboard

The exported Grafana dashboard JSON is committed at `docs/grafana-dashboard.json` and can be imported directly into Grafana.

## Related Documentation

- [Backend README](../app/backend/README.md)
