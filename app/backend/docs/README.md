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

## Event System

### Event Types
- `stellar.EscrowDeposited` - Escrow deposit events
- `stellar.EscrowWithdrawn` - Escrow withdrawal events
- `stellar.EscrowRefunded` - Escrow refund events
- `payment.received` - Payment received events
- `username.claimed` - Username claim events

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
