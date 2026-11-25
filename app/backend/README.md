# Backend

## Health and readiness

The backend exposes two distinct probes so that traffic routing can react to
dependency state without taking a live process out of rotation prematurely.

- **Liveness** (`/health/live`): reports whether the process itself is running.
  It stays available (HTTP 200) during dependency outages, including a Supabase
  outage, so orchestrators do not restart a healthy process.
- **Readiness** (`/health/ready`): reports whether the process can serve traffic.
  It reflects the state of critical dependencies. When Supabase (the critical
  persistence dependency) is unavailable, readiness reports `degraded` and
  returns a non-ready status so traffic is not routed to the instance until the
  dependency recovers.

- **Committed state only.** Events are emitted only after the corresponding
  state transition has been committed. No event is emitted for a state change
  that is later rolled back.
- **Stable ordering.** For a given operation, events are emitted in a fixed,
  documented order. The lifecycle sequence is deterministic across runs and
  environments.
- **No partial sequences on failure.** If any step of a multi-step operation
  fails, the operation emits no partial lifecycle sequence. Either the full
  ordered sequence is emitted for the committed state, or nothing is emitted.

### Ordering reference

| Operation | Emitted events (in order) |
|-----------|---------------------------|
| Fund      | `EscrowFunded`            |
| Release   | `EscrowReleased`          |
| Refund    | `EscrowRefunded`          |
| Cancel    | `EscrowCancelled`         |

When an operation performs multiple state updates, the emitted events follow
the order above and each payload reflects the committed post-transition state.

### Testing

Focused automated coverage asserts event order and payload consistency for
multi-step operations, including the failure case where a mid-operation error
must produce no partial lifecycle sequence.

## Contract budget regression

| Variable           | Required | Default       | Description                                           |
| ------------------ | -------- | ------------- | ----------------------------------------------------- |
| `PORT`             | No       | `4000`        | Port number for the HTTP server                       |
| `NODE_ENV`         | No       | `development` | Environment: `development`, `production`, or `test`   |
| `NETWORK`          | **Yes**  | -             | Stellar network: `testnet` or `mainnet`               |
| `SUPABASE_URL`     | **Yes**  | -             | Supabase project URL (e.g., `https://xxx.supabase.co`)|
| `SUPABASE_ANON_KEY`| **Yes**  | -             | Supabase anonymous (public) API key                   |
| `MAX_USERNAMES_PER_WALLET` | No | (no limit) | Max usernames per wallet; omit for no limit           |
| `RECONCILIATION_BATCH_SIZE` | No | `1000` | Max ledgers processed per reconciliation job; clamped to safe bounds |

- **Reproducible.** Budget tests use fixed worst-case fixtures and a
  deterministic measurement harness, so results are stable across runs and
  environments.
- **Enforced in contract CI.** The budget job runs on every contract change and
  fails when any measured path exceeds its threshold.
- **Explicit review for threshold changes.** Raising a threshold requires an
  explicit review note explaining why the new bound is acceptable; silent
  threshold bumps are rejected.

### Testing

Focused automated coverage includes the boundary case where a worst-case input
sits exactly at the declared limit (must pass) and the failure case where a
path exceeds its threshold (must fail the job).

## Documentation

### Environment Validation

The backend validates all environment variables at startup using a Joi schema. If required variables are missing or invalid, the application will:

1. Log a clear, actionable error message listing all missing/invalid keys
2. Exit with a non-zero exit code

**Note:** For security, actual secret values are never logged—only the key names.

## Reconciliation cursor

Reconciliation runs over large ledger intervals are processed in bounded batches so a single job cannot exceed request time or memory limits.

- Each job processes at most `RECONCILIATION_BATCH_SIZE` ledgers (default `1000`). The value is validated and clamped to a safe range (`1`–`10000`); out-of-range values are clamped rather than rejected.
- A resumable cursor (`lastProcessedLedger`) is persisted with the run metadata after each batch. Restarting a run resumes from the ledger immediately after the cursor, so ledgers are neither skipped nor double-counted.
- Progress is observable via the run metadata (`lastProcessedLedger`, `processedCount`, `completed`), which is updated as each batch completes.

## Stellar configuration

### Network

- Env var: `STELLAR_NETWORK`
- Allowed values: `testnet`, `mainnet`
- Default: `testnet`
- Invalid values fail fast with a startup error.

Example `.env`:

```bash
STELLAR_NETWORK=testnet
```

### Supported assets

Asset validation is driven by `SUPPORTED_ASSETS` in `src/config/stellar.config.ts`.

Native asset shape:

```ts
{ type: 'native', code: 'XLM' }
```

Issued asset shape:

```ts
{ type: 'credit_alphanum4', code: 'USDC', issuer: 'G...ISSUER' }
```

