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
- `ingestion_lag_seconds` - L
