# Backend Documentation

## Overview

The QuickEx backend is a NestJS-based application that provides a comprehensive cryptocurrency trading and notification system. It integrates with Stellar blockchain for transaction processing and includes real-time event ingestion, user management, and notification services.

## Architecture

### Core Modules

- **App Module**: Root module that configures global settings and imports feature modules
- **Config Module**: Handles environment configuration and validation
- **Health Module**: Provides health check endpoints
- **Metrics Module**: Collects and exposes application metrics
- **Stellar Module**: Core Stellar blockchain integration
- **Transactions Module**: Handles transaction processing and validation
- **Usernames Module**: Manages username registration and resolution
- **Notifications Module**: Handles notification dispatching across multiple providers
- **Ingestion Module**: Real-time Stellar event ingestion and processing

### Key Services

#### StellarIngestionService
- **Purpose**: Ingests real-time events from Stellar blockchain via Horizon API
- **Features**:
  - Contract event streaming with cursor-based resumption
  - Exponential backoff reconnection logic
  - Event parsing and persistence
  - Domain event emission via EventEmitter2

#### NotificationService
- **Purpose**: Dispatches notifications based on user preferences
- **Features**:
  - Multiple notification providers (Email, Push, Webhook)
  - Event-driven architecture using @OnEvent decorators
  - Rate limiting and preference filtering
  - Notification logging and tracking

#### SorobanEventParser
- **Purpose**: Parses raw Stellar contract events into structured domain events
- **Features**:
  - XDR decoding using stellar-sdk
  - Address validation and conversion
  - Event type classification

## Fee Calculation and Rounding

Basis-point fees are computed with integer arithmetic on the asset's smallest supported unit (stroops for XLM, the asset's base unit for issued assets). No floating point is used.

### Rounding direction
- The fee is rounded **down** (floor) to the nearest integer base unit: `fee = floor(amount * feeBps / 10_000)`.
- The recipient amount is the remainder: `recipient = amount - fee`.
- This guarantees `fee + recipient === amount` for every deposit, so value is conserved exactly.
- At the smallest supported amounts the fee may round to `0`; the recipient still receives the full deposit. The fee never rounds up to consume the full amount.

### Fee ceilings
- The computed fee is clamped to the configured maximum fee. If the ceiling is lower than the floored fee, the ceiling is used and the remainder goes to the recipient.
- The fee never exceeds the configured ceiling, and the recipient amount is never negative.

### Tested boundaries
Automated tests cover representative asset precisions (including the smallest supported amounts) and fee limits, asserting that:
- `fee + recipient === deposit` for all cases.
- `fee <= configured ceiling`.
- Small deposits round the fee down to `0` rather than consuming the deposit.

## Storage-Layout Compatibility Fixtures

Upgrade checks must exercise realistic serialized state from the version being migrated, not only freshly initialized state. The escrow contract keeps a minimal prior-version storage-layout fixture for this purpose.

### Fixture contents
- A serialized snapshot of the prior contract version's persisted escrow record, including `owner`, `asset`, `amount`, `status`, and `nonce`.
- The fixture is committed alongside the contract tests and decoded during CI so layout drift is caught before deployment.

### Migration guarantees
- Migration from the prior version preserves `owner`, `asset`, `amount`, `status`, and `nonce` exactly.
- Migration is deterministic: replaying the same fixture always yields the same migrated state.
- Migration fails closed: unknown fields or unsupported prior versions are rejected rather than silently coerced.

### Tested boundaries
Automated tests decode the fixture, run the migration, and assert field preservation, determinism across repeated runs, and rejection of unknown fields and unsupported versions.

## Transaction Detail Hierarchy

Transaction detail responses are ordered so that the actionable financial summary is presented before raw chain metadata. This applies equally to the payer and recipient views.

### Primary facts (always visible, in order)
1. **Amount** — the transferred value
2. **Asset** — asset code / issuer (or native XLM)
3. **Counterpart** — the other party (payer for recipients, recipient for payers)
4. **Status** — current lifecycle state (e.g. pending, confirmed, failed, refunded)
5. **Ledger evidence** — ledger sequence and confirmation reference proving the transaction