How to add a new supported asset:

1. Add a new entry to `SUPPORTED_ASSETS`.
2. For issued assets, include the exact issuer (case-sensitive).
3. Update tests and docs.

Example issued asset:

```ts
{
  type: 'credit_alphanum4',
  code: 'EURT',
  issuer: 'GEXAMPLEISSUERADDRESS'
}
```

## Database Migrations

Production migrations are serialized with a database-backed lock so two concurrent release runs cannot apply the same migration set at the same time.

### How the lock works

- Before applying migrations, the migration runner acquires a PostgreSQL advisory lock (`pg_try_advisory_lock`) on a fixed key derived from the migration namespace.
- If the lock is already held by another session, the runner exits with a non-zero status and a clear message instead of applying migrations. Re-run the release after the in-flight migration finishes.
- The lock is released in a `finally` block (`pg_advisory_unlock`) so a failed migration does not leave the lock held by the runner's own session.
- Session-level advisory locks are automatically released when the holding connection closes, so a crashed runner does not permanently block future releases.

### Detecting a stale lock

If a release reports that the migration lock is held but no migration appears to be running, inspect the lock holders:

```sql
SELECT l.pid, a.usename, a.application_name, a.client_addr, a.state, a.query_start
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype = 'advisory'
  AND l.objid = :migration_lock_key;
```

A holder is stale when its `state` is `idle`/`idle in transaction` with no active migration, or when the backend PID no longer corresponds to a running release job.

### Safe recovery procedure

1. Confirm no migration is actually in progress (check `pg_stat_activity` for the holder PID and the release pipeline status).
2. Terminate the stale backend session, which releases its advisory locks:

   ```sql
   SELECT pg_terminate_backend(:stale_pid);
   ```

3. If the lock is held by a session you control and you want to release it without terminating the connection, run the matching unlock on that same session:

   ```sql
   SELECT pg_advisory_unlock(:migration_lock_key);
   ```

4. Re-run the release. The runner will acquire the lock and apply any pending migrations.

**Never** drop or truncate migration tracking tables to clear a lock; the lock is advisory and is not stored in application tables.

## Scripts

Run from repo root using TurboRepo filters:

```bash
pnpm turbo run dev --filter=@quickex/backend      # Start development server
pnpm turbo run test --filter=@quickex/backend     # Run tests
pnpm turbo run type-check --filter=@quickex/backend  # TypeScript type checking
pnpm turbo run lint --filter=@quickex/backend     # Lint code
pnpm turbo run build --filter=@quickex/backend    # Build for production
```

## API Documentation (Swagger/OpenAPI)

Interactive API documentation is available via Swagger UI:

**URL:** `http://localhost:4000/docs`

The Swagger UI provides:
- Interactive endpoint exploration
- Request/response schema documentation
- "Try it out" functionality for testing endpoints
- Downloadable OpenAPI specification

### Screenshots

When the server is running, navigate to `/docs` to see:
- All available endpoints organized by tags
- **Transactions Endpoint**: `GET /transactions` fetches recent payments with caching and pagination.
- Response schemas and status codes
- Example payloads

## Metrics

The backend exposes Prometheus metrics via `prom-client` at `GET /metrics` (default port `4000`).

```bash
curl localhost:4000/metrics
```

For the full metric reference — names, types, labels, descriptions, example PromQL queries, and recommended P0/P1 alert thresholds — see [`docs/METRICS-REFERENCE.md`](../../docs/METRICS-REFERENCE.md).

## Endpoints

### Health and Readiness (Ops Visibility)

The API provides two endpoints for monitoring, following standard probe semantics:

| Method | Path      | Name      | Description                                      | Response                                      |
| ------ | --------- | --------- | ------------------------------------------------ | --------------------------------------------- |
| GET    | `/health` | Liveness  | Shallow check: is the server up?                 | `{ "status": "ok", "version", "uptime" }`     |
| GET    | `/ready`  | Readiness | Deep check: are dependencies (Supabase) healthy? | `{ "ready": true, "checks": [...] }`          |

#### Probe Semantics

- **`/health` (Liveness)**: Use this for Kubernetes liveness probes. It returns `200 OK` as long as the process is running. It includes application version and uptime for better visibility.
- **`/ready` (Readiness)**: Use this for Kubernetes readiness probes or load balancer health checks. It performs dependency checks:
  - **Supabase Connectivity**: Pings the database to ensure it's reachable.
  - **Environment Validation**: Ensures all critical environment variables are loaded.
  - Returns `503 Service Unavailable` if any check fails.

### Usernames (quickex.to/yourname)

| Method | Path        | Description              | Request / Query                 | Response                    |
| ------ | ----------- | ------------------------ | ------------------------------- | --------------------------- |
| POST   | `/usern
