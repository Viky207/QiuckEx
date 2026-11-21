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

## Event Compatibility Contract

Indexer consumers depend on stable event names (topics) and payload shapes across contract changes. The compatibility test suite pins each public state-transition event so that any breaking change fails CI and requires an explicit versioning decision.

### Pinned events

Each public state-transition event is asserted for its topic name, schema version, indexed identifiers, and payload shape:

| Event Name (topic) | Version | Indexed Identifiers | Payload Fields |
| :--- | :--- | :--- | :--- |
| `username_claimed` | `1` | `username` | `username`, `publicKey`, `timestamp` |
| `payment_received` | `1` | `txHash` | `txHash`, `amount`, `sender` |
| `recurring.link.created` | `1` | `linkId` | `linkId`, `username?`, `destination?` |
| `recurring.link.updated` | `1` | `linkId` | `linkId`, `changes` |
| `recurring.link.cancelled` | `1` | `linkId` | `linkId`, `username?`, `destination?` |
| `recurring.link.paused` | `1` | `linkId` | `linkId`, `username?`, `destination?` |
| `recurring.link.resumed` | `1` | `linkId` | `linkId`, `username?`, `destination?` |
| `recurring.link.completed` | `1` | `linkId` | `linkId`, `totalExecuted` |
| `recurring.payment.due` | `1` | `linkId`, `executionId` | `linkId`, `executionId`, `amount`, `asset`, `periodNumber` |
| `recurring.payment.executed` | `1` | `linkId`, `executionId` | `linkId`, `executionId`, `transactionHash`, `periodNumber` |
| `recurring.payment.failed` | `1` | `linkId`, `executionId` | `linkId`, `executionId`, `failureReason`, `retryCount`, `permanent` |
| `receipt_status_conflict` | `1` | `receiptId`, `txHash` | `receiptId`, `txHash`, `currentStatus`, `observedStatus`, `source`, `observedAt` |

### Compatibility rules

- **Topic stability:** Renaming an event topic is a breaking change. The compatibility test asserts the exact topic string for every pinned event.
- **Payload stability:** Adding, removing, renaming, or retyping a payload field is a breaking change. The compatibility test asserts the exact field set and types for every pinned event.
- **Indexed identifiers:** The set of indexed identifiers is part of the public contract; changing it is a breaking change.
- **Versioning decision:** Any breaking change must bump the event's `version` and be accompanied by an explicit migration note. Until then, the compatibility test fails and blocks the change.

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