### Advanced metadata (behind a disclosure)
Raw chain identifiers — full transaction hash, operation IDs, memo, raw XDR, and other low-level fields — are grouped behind a collapsible disclosure control. They remain available on demand but are not shown before the primary facts.

### Accessibility
- The disclosure control is a focusable button reachable via keyboard tab order.
- It toggles with `Enter` and `Space` and exposes `aria-expanded` reflecting the current state.
- The controlled region is associated via `aria-controls` and is hidden from assistive tech while collapsed.

## API Endpoints

### Health Checks
- `GET /health` - Basic health check
- `GET /ready` - Readiness probe

### Metrics
- `GET /metrics` - Prometheus metrics endpoint

### Swagger Documentation
- `GET /docs` - Interactive API documentation

## Environment Configuration

### Required Environment Variables

```bash
# Server Configuration
PORT=4000
NODE_ENV=development
NETWORK=testnet

# Database
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=your_supabase_anon_key

# Optional: enables ingestion stream when provided
QUICKEX_CONTRACT_ID=your_contract_id

# Optional: Sentry monitoring
SENTRY_DSN=https://example@o0.ingest.sentry.io/0
```

### Startup Notes
- The backend will fail fast at boot if `NETWORK`, `SUPABASE_URL`, or `SUPABASE_ANON_KEY` are missing.
- In local development with Supabase URL set to localhost, reconciliation and notification modules are skipped by design.

## Testing

### Test Structure
- Unit tests: `*.unit.spec.ts`
- Integration tests: `*.integration.spec.ts`
- E2E tests: `*.e2e-spec.ts`

### Running Tests
```bash
# Run all tests
npm test -- --runInBand

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:int

# Run E2E tests only
npm run test:e2e
```

### Test Coverage
- Total tests: 393
- Coverage includes all major services and repositories
- Tests use Jest framework with NestJS testing utilities

### Escrow Invariant Tests

Escrow state invariants are verified after every failed invocation so that a
failure in a late validation branch cannot leave a partially updated record.

- **Snapshot before failure**: Each test snapshots the relevant storage
  (escrow records, balances, cursors) before triggering a representative
  failure at each transition stage (deposit, withdraw, refund).
- **Assert unchanged on failure**: After the failed call, the test asserts that
  every invariant-relevant value matches the pre-failure snapshot.
- **Failure classes covered**:
  - Authorization errors (unauthorized caller, missing signer, wrong owner)
  - Downstream transfer errors (insufficient balance, transfer rejection,
    Horizon/Soroban submission failure)

These tests live alongside the escrow service specs and run as part of
`npm run test:unit`.

### Escrow Event Ordering Tests

Multi-step escrow operations (deposit, withdraw, refund) may emit more than one
event per invocation. Indexers rely on the emitted sequence to reconstruct
lifecycle order, so the order and payloads are treated as part of the contract.

- **Committed state only**: Events are emitted only after the corresponding
  state transition has been committed. No event is emitted for a step that did
  not persist.
- **Stable ordering**: For a given operation the emitted event sequence is
  deterministic and documented below; tests assert the exact order.
- **No partial sequences on failure**: If an operation fails at any step, no
  lifecycle events from that invocation are emitted (no partial sequence).
- **Payload consistency**: Each event's payload matches the committed record
  (escrow id, amounts, participants) at the time of emission.

These tests live alongside the escrow service specs and run as part of
`npm run test:unit`.

### Contract Budget Regression Tests

Contract budget regression tests exercise the worst-case call paths under the
declared limits (maximum participants, maximum amounts, maximum event payload
size) and assert that CPU and storage growth stay within a fixed budget.

- **Reproducible inputs**: Each case builds its inputs deterministically from
  the declared limits, so the same case produces the same measurement on every
  run and on every machine.
- **Regression threshold**: Each case records a budget threshold. Exceeding the
  threshold fails the contract CI job; the job does not warn-and-continue.
- **Threshold changes require review**: Any change to a recorded threshold must
  be accompanied by an explicit review note explaining why the budget moved.
  Silent threshold bumps are rejected in review.
