# Escrow Contract

This contract holds funds for a payer/payee pair and releases them on
mutual agreement or timeout. Each escrow is identified by a deterministic
nonce derived from the creator, the counterparty, and a monotonically
increasing sequence counter stored in contract state.

## Nonce derivation

- `nonce = hash(creator, counterparty, sequence)` where `sequence` is the
  next value of the on-chain counter.
- The counter is incremented on every successful `create_escrow` and
  `upgrade_escrow` call, so two escrows created in the same transaction
  batch never share a nonce.
- Boundary inputs (empty counterparty, max-length identifiers, sequence
  values at `u64::MAX - 1`) are covered by tests to guarantee no collision
  for deterministic inputs.

## Upgrade behavior

- `upgrade` migrates the sequence counter to the new contract instance
  without resetting it. The next escrow created after an upgrade uses
  `previous_sequence + 1`, preserving uniqueness across instances.
- If the counter would overflow (`sequence == u64::MAX`), the call fails
  safely with `EscrowError::NonceOverflow` and no state is mutated.

## Tests

`contracts/escrow/src/test.rs` includes focused coverage for:

- Multiple escrows created before and after a simulated upgrade, asserting
  all derived nonces are unique.
- Deterministic boundary inputs (empty and max-length identifiers,
  sequence at `u64::MAX - 1`) producing distinct nonces.
- Migration preserving the next nonce value across the upgrade boundary.
- Overflow at `u64::MAX` failing with `NonceOverflow` and leaving the
  counter unchanged.
