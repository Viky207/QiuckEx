# QuickEx Mainnet Promotion Evidence and Governance Approvals

This document defines the formal criteria, evidentiary standards, and governance approvals required to promote QuickEx capabilities—specifically Soroban smart contracts, on-chain transaction composing, and financial state transitions—from **Testnet / Experimental** to **Stellar Mainnet / Live**.

---

## 1. Mainnet Promotion Gateways

No smart contract or on-chain transaction feature may be promoted to Stellar Mainnet without fulfilling all five Promotion Gateways:

```
┌────────────────────────────────────────────────────────────────────────┐
│                      MAINNET PROMOTION GATEWAYS                        │
├─────────────┬─────────────┬─────────────┬─────────────┬────────────────┤
│  GATEWAY 1  │  GATEWAY 2  │  GATEWAY 3  │  GATEWAY 4  │   GATEWAY 5    │
│             │             │             │             │                │
│ Security    │ Invariant   │ Testnet     │ WASM Hash   │ Observability  │
│ Audit       │ Suite       │ Burn-In     │ Pinning &   │ & Monitoring   │
│ Sign-off    │ Formal      │ (14 Days)   │ Bytecode    │ Readiness      │
│             │ Proof       │             │ Reproducib. │                │
└─────────────┴─────────────┴─────────────┴─────────────┴────────────────┘
```

### Gateway 1: Independent Security Audit Sign-off
- **Requirement**: Full source code audit of `app/contract/contracts/quickex` by an independent, reputable blockchain security auditing firm.
- **Evidence**:
  - Published audit report with zero unaddressed `Critical` or `High` severity vulnerabilities.
  - Mitigations verified for any `Medium` severity findings.
  - The cryptographic hash (SHA-256) of the finalized audit report must be permanently linked in [security.md](./security.md).

### Gateway 2: Automated Invariant Verification Suite
- **Requirement**: Execution of the end-to-end automated test harness validating all ten financial and state machine invariants ([INVARIANTS.md](./INVARIANTS.md)):
  - **INV-01**: Conservation of Value under all multi-hop payment routing.
  - **INV-02 & INV-08**: Unauthorized withdrawals strictly rejected by `Address::require_auth()`.
  - **INV-03 & INV-10**: Overpayments prevented and fee ceiling strictly respected.
  - **INV-04**: Double-settlement race conditions impossible under concurrent execution.
  - **INV-05, INV-06, INV-07**: Expiration monotonicity, state machine transitions, and replay rejection via nonces.
- **Evidence**: Clean execution logs from contract unit, fuzz, benchmark, and upgrade test suites (`cargo test --all`, `fast-check` property tests).

### Gateway 3: Continuous Testnet Burn-In
- **Requirement**: Minimum 14 consecutive days of continuous, uninterrupted operation on Stellar Testnet without unhandled exceptions or state divergence.
- **Evidence**:
  - Minimum 10,000 synthetic test escrows created, funded, fulfilled, and refunded.
  - Stellar event ingestion stream (`StellarIngestionService`) running with zero ledger drift and cursor gap recovery verified.

### Gateway 4: WASM Hash Pinning & Reproducible Bytecode
- **Requirement**: Contract WASM bytecode must be reproducibly built from a tagged Git commit using the pinned toolchain specified in `app/contract/rust-toolchain.toml`.
- **Evidence**:
  - The compiled WASM hash must be checked against the on-chain installed contract code via Soroban RPC `getContractCode`.
  - The active WASM hash is registered in the QuickEx Contract Registry (`GET /contracts/registry`).

### Gateway 5: Observability & Operational Readiness
- **Requirement**: Production alerting rules and Prometheus dashboards operational:
  - Stellar Horizon latency < 500ms p95.
  - Soroban RPC ingestion cursor lag < 3 ledgers.
  - Sentry exception reporting armed with secret-redaction filters active.
  - On-call escalation path established for node partition or emergency freeze.

---

## 2. Governance Approvals & Multisig Protocol

To eliminate single points of failure, the Mainnet deployment of QuickEx utilizes a strict role-separated multi-signature governance model.

```
                   ┌────────────────────────────────────────┐
                   │        STELLAR MULTI-SIG ADMIN         │
                   │           (3-of-5 Threshold)           │
                   │   Held by Protocol Officers / HW Keys  │
                   └───────────────────┬────────────────────┘
                                       │
                      ┌────────────────┴────────────────┐
                      ▼                                 ▼
         ┌────────────────────────┐        ┌────────────────────────┐
         │     ADMINISTRATIVE     │        │       OPERATOR         │
         │      INVOCATIONS       │        │      INVOCATIONS       │
         ├────────────────────────┤        ├────────────────────────┤
         │ • WASM migration       │        │ • Operation pauses     │
         │ • Emergency Freeze     │        │ • Fee config updates   │
         │ • Admin rotation       │        │ • Routine maintenance  │
         │ • Fee collector rotate │        │                        │
         └────────────────────────┘        └────────────────────────┘
```