- **Boundary coverage**: Cases include the exact-limit input (passes) and the
  limit-plus-one input (rejected by validation) so the boundary is covered on
  both sides.

These tests run as part of the contract CI job and are not part of
`npm run test:unit`.

## Event System

### Event Types
- `stellar.EscrowDeposited` - Escrow deposit events
- `stellar.EscrowWithdrawn` - Escrow withdrawal events
- `stellar.EscrowRefunded` - Escrow refund events
- `payment.received` - Payment received events
- `username.claimed` - Username claim events

### Escrow Event Ordering

For operations that emit multiple events, the emission order is stable and
reflects committed state transitions:

- **Deposit**: `stellar.EscrowDeposited` (single lifecycle event).
- **Withdraw**: `stellar.EscrowWithdrawn` (single lifecycle event).
- **Refund**: `stellar.EscrowRefunded` (single lifecycle event).

When an operation performs additional state updates (e.g. balance or cursor
updates), those are committed before the corresponding lifecycle event is
emitted. If the operation fails, no lifecycle event is emitted for that
invocation.

### Event Flow
1. StellarIngestionService streams events from Horizon
2. SorobanEventParser converts raw events to domain events
3. Events are emitted via EventEmitter2
4. NotificationService listens for relevant events
5. Notifications are dispatched based on user preferences

## Escrow Semantics

### Self-Directed Escrows (Creator == Recipient)

Same-account escrows, where the escrow creator and the recipient are the same
account, are **allowed**. This is an explicit, supported configuration rather
than an error case. The following invariants hold:

- **Create**: A creator may open an escrow where `creator == recipient`. The
  deposited amount is debited from the account and held by the escrow contract
  exactly as in the two-party case.
- **Release**: Releasing a self-directed escrow credits the held amount back to
  the same account. The net balance change across create + release is zero, so
  balances conserve.
- **Refund**: Refunding a self-directed escrow returns the held amount to the
  creator (who is also the recipient). The net balance change across create +
  refund is zero, so balances conserve.
- **Authorization**: Role checks are still enforced. Only the designated
  recipient may release and only the creator may refund; the fact that both
  roles resolve to the same account does not bypass either check. A caller that
  is neither the creator nor the recipient is rejected on both paths.

These behaviors are covered by focused automated tests that exercise create,
release, and refund for the same-account case, assert balance conservation, and
include the failure case where an unrelated account attempts to release or
refund.

## Database Schema

### Key Tables
- `cursors` - Stream cursor tracking for event ingestion
- `escrow_events` - Escrow-related events
- `notification_preferences` - User notification preferences
- `notification_logs` - Notification delivery tracking

## Error Handling

### Global Error Handling
- HTTP exception filters for standardized error responses
- Winston logging for structured logging
- Graceful degradation for external service failures

### Escrow Failure Semantics
- A failed escrow invocation (authorization or downstream transfer error)
  must leave escrow storage and balances unchanged.
- Rollback is expected to be atomic; the invariant tests above guard against
  regressions where a late validation branch partially mutates state.
- A failed invocation emits no lifecycle events, so indexers never observe a
  partial sequence for an operation that did not commit.

### Rate Limiting
- Built-in rate limiting for API endpoints
- Exponential backoff for Stellar Horizon API calls
- Circuit breaker pattern for external service integration

## Deployment

### Build Process
```bash
# Build the application
npm run build

# Start production server (after build)
npm run start
```

### Docker Support
- Dockerfile included for containerized deployment
- Multi-stage build for optimized production images

## Monitoring

### Metrics
- Prometheus metrics collection
- Custom business metrics for transaction processing
- Health check endpoints for load balancers

### Available Metrics
- `http_request_duration_seconds` - HTTP request latency by method, route, status
- `http_requests_total` - Total HTTP requests by method, route, status
- `http_rate_limited_requests_total` - Rate-limited requests by method, route, group
- `http_active_connections` - Current active connections
- `ingestion_lag_seconds` - Lag between current ledger and last ingested ledger
- `webhook_retry_total` - Webhook retry attempts by event type, status
- `webhook_delivery_duration_seconds` - Webhook delivery latency by event type, status
- `external_call_duration_seconds` - External API call latency by service, operation
- `error_total` - Error count by service, error type

