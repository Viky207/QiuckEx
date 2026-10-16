# Architecture Decision Records (ADRs)

This directory is the durable record of **irreversible or expensive-to-reverse protocol and custody decisions** in QuickEx. Issue [#309](https://github.com/Viky207/QiuckEx/issues/309) established this process.

An ADR is required (and the governance gate in `scripts/governance/check.mjs` enforces the formatting) whenever a change:

1. changes **key custody** or signing authority (self-custody is a product invariant),
2. changes an **on-chain** storage layout, role model, pause/emergency semantic, fee formula, or upgrade path,
3. makes a **network-level commitment** (mainnet enablement, contract address reuse, WASM hash pinning),
4. fixes a **wire contract** in a way clients cannot migrate away from cheaply (event topics, error enum values, registry semantics),
5. establishes a **financial invariant** in [../INVARIANTS.md](../INVARIANTS.md).

Cheap-to-reverse implementation choices (a new REST read endpoint, a new flag default, a refactor) do **not** need an ADR — use a normal PR description instead. Err on the side of writing one when you are unsure: an unnecessary ADR costs minutes, a missing one costs a migration.

## Index

| ADR | Title | Status |
|---|---|---|
| [ADR-0001](./0001-self-custody-and-no-server-side-key-custody.md) | Self-custody, no server-side key custody | Accepted |
| [ADR-0002](./0002-monolithic-soroban-escrow-contract.md) | One monolithic Soroban escrow contract | Accepted |
| [ADR-0003](./0003-testnet-only-contract-writes.md) | Contract writes are testnet-only behind feature flags | Accepted |
| [ADR-0004](./0004-irreversible-emergency-pause.md) | Emergency pause is irreversible | Accepted |
| [ADR-0005](./0005-static-fee-model-oracle-deferred.md) | Static fee model; oracle pricing deferred | Accepted |
| [ADR-0006](./0006-contract-registry-rollback-and-etag.md) | Contract registry rollback and ETag change detection | Accepted |
| [ADR-0007](./0007-xray-privacy-zk-scheme.md) | X-Ray privacy ZK scheme selection | Proposed |

## File format (enforced)

- Path: `docs/adr/NNNN-kebab-case-title.md` where `NNNN` is the next free zero-padded sequence number.
- The document **must** start with `# ADR-NNNN: <title>`.
- The document **must** contain these `##` sections, in this order:
  `## Status`, `## Context`, `## Decision`, `## Consequences`, `## Reversal Cost`, `## Invariants Affected`, `## References`.
- `## Status` must be one of: `Proposed`, `Accepted`, `Rejected`, `Deprecated`, `Superseded by ADR-NNNN`.
- Every ADR must have a row in the [Index](#index) table, and every index row must point at a file that exists.
- A `Superseded by ADR-NNNN` status must link the replacement file **and** the replacement must be a real ADR in this directory.
- An ADR body is **immutable once the Status is `Accepted`**, except for the status line and link fixes. Numbering is never reused.

Start from [TEMPLATE.md](./TEMPLATE.md).

## Lifecycle

```
Proposed ──accept──▶ Accepted ──supersede──▶ Superseded by ADR-NNNN
    │                     │
    └──reject──▶ Rejected  └──retire──▶ Deprecated
```

| Transition | Who | Artifact |
|---|---|---|
| Proposed → Accepted | Backend/contract maintainers + one reviewer outside the authoring module | PR that adds the ADR before (or with) the implementing change |
| Accepted → Superseded | Author of the replacement ADR | New ADR + status line update on the old one in the same PR |
| Accepted → Deprecated | Maintainers | Status line update + why it no longer applies |

## Review cadence

- Every ADR is re-read in the release readiness review ([../../RELEASE_READINESS_CHECKLIST.md](../../RELEASE_READINESS_CHECKLIST.md)) before a mainnet-affecting release.
- If the code no longer matches an `Accepted` ADR, the ADR is wrong or the code is a bug: file one of them as a defect and link the other.

## How to verify locally

```bash
node scripts/governance/check.mjs --only adr
node --test scripts/governance/__tests__/adr.test.mjs
```
