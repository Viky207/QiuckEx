# Observability & Operations: SLOs, Alerts, Tracing, and Operator Replay

Operational contract for the QuickEx backend, covering the payment, link,
indexing, and notification paths. This document is the authority for the
service level objectives (SLOs) and error budgets, the alert rules and
dashboards built on them, request tracing and dependency readiness probes, and
the safe operator replay tooling.

Owning module: `app/backend/src/observability/`.

---

## Assumptions

Recorded explicitly, as required before a capability of this kind is
promoted.

| Assumption | Statement | Why it matters |
|---|---|---|
| **Network** | The SLOs, alerts, probes, and read-only surfaces are network-agnostic and run on both testnet and mainnet. Only the operator **replay write** is gated (see [Feature gating](#feature-gating)). | Testnet-first per [ADR 0002](./adr/0002-testnet-first-mainnet-feature-gated.md); read paths are safe everywhere. |
| **Custody** | Nothing in this capability reads, derives, or transmits a private key or a seed phrase. Replay re-sends a *notification about* an already-recorded event. | [ADR 0001](./adr/0001-self-custody-and-no-server-side-key-custody.md) — self-custody is unaffected. |
| **Financial invariants** | Replay never moves funds, never re-executes a contract call, and never writes the escrow state machine. `INV-01`..`INV-10` in [INVARIANTS.md](./INVARIANTS.md) cannot be affected by any operation described here. | The only write is to `notification_log`, and to an audit row. |
| **Backward compatibility** | No existing route changes shape or status code. All new routes live under `admin/observability`, which did not exist before. | Existing clients are unaffected. |
| **Observability window** | SLIs are derived from the in-process Prometheus registry, so the observation window is bounded by process uptime. A restart resets the counters. | Documented on every report as `observationSeconds`; a fresh process reports `insufficient_data` rather than a confident number. |
| **Multi-instance deployments** | The replay limiter is in-process (as it already was for webhook replay). A multi-instance deployment needs the Redis-backed limiter before replay is enabled at scale. | Called out in [Operational procedure](#operational-procedure). |

---

## What changed

| Area | Change | Contract |
|---|---|---|
| SLOs & error budgets | `slo/slo.definitions.ts`, `slo/slo.service.ts` — five objectives with targets, windows, burn rates | `GET /admin/observability/slo`, `GET /admin/observability/slo/:id` |
| Alerts | `alerting/alert-rules.ts`, `alerting/alerting.service.ts` — six rules with `for` semantics and runbooks | `GET /admin/observability/alerts`, `GET /admin/observability/alerts/rules` |
| Dependency probes | `readiness/dependency-readiness.service.ts` — six probes with criticality | `GET /admin/observability/dependencies` |
| Tracing | `tracing/trace-context.ts`, `tracing/tracing.middleware.ts` — W3C trace context | Inbound/outbound `traceparent`, response `x-trace-id` |
| Operator replay | `replay/operator-replay.service.ts` — admin-scoped replay with duplicate suppression | `GET`/`POST /admin/observability/replay/:publicKey/:channel/:eventType/:eventId` |
| Metrics | `src/metrics/metrics.service.ts` — nine new series | `/metrics` |
| Notifications | `NotificationService.redeliverToChannel`, `NotificationLogRepository.getDelivery` / `resetNotificationForManualReplay` | No public contract change |
| Feature flag | `mainnet.operator_replay`, default **disabled** | `NetworkSafetyGuard` |

### Database / migration

**No migration is required.** The capability reuses the existing
`notification_log` and `webhook_replay_log` tables from
`20260625000000_webhook_replay_tooling.sql`. The two new repository methods
(`getDelivery`, `resetNotificationForManualReplay`) only read and update columns
that already exist.

### Configuration

**No new environment variable is required.** The replay surface inherits the
existing cooldown and quota configuration already read by
`WebhookReplayLimiter`:

| Variable | Default | Effect |
|---|---|---|
| `WEBHOOK_REPLAY_EVENT_COOLDOWN_MS` | `30000` | Minimum gap between replays of the same event |
| `WEBHOOK_REPLAY_QUOTA_PER_HOUR` | `20` | Maximum replays per webhook per hour |
| `WEBHOOK_REPLAY_QUOTA_WINDOW_MS` | `3600000` | Width of the quota window |
| `INDEXER_LAG_THRESHOLD_LEDGERS` | see `AppConfigService` | Threshold used by the indexing SLO and alert |
| `METRICS_ENDPOINT_TOKEN` | — | Required to scrape `/metrics` (unchanged) |

---

## Service level objectives and error budgets

An objective is a compliance target over a rolling window. The error budget is
`1 - target`; the **burn rate** is the observed bad-event ratio divided by the
allowed bad-event ratio. A burn rate of `B` consumes the whole 30-day budget in
`30d / B`.

| ID | Path | Kind | Target | Window | Enforced |
|---|---|---|---|---|---|
| `payment_availability` | payment | availability | 99.5% | 7d | yes |
| `link_availability` | link | availability | 99.5% | 7d | yes |
| `indexing_freshness` | indexing | freshness | 99% | 1d | yes |
| `notification_delivery` | notification | availability | 99% | 7d | yes |
| `settlement_latency` | payment | latency | 99% | 7d | no (advisory) |

**Burn-rate thresholds.** `warning` at 6x (exhausts a 30-day budget in ~5 days),
`critical` at 14.4x (~2 days). Classification is burn-rate based, not a raw
target comparison, so a single noisy sample does not page anyone.

**Advisory objectives** (`enforced: false`) are excluded from `overallStatus`.
Settlement latency is advisory while the transition-duration histogram settles.

### How each SLI is measured

Each objective is derived from series the `/metrics` endpoint already exports —
there is no second, parallel source of truth.

| Objective | Numerator | Denominator | Source |
|---|---|---|---|
| `payment_availability` | responses on `/payments*` and `/transactions*` that are not 5xx | all responses on those routes | `http_requests_total{route,status_code}` |
| `link_availability` | same, for `/links*` and `/payment-links*` | same | `http_requests_total{route,status_code}` |
| `indexing_freshness` | `1` when the lag guard is not reporting lag | `1` sample | `indexer_lag_ledgers`, `indexer_lag_guard_status` |
| `notification_delivery` | deliveries with `status="success"` (replays excluded) | all delivery attempts (replays excluded) | `webhook_delivery_duration_seconds{status}` |
| `settlement_latency` | transitions completing within 60s | all transitions | `escrow_state_transition_duration_seconds` |

Two deliberate choices:

- **4xx counts as good.** A malformed request is the caller's problem and must
  not burn the availability budget.
- **No traffic is not healthy.** When the denominator is zero the ratio is
  `null` and the status is `insufficient_data`. `GET /admin/observability/slo`
  never reports 100% for an objective that has never been exercised.

Each evaluation also returns an `evidence` block (`total`, `good`, `bad`,
`source`) so an operator can audit the arithmetic without re-deriving it.

---

## Alerts and dashboards

| Rule ID | Severity | Fires when | `for` |
|---|---|---|---|
| `indexer_lag_over_threshold` | critical | `indexer_lag_ledgers` > configured threshold | 2 evaluations |
| `indexer_lag_guard_blocking_traffic` | warning | `indexer_lag_guard_status == 3` | 2 evaluations |
| `settlement_latency_over_budget` | critical | any transition exceeded 60s | 3 evaluations |
| `reconciliation_discrepancies` | critical | any `error_total{service="reconciliation"}` | 1 evaluation |
| `error_budget_burn_rate_critical` | critical | an enforced SLO is `critical` | 2 evaluations |
| `webhook_dead_letter_queue_backlog` | warning | `webhook_dlq_size` > 0 | 2 evaluations |

`forSamples` implements the Prometheus `for` clause: the condition must hold for
N consecutive evaluations before the alert fires. States are `ok`, `pending`,
`firing`, and `no_data`; a `no_data` alert never fires, so losing the metrics
registry cannot manufacture an incident.

### Dashboard layout

The panels below map one-to-one onto the series above and are the intended
Grafana layout. All expressions use the `quickex_` prefixed series published by
`ObservabilityScheduler`.

| Panel | Query |
|---|---|
| SLO compliance (per objective) | `quickex_slo_compliance_ratio` |
| Error budget remaining | `quickex_slo_error_budget_remaining_ratio` |
| Error budget burn rate | `quickex_slo_error_budget_burn_rate` |
| SLO status | `quickex_slo_status` (`0=ok 1=insufficient_data 2=warning 3=critical`) |
| Firing alerts | `quickex_alerts_firing` |
| Settlement latency p95 | `histogram_quantile(0.95, rate(escrow_state_transition_duration_seconds_bucket[5m]))` |
| Indexer lag | `indexer_lag_ledgers` |
| Reconciliation discrepancies | `rate(error_total{service="reconciliation"}[5m])` |
| Webhook DLQ depth | `webhook_dlq_size` |
| Dependency probe health | `quickex_dependency_probe_up` |
| Operator replay outcomes | `quickex_operator_replay_total` |

Suggested Alertmanager rules:

```promql
# Fast burn: page.
quickex_slo_status == 3 and on (slo) quickex_slo_error_budget_remaining_ratio < 0
# Any firing critical alert.
quickex_alerts_firing{severity="critical"} == 1
# A critical dependency is not ready.
min by (dependency) (quickex_dependency_probe_up{criticality="critical"}) == 0
```

### Metrics reference

| Metric | Type | Labels |
|---|---|---|
| `quickex_slo_compliance_ratio` | gauge | `slo`, `path`, `kind` |
| `quickex_slo_error_budget_remaining_ratio` | gauge | `slo`, `path` |
| `quickex_slo_error_budget_burn_rate` | gauge | `slo`, `path` |
| `quickex_slo_status` | gauge | `slo`, `path`, `enforced` |
| `quickex_alerts_firing` | gauge | `alert`, `severity` |
| `quickex_dependency_probe_duration_seconds` | histogram | `dependency`, `criticality`, `status` |
| `quickex_dependency_probe_up` | gauge | `dependency`, `criticality` |
| `quickex_trace_context_total` | counter | `outcome` |
| `quickex_operator_replay_total` | counter | `target`, `outcome` |

An unobserved ratio is published as `NaN`, not `0`, so Prometheus distinguishes
"no data" from "totally broken". A `NaN` series produces no alert.

**Label cardinality is bounded.** `quickex_trace_context_total` records only
whether baggage was *present* (`baggage_forwarded`), never its contents, so
user-controlled input can never become a Prometheus label.

---

## Distributed tracing

`TracingMiddleware` runs on every request, after the correlation-id middleware
and before any route handler.

- An inbound W3C `traceparent` is continued; anything malformed is **replaced**
  with a freshly minted trace, never trusted. A caller must not be able to
  inject a trace id that pollutes another tenant's traces.
- The response carries `x-trace-id` and the downstream `traceparent`.
- `tracePropagationHeaders()` returns the headers to attach to outbound Horizon,
  Soroban RPC, and Supabase calls, joining their logs to this trace.
- The middleware never awaits, so it adds no latency to the request path.

Counters: `started`, `continued`, `replaced_malformed`, `baggage_forwarded`.

## Dependency readiness probes

| Probe | Criticality | Timeout source |
|---|---|---|
| `supabase` | critical | `HealthService.checkSupabase` (3s) |
| `horizon` | critical | `HealthService.checkHorizon` (5s) |
| `soroban_rpc` | critical | `HealthService.checkSorobanRpc` (5s) |
| `job_queue` | critical | `HealthService.checkQueue` (5s) |
| `redis` | optional | `HealthService.checkRedis` (3s) |
| `indexer` | optional | `IndexerLagService.getStatus` (in-process) |

`ready` reflects **only** critical probes. An unhealthy *optional* dependency
reports overall `degraded`, not `unhealthy`: `unhealthy` means "this instance
should not receive traffic", and pulling every instance out of rotation because
an optional cache is down would turn a degradation into a self-inflicted
outage. This complements `/health` and `/ready`, which answer "is this process
serving?"; this answers "which dependency is the reason it is not?".

Results are cached for 5 seconds so a scrape storm cannot fan out into probes.
A probe that throws is reported `unhealthy` with a fixed detail string — the
raw error is logged, not returned.

---

## Safe operator replay

Replay recovers a **lost** delivery. It does not create one.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/admin/observability/replay/:publicKey/:channel/:eventType/:eventId` | Inspect the delivery. Read-only. |
| `POST` | `/admin/observability/replay/:publicKey/:channel/:eventType/:eventId` | Replay it. |

`?actor=<name>` labels the audit entry; the default is `admin-api-key`. The
public key in the path identifies *whose* notification to replay — never who
may ask.

### Stable error codes

| Code | HTTP | Meaning |
|---|---|---|
| `API_KEY_REQUIRED` | 401 | No `x-api-key` header |
| `INVALID_API_KEY` | 401 | Unknown key |
| `INSUFFICIENT_SCOPE` | 403 | Key lacks the `admin` scope |
| `QUOTA_EXCEEDED` | 403 | Key's monthly quota exhausted |
| `OPERATOR_REPLAY_MALFORMED` | 400 | Blank `eventType` or `eventId` |
| `OPERATOR_REPLAY_CHANNEL_UNSUPPORTED` | 400 | Channel is not replayable |
| `OPERATOR_REPLAY_NOT_FOUND` | 404 | No delivery row for the tuple |
| `OPERATOR_REPLAY_ALREADY_DELIVERED` | 409 | Delivery already `sent` |
| `OPERATOR_REPLAY_COOLDOWN` | 409 | Delivery is `pending`, or the replay limiter refused |
| `WEBHOOK_REPLAY_COOLDOWN` / `WEBHOOK_REPLAY_QUOTA_EXCEEDED` | 429 | Limiter refused the webhook replay |
| `OPERATOR_REPLAY_DEPENDENCY_FAILURE` | 503 | Supabase/provider unavailable — safe to retry |
| `MAINNET_GATE_BLOCKED` | 503 | Blocked by the mainnet replay gate |

### Safety properties

- **Idempotency.** A delivery already `sent` is refused with
  `OPERATOR_REPLAY_ALREADY_DELIVERED`, so an operator cannot cause a duplicate
  notification. A `pending` delivery is refused with a conflict.
- **Blast radius.** Webhook replays delegate to the existing
  `WebhookReplayService`, which owns the per-event cooldown and per-webhook
  quota. Every channel still passes the notification rate limiter. A replay
  storm degrades into rejections, not into an amplified flood.
- **Channel allowlist.** `webhook`, `email`, `push`, `telegram`. `in_app` is
  excluded deliberately: an in-app notification is a row in the user's own
  inbox and duplicating it would show a user two copies of the same event.
- **Auditability.** Every accepted, rejected, and failed attempt is written to
  `admin_audit_logs` and counted in `quickex_operator_replay_total`.
- **Secret hygiene.** No response body, notification body, webhook URL, or
  signing secret is returned. Log lines carry the truncated public key.

### Feature gating

| Network | Replay |
|---|---|
| testnet / development / test | Enabled |
| mainnet | **Blocked** with `MAINNET_GATE_BLOCKED` until the `mainnet.operator_replay` flag is enabled by an admin |

The flag ships **disabled** (`enabled: false`, `environments: ['production']`).
Read-only SLO, alert, and dependency endpoints are not gated — they expose no
customer data and no mutation path.

---

## Operational procedure

### Triage order for "payments are slow"

1. `GET /admin/observability/dependencies` — is a critical dependency down?
2. `GET /admin/observability/alerts` — which rule is `firing`, and what is its
   `measurement.detail`?
3. `GET /admin/observability/slo` — read the breaching objective's `evidence`
   block to identify the failing route or transition.
4. `GET /admin/observability/slo/settlement_latency` for the latency breakdown.

### Recovering a dead-lettered webhook

1. `GET /admin/operations/webhooks` — confirm the backlog and the last error.
2. Confirm the subscriber endpoint is healthy. Replaying into a broken endpoint
   only burns the retry budget again.
3. `GET /admin/observability/replay/{publicKey}/webhook/{eventType}/{eventId}` —
   confirm the status is `dlq`, not `sent`.
4. `POST` the same path. Expect `200` with `delivered: true`.
5. If `delivered: false`, the failure is upstream of us — check the delivery
   status again and escalate rather than looping replays.

### Known limitations / follow-up

- The replay limiter is in-process. Before enabling replay across multiple
  instances, move `WebhookReplayLimiter` to Redis. Tracked as a follow-up.
- `indexing_freshness` currently evaluates a single gauge reading. Sustained
  freshness across the window requires persisting samples; the objective stays
  advisory until then.
- SLO windows are uptime-bounded. Durable multi-window burn rates require
  Prometheus `rate()` over the published series rather than the in-process
  registry.

---

## Related documents

- [CAPABILITY-MAP.md](./CAPABILITY-MAP.md) — Live/Partial status of this capability
- [BACKEND-CLIENT-CONTRACT-MAP.md](./BACKEND-CLIENT-CONTRACT-MAP.md) — endpoint wiring
- [INVARIANTS.md](./INVARIANTS.md) — financial invariants replay cannot affect
- [adr/0002-testnet-first-mainnet-feature-gated.md](./adr/0002-testnet-first-mainnet-feature-gated.md) — the gating policy