### Logging
- Structured logging with Winston
- Correlation IDs for request tracing
- Different log levels for development and production
- All logs include: `request_id`, `user_id`, `route`, `method`, `duration`, `status`

## Runbook

### Observability

#### Checking Request Traces
1. Extract `correlationId` from request headers (`x-correlation-id`)
2. Search logs for the correlation ID to trace full request lifecycle
3. Check `logs/combined.log` for structured JSON logs
4. Check `logs/error.log` for error-specific logs

#### Monitoring Ingestion Lag
1. Query `ingestion_lag_seconds` metric for contract ID
2. Alert if lag exceeds 60 seconds (indicates stalled ingestion)
3. Check ingestion service logs for stream errors
4. Verify Horizon API connectivity

#### Debugging Webhook Failures
1. Check `webhook_retry_total` metric for retry counts
2. Query `webhook_delivery_duration_seconds` for latency patterns
3. Review notification logs in database for specific webhook URLs
4. Use `GET /webhooks/delivery-logs` endpoint for detailed logs
5. Trigger manual redelivery via `POST /webhooks/redeliver`

#### Identifying Slow External Dependencies
1. Query `external_call_duration_seconds` by service label
2. High latency on `horizon` operations indicates network issues
3. High latency on `webhook` operations indicates endpoint issues
4. Check `error_total` metric for error types by service

### Reconciliation

#### Manual Reconciliation Trigger
```bash
# Trigger reconciliation run
curl -X POST http://localhost:4000/reconciliation/trigger

# Check reconciliation status
curl http://localhost:4000/reconciliation/status
```

#### Interpreting Reconciliation Reports
- `processed` - Total records checked
- `updated` - Records updated to match on-chain state
- `noOp` - Records already consistent with on-chain state
- `skipped` - Records skipped due to Horizon unavailability
- `irreconcilable` - Records requiring manual review

#### Handling Irreconcilable Records
1. Check logs for `IRRECONCILABLE` error messages
2. Verify on-chain state using Stellar expert or Horizon directly
3. For escrows: Check if account exists, balance, and expiry
4. For payments: Verify transaction hash on-chain
5. Manual database update may be required after verification

#### Backfill Operations
```bash
# Trigger backfill for specific ledger range
curl -X POST http://localhost:4000/reconciliation/backfill \
  -H "Content-Type: application/json" \
  -d '{"startLedger": 1000, "endLedger": 2000}'
```

## Upgrade Authorization

### Binding Rules
Upgrade approvals are bound to the exact artifact they authorize. An approval record captures:

- `wasmHash` - The SHA-256 hash of the approved WASM artifact
- `version` - The intended contract version
- `windowStart` / `windowEnd` - The upgrade window during which the approval is valid
- `status` - `pending`, `consumed`, `cancelled`, or `expired`

An approval can only be consumed once, and only when the installed artifact's hash and version match the approved values and the current ledger time falls within the approval window.

### Replay Protection
- **Changed artifact**: Installing a WASM whose hash differs from the approved `wasmHash` is rejected; the approval remains unconsumed and no code or registry state changes.
- **Reuse**: A consumed approval cannot be replayed. Subsequent attempts fail with `UpgradeAuthorizationAlreadyConsumed` and leave code and registry state untouched.
- **Expiry**: Attempts after `windowEnd` fail with `UpgradeAuthorizationExpired`; the approval transitions to `expired` without mutating code or registry state.
- **Cancellation**: A cancelled approval cannot be consumed; attempts fail with `UpgradeAuthorizationCancelled`.

### Failure Semantics
All replay, expiry, cancellation, and changed-artifact failures are atomic: the contract code hash, version, and registry entries are unchanged when the authorization check fails. Failures are surfaced as typed errors so callers can distinguish the cause.

### Test Coverage
The upgrade authorization suite (`upgrade-authorization.*.spec.ts`) covers:
- Successful install of the approved artifact within the window
- Replay of a consumed approval
- Expiry at and after `windowEnd`
- Cancellation before consumption
- Changed-artifact attempts (hash mismatch and version mismatch)
