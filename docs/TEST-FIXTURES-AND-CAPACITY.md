# Test Fixtures, Capacity Budgets, and Incident Runbooks

Operational guide for the testnet fixture manager, the capacity and privacy
budgets on the support bundle, and the payment-journey regression suite. Read
[OBSERVABILITY-OPERATIONS.md](./OBSERVABILITY-OPERATIONS.md) first for the SLO,
alert, and replay surfaces this document builds on.

## Assumptions

- **Network.** Every fixture is a Stellar **testnet** account. The manager
  refuses to run unless `NETWORK=testnet`. There is no mainnet path and no
  configuration that enables one.
- **Custody.** Fixtures are derived from a public constant in
  `app/backend/src/testnet-fixtures/fixture-derivation.ts`. They hold no real
  value, and the manager only ever *reads* balances and asks friendbot to create
  new accounts. It never signs for a user and never moves an existing account's
  funds, so QuickEx's self-custody model is unchanged.
- **Backward compatibility.** No existing endpoint, DTO, or response shape
  changed. The new surfaces are additive: a module, a metrics pair, and tests.

## Testnet fixture manager

Deterministic, idempotent wallet fixtures. The same fixture name always
resolves to the same account, so a test that failed yesterday fails identically
today and a transaction recorded in an incident report can still be located.

### Using it

```ts
import { TestnetFixtureManager } from '../src/testnet-fixtures';

const result = await manager.ensureFixtures(['sender', 'recipient'], {
  balanceXlm: 100,
});

result.accounts;  // [{ name, publicKey, balanceXlm, status }]
result.failures;  // [{ name, code, message }] — per-account, never fatal
```

### Guarantees

| Property | How it is enforced |
|---|---|
| Deterministic | `name -> sha256 -> ed25519 seed -> account id`. Pure function. |
| Idempotent | Read-then-act. An account already at or above the target balance is never re-funded. |
| Network-contained | `ensureFixtures` throws `FIXTURE_NETWORK_NOT_TESTNET` **before** any I/O on a non-testnet network. |
| Diagnosable | Per-account failures carry a stable code; one bad account does not abort the set. |
| Bounded retries | Exponential backoff, and 4xx responses are never retried (except 408/429). |

### Stable error codes

| Code | Meaning | Operator action |
|---|---|---|
| `FIXTURE_NETWORK_NOT_TESTNET` | Invoked with `NETWORK` not `testnet`. | Set `NETWORK=testnet`. No account was touched. |
| `FIXTURE_INVALID_NAME` | Name outside `[a-z0-9_-]`. | Fix the fixture name. |
| `FIXTURE_INVALID_ACCOUNT_ID` | A value did not decode as an ed25519 key. | Investigate; the derivation should always produce a valid id. |
| `FIXTURE_DEPENDENCY_UNAVAILABLE` | Horizon unreachable after the retry budget. | Check Horizon/Soroban RPC reachability, then re-run. |
| `FIXTURE_FUNDING_FAILED` | Funded, but the balance could not be read back. | Re-read after a short delay; friendbot is eventually consistent. |

### Observability

`quickex_testnet_fixture_total{outcome}` and
`quickex_testnet_fixture_duration_seconds{outcome}`, where `outcome` is one of
`ready`, `created`, `topped_up`, `underfunded`, `failed`. The fixture **name** is
deliberately not a label: labels are a permanent registry cost and the fixture
set is expected to grow. Secret seeds are never returned or logged.

## Support bundle: privacy and capacity budgets

`GET /api/admin/support/bundle` (admin scope) produces the JSON bundle attached
to bug reports. Because that output deliberately leaves the trust boundary, its
redaction is asserted against the **serialized bytes** rather than field by
field — see `src/support-bundle/__tests__/support-bundle.privacy.unit.spec.ts`.

### What is redacted

| Data | Rule |
|---|---|
| Secret keys (`S…`), public keys, JWTs | Replaced via `sanitizeErrorMessage`, in error summaries, actors, and request ids. |
| Email-shaped actors | Replaced with `[REDACTED]`. |
| Request ids | Omitted unless `includeRequestIds=true`; sanitized even then. |
| Network config | Network name and public passphrase only. |

### Capacity budgets

| Budget | Value | Rationale |
|---|---|---|
| Single assembly | < 500 ms | The bundle is used during an incident; a slow one gets skipped. |
| `recent_errors` | ≤ 50 entries | Keeps the bundle small enough to paste into an issue. |
| Scaling | 50× input must not cost 50× time | Catches an accidental N+1 against the audit store. |

### Runbook: "a customer pasted a key into a support bundle"

1. Treat the key as compromised and rotate it. Redaction is preventative, not a
   guarantee for bundles generated *before* the fix.
2. Ask for the bundle to be deleted from the issue or chat.
3. Confirm no `[REDACTED_SECRET_KEY]`-adjacent raw value remains by re-running
   the privacy suite against a bundle built from the reported input.

## Payment journey regression suite

`app/backend/test/payment-journey.int.spec.ts` pins the contract → backend →
client path that no single type system spans.

- **ABI drift.** The `deposit` argument list is parsed from
  `app/contract/contracts/quickex/src/lib.rs` at test time and compared against
  the backend's param list. A contract change that is not mirrored fails here
  rather than on-chain.
- **Client contract.** The assembled XDR is decoded back into its contract id,
  method, and argument count, so a payload the client cannot actually use fails.
- **Failure modes.** Unknown source account, contract-level simulation error,
  restore-required, RPC outage, idempotent replay, idempotency-key reuse with a
  mutated payload, and both payload limits.

```bash
cd app/backend
pnpm run test:int -- payment-journey
```

## Fuzz coverage for DTOs and cursors

`app/backend/test/fuzz/quickex.fuzz.spec.ts` asserts safety properties rather
than example inputs: validation never throws, accepted values stay inside
documented bounds, a malformed cursor yields a stable `null` rather than a 500,
and `paginateResult` never returns more rows than the limit.

```bash
cd app/backend
pnpm run test:fuzz
```

Runs are seeded (`SEED = 0x286`) so a failure reproduces identically in CI.

## Related documents

- [CAPABILITY-MAP.md](./CAPABILITY-MAP.md) — capability status.
- [INVARIANTS.md](./INVARIANTS.md) — the financial invariants these tests defend.
- [OBSERVABILITY-OPERATIONS.md](./OBSERVABILITY-OPERATIONS.md) — SLOs and alerts.
