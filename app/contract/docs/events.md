# Contract Event Schema Reference

This document describes the structured events emitted by the Soroban escrow
contract. Every state-mutating entry point publishes an event so that off-chain
consumers (e.g. the backend service in `app/backend`) can react to on-chain
state changes without polling.

## Event Envelope

All events share a consistent schema. The event type is published as the first
topic (a `Symbol`), and the remaining fields are published as the event data
payload:

```rust
{
    event_type: Symbol, // one of the event types below
    escrow_id: u64,     // identifier of the affected escrow
    actor: Address,     // address that triggered the transition
    ledger: u32,        // ledger sequence at which the event was emitted
}
```

Events are published with Soroban's `env.events().publish()` API. Payloads are
kept minimal to stay well under Soroban's 8KB event data limit, and no sensitive
data (such as private amounts in X-Ray mode) is emitted in clear text.

## Event Types

| `event_type`        | Emitted when                                             |
| ------------------- | -------------------------------------------------------- |
| `escrow_created`    | A new escrow is created.                                 |
| `escrow_released`   | Escrowed funds are released to the beneficiary.          |
| `escrow_refunded`   | Escrowed funds are refunded to the depositor.            |
| `escrow_expired`    | An escrow passes its deadline and is marked expired.     |
| `contract_paused`   | The contract is paused by an administrator.              |
| `contract_upgraded` | The contract WASM is upgraded to a new version.          |

## Field Semantics

- **`event_type`** — `Symbol` identifying the transition. Matches the values in
the table above.
- **`escrow_id`** — `u64` identifier of the escrow affected by the transition.
For contract-wide events (`contract_paused`, `contract_upgraded`) this is `0`.
- **`actor`** — `Address` that authorized the transition.
- **`ledger`** — `u32` ledger sequence number at which the event was emitted.

## Consuming Events

The backend service subscribes to these events through Horizon's `/events`
endpoint. See `app/backend` for the subscription wiring (tracked in the backend
issue referenced there).
