# Backend

This directory contains the backend services for the application.

## Escrow event emission order

Multi-step escrow operations (e.g. funding, releasing, refunding, and
cancelling) may emit more than one event within a single call. Indexers rely on
these events to reconstruct lifecycle order, so the backend guarantees the
following contract:

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

Contract entry points must stay within the declared CPU and storage limits even
for worst-case inputs (maximum configured amounts, maximum number of line
items, and maximum-length metadata). Budget regression tests exercise these
worst-case call paths under the declared limits and compare the measured cost
against a committed threshold.

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

- [Public API reference](./docs/PUBLIC-API-REFERENCE.md)
- [Backend docs index](./docs/README.md)