### 2.1 Multi-Signature Admin Account
- **Threshold**: 3-of-5 multi-signature account configuration.
- **Signers**: Designated core team members and protocol custodians using hardware security modules (Ledger/HSM).
- **Restrictions**: No automated backend server, CI/CD pipeline, or hot wallet may hold admin signing rights on Mainnet.

### 2.2 Role Separation
1. **Admin Role**:
   - Authorized to invoke contract upgrades (`migrate(admin, new_wasm_hash)`).
   - Authorized to trigger protocol emergency freeze (`activate_emergency_mode`).
   - Authorized to rotate the protocol fee destination account (`set_fee_recipient`).
2. **Operator Role**:
   - Authorized to perform routine parameter adjustments and granular entrypoint pauses (`set_pause_flags`).
   - Cannot migrate contract code or rotate admin authority.

### 2.3 Time-Locked Upgrade Staging
- All contract bytecode migrations must be announced via a public governance proposal with a minimum **48-hour timelock** before execution.
- This window gives merchants and liquidity providers adequate time to settle or withdraw active escrows if they choose not to adopt the upgrade.

---

## 3. Rollback Procedures & Kill-Switches

In the event of an exploit, smart contract defect, or critical chain reorg, QuickEx provides three concentric layers of defense:

### Layer 1: Dynamic Feature Flag Kill-Switches
- Operators can disable on-chain write operations instantaneously at the backend API layer without requiring on-chain transactions:
  - `mainnet.contract_writes = false`: Blocks all new `/transactions/compose` and `/stellar/soroban-preflight` calls.
  - `mainnet.refunds = false`: Halts new automated refund triggers.
  - `mainnet.dispute_actions = false`: Halts dispute escalation paths.
- Configurable via `app/backend/src/feature-flags` and environment rollback variables (`flags.js`).

### Layer 2: Contract Registry Rollback
- If a newly deployed contract version exhibits client integration defects, administrators execute:
  ```http
  POST /contracts/registry/rollback
  Authorization: Bearer <ADMIN_SCOPED_KEY>
  ```
- This shifts the active deployment record in `GET /contracts/registry` back to the previous verified stable contract ID, directing frontend and mobile clients to the safe version without requiring mobile app store releases.

### Layer 3: On-Chain Emergency Freeze
- In the event of a critical smart contract vulnerability, the Multi-Sig Admin invokes:
  ```rust
  QuickexContract::activate_emergency_mode(caller)
  ```
- **Semantics**:
  - Permanently and irreversibly freezes all deposits, withdrawals, and fee disbursements.
  - Preserves all locked escrow funds in place (`INV-01`, `INV-02`).
  - Safe extraction can only occur after deploying an audited migration contract via multi-sig governance.

---

## 4. Mainnet Deployment Runbook

The deployment tools enforce the [signed mainnet deployment gate](../app/contract/documentation/mainnet-deployment-gate.md) before sending mainnet transactions. The gate binds reviewer approvals to the release commit, reproducible WASM hash, testnet manifest, audit report, burn-in, invariant-suite result, and observability evidence. A security reviewer and a governance reviewer must sign with distinct trusted Ed25519 keys.

### Pre-Deployment Phase (T - 24h)
1. Verify all 5 Promotion Gateways have documented sign-offs.
2. Confirm `.secrets.baseline` and secret scanning CI checks pass without violations.
3. Validate multi-sig signer availability and verify hardware signer connectivity.
4. Execute dry-run deployment on Stellar Futurenet / Testnet using `ts-node scripts/soroban-deploy.ts`.

### Deployment Phase (T - 0)
1. **Bytecode Installation**: Install compiled contract WASM onto Stellar Mainnet via Soroban CLI.
2. **Contract Instantiation**: Initialize the contract instance specifying the Multi-Sig account as `admin`.
3. **Verify Constants**: Query `get_version()` and confirm initial pause flags are clean.
4. **Registry Publication**: Call `POST /contracts/registry/publish` with the new Mainnet contract ID and WASM hash.
5. **Sanity Verification**: Execute a live micro-transaction test verifying escrow creation, funding, and refund cycles.

### Post-Deployment Phase (T + 2h)
1. Verify `StellarIngestionService` event cursor starts streaming Mainnet ledger events.
2. Monitor Sentry and Prometheus error rates for 24 hours.
3. Enable `mainnet.contract_writes` feature flag after confirming stable telemetry.
