# Internal Event System

Decoupled event handling using `@nestjs/event-emitter`.

## Registered Events

### Core Payment Events

| Event Name | Description | Payload Schema |
| :--- | :--- | :--- |
| `username_claimed` | Fired when a username is registered | `{ username: string, publicKey: string, timestamp: string }` |
| `payment_received` | Fired when a payment is detected | `{ txHash: string, amount: string, sender: string }` |

### Recurring Payment Events

| Event Name | Description | Payload Schema |
| :--- | :--- | :--- |
| `recurring.link.created` | Fired when a recurring payment link is created | `{ linkId: string, username?: string, destination?: string }` |
| `recurring.link.updated` | Fired when a recurring link is updated | `{ linkId: string, changes: object }` |
| `recurring.link.cancelled` | Fired when a recurring link is cancelled | `{ linkId: string, username?: string, destination?: string }` |
| `recurring.link.paused` | Fired when a recurring link is paused | `{ linkId: string, username?: string, destination?: string }` |
| `recurring.link.resumed` | Fired when a recurring link is resumed | `{ linkId: string, username?: string, destination?: string }` |
| `recurring.link.completed` | Fired when a recurring link completes all periods | `{ linkId: string, totalExecuted: number }` |
| `recurring.payment.due` | Fired 24h before a payment is scheduled | `{ linkId: string, executionId: string, amount: number, asset: string, periodNumber: number }` |
| `recurring.payment.executed` | Fired when a recurring payment succeeds | `{ linkId: string, executionId: string, transactionHash: string, periodNumber: number }` |
| `recurring.payment.failed` | Fired when a recurring payment fails | `{ linkId: string, executionId: string, failureReason: string, retryCount: number, permanent: boolean }` |

### Receipt Reconciliation Events

| Event Name | Description | Payload Schema |
| :--- | :--- | :--- |
| `receipt_status_conflict` | Fired when an observation would regress a receipt's canonical status | `{ receiptId: string, txHash: string, currentStatus: string, observedStatus: string, source: string, observedAt: string }` |

## Receipt Status Transitions

Receipt reconciliation enforces monotonic status transitions at the persistence boundary. A late or duplicated chain event must never overwrite a newer receipt state with an earlier status.

### Canonical status ordering

Statuses are ranked from least to most advanced:

| Rank | Status | Meaning |
| :--- | :--- | :--- |
| 0 | `pending` | Receipt observed but not yet confirmed |
| 1 | `confirmed` | Transaction included in a block |
| 2 | `finalized` | Transaction reached finality |
| 3 | `failed` | Terminal failure state |

### Allowed transitions

| From | Allowed To |
| :--- | :--- |
| `pending` | `confirmed`, `finalized`, `failed` |
| `confirmed` | `finalized`, `failed` |
| `finalized` | *(none — terminal)* |
| `failed` | *(none — terminal)* |

Any transition not listed above is rejected. In particular, a lower-ranked observation (e.g. `confirmed` arriving after `finalized`) is never applied to the canonical receipt state.

### Out-of-order and duplicate events

- **Out-of-order events:** When an observation's status ranks lower than the receipt's current canonical status, the canonical state is left unchanged and the observation is recorded as conflict evidence (see below). A `receipt_status_conflict` event is emitted for downstream consumers.
- **Duplicate events:** An observation whose status equals the current canonical status is idempotent — no state change, no conflict record, and no event. Re-delivery of the same chain event is therefore safe.
- **Forward transitions:** Observations that advance the status along an allowed transition update the canonical state and are recorded as normal reconciliation history.

### Conflict evidence

Rejected observations are retained rather than dropped, so operators can audit late or duplicated chain events.

Table: `receipt_status_conflicts`

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | uuid | Primary key |
| `receiptId` | string | Receipt whose canonical state was protected |
| `txHash` | string | Transaction hash of the conflicting observation |
| `currentStatus` | string | Canonical status at the time of the observation |
| `observedStatus` | string | Status carried by the rejected observation |
| `source` | string | Origin of the observation (e.g. `chain-listener`, `reconciler`) |
| `observedAt` | timestamp | When the observation was produced |
| `createdAt` | timestamp | When the conflict was recorded |

Each recorded conflict also emits a `receipt_status_conflict` event with the same identifying fields so that alerting and dashboards can react without polling the table.

## How to add new handlers
1. Inject `NotificationService` (or create a new service).
2. Use the `@OnEvent('event_name', { async: true })` decorator.