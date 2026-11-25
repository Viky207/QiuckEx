# Metrics Reference

This document describes the metrics exposed by the backend and how they are
collected. It also documents the notification delivery and retry semantics that
integrators rely on when consuming notification-related metrics.

## Notification delivery and retry semantics

### Event creation

Notifications are created when a domain event is emitted (for example, a
payment status change or an account update). Each event is persisted before any
delivery attempt is made, so a notification record exists even if delivery is
delayed or fails. Event creation is the single source of truth for what should
be delivered; delivery workers only read from persisted events.

### Preferences

Per-user channel preferences are evaluated at delivery time, not at event
creation time. If a user disables a channel, pending deliveries for that channel
are skipped. Preference changes therefore affect notifications that have not yet
been delivered.

### Delivery guarantees per channel

Delivery is **at-least-once** per channel. There is no exactly-once guarantee:
retries and worker restarts can cause a notification to be delivered more than
once. Consumers that require exactly-once behavior must deduplicate using the
notification identifier carried with each delivery. The only idempotency
boundary is the persisted notification record keyed by its identifier; delivery
itself is not transactional with the downstream channel.

### Retries and backoff

Failed delivery attempts are retried with exponential backoff up to a bounded
number of attempts. After the maximum attempts are exhausted the notification is
marked as failed and no further automatic retries occur. Retry counters and
failure states are reflected in the notification metrics.

### Deduplication

Deduplication is applied at the event level: an event with the same identifier
is not re-created, so duplicate event emissions do not produce duplicate
notification records. This is the idempotency boundary. Deduplication does not
extend to delivery, which remains at-least-once as described above.

### Delayed delivery status

Delivery status can lag behind actual delivery because status updates are
written asynchronously by delivery workers. Metrics that report delivery status
may therefore be delayed relative to the underlying channel. Treat status
metrics as eventually consistent and rely on the notification identifier for
reconciliation.

## Metric collection

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

## Reconciliation metrics

Reconciliation runs process a bounded ledger range per job and persist a
resumable cursor with the run metadata. The following metrics expose progress so
operators can observe a run advancing (or stalling) across bounded batches.

### `app_reconciliation_ledgers_processed_total`

- **Type:** counter
- **Labels:** `run_id`
- **Description:** Total ledgers processed by reconciliation, partitioned by run.
  Increments once per ledger as each bounded batch is committed, so the sum
  across a run reflects durable progress (no double-counting on resume).
- **Example query** — ledgers processed per run over 5m:

  ```promql
  sum by (run_id) (rate(app_reconciliation_ledgers_processed_total[5m]))
  ```

### `app_reconciliation_cursor_ledger`

- **Type:** gauge
- **Labels:** `run_id`
- **Description:** The last ledger sequence durably committed to the run's
  resumable cursor. On restart the run resumes from this cursor, so a stalled
  gauge indicates a run that is not making progress.
- **Example query** — cursor position per run:

  ```promql
  app_reconciliation_cursor_ledger
  ```

### `app_reconciliation_batch_duration_seconds`

- **Type:** histogram
- **Labels:** `run_id`
- **Description:** Wall-clock duration in seconds of each bounded reconciliation
  batch. Use this to tune the configured batch size within its safe bounds.
- **Example query** — p95 batch duration per run over 10m:

  ```promql
  histogram_quantile(
    0.95,
    sum by (le, run_id) (rate(app_reconciliation_batch_duration_seconds_bucket[10m]))
  )
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

**Supabase dependency down** — critical persistence dependency unavailable:

```promql
app_dependency_up{dependency="supabase"} == 0
```

- `for: 2m`
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

**Stalled reconciliation run** — a run whose cursor has not advanced for 15
minutes while it is still active:

```promql
increase(app_reconciliation_ledgers_processed_total[15m]) == 0
```

- `for: 15m`
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
