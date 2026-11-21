# Escrow Contract

Soroban escrow contract for milestone-based payments between a payer and a payee.

## Storage lifetime (persistent TTL)

All active escrow records live in **persistent** storage. Soroban persistent
entries expire unless their TTL is extended, so **every** path that reads or
mutates an active escrow must renew the TTL for the entries it touches. If a
single mutation path forgets to extend, the escrow can become unreadable
mid-lifecycle.

### Active-record access and mutation paths

| Path | Function | Entries touched | TTL renewed |
| --- | --- | --- | --- |
| Creation | `create_escrow` | `Escrow(id)`, `EscrowIndex` | yes |
| Read | `get_escrow` | `Escrow(id)` | yes |
| Extension | `extend_deadline` | `Escrow(id)` | yes |
| Partial progress | `release_milestone` | `Escrow(id)` | yes |
| Terminal transition | `complete_escrow` / `cancel_escrow` | `Escrow(id)`, `EscrowIndex` | yes |

### TTL budget

Renewal uses a bounded budget so a single call cannot extend storage
indefinitely:

- `TTL_MIN_LEDGERS` — lower bound; every renewal extends at least this far.
- `TTL_MAX_LEDGERS` — upper bound; no renewal extends beyond this.

Assertions in the test suite check both bounds (not just presence of a
renewal), so a path that renews too little or too much fails loudly.

## Tests

`contracts/escrow/src/test.rs` covers TTL renewal on each path above:

- creation, extension, partial progress, and terminal transition each renew
  the escrow entry within `[TTL_MIN_LEDGERS, TTL_MAX_LEDGERS]`;
- a boundary/failure case asserts that a path which does **not** renew the TTL
  is detected (the entry's live-until ledger stays below the required floor).

Run with:

```sh
cargo test -p escrow
```
