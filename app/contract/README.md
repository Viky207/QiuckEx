# QuickEx Privacy Contract

Soroban smart contract implementing X-Ray privacy features for QuickEx.

## Overview

This contract provides the foundational privacy and escrow capabilities for the QuickEx platform. It enables:

- **Privacy Controls**: Selective visibility of on-chain activities
- **Escrow Services**: Secure holding of assets during transactions
- **Audit Trails**: Maintainable history of privacy state changes

## Prerequisites

- Rust 1.70 or higher
- Soroban CLI (`cargo install soroban-cli`)
- wasm32-unknown-unknown target (`rustup target add wasm32-unknown-unknown`)

## Building

```bash
# Navigate to the contract directory
cd app/contract

# Build the contract for release (optimized)
cargo build --target wasm32-unknown-unknown --release

# Build with optimized settings
cargo build --target wasm32-unknown-unknown --profile release-with-logs
```

## Testing

```bash
# Run all tests
cargo test

# Run specific test
cargo test test_enable_and_check_privacy

# Run tests with output
cargo test -- --nocapture

# Run tests with coverage (requires cargo-tarpaulin)
cargo tarpaulin --ignore-tests
```

## Fuzz Testing

The escrow input validation surface (amount parsing, memo/TTL handling, and ZK
proof verification) is covered by a property-based fuzz suite built on
[`cargo-fuzz`](https://github.com/rust-fuzz/cargo-fuzz). Malformed input to the
proof verifier is especially dangerous, so these targets are run in CI.

### Setup

```bash
# Install the fuzz runner (one-time)
cargo install cargo-fuzz

# Fuzz targets live under app/contract/fuzz
cd app/contract
```

### Running locally

```bash
# Fuzz escrow creation inputs (amount, memo, TTL)
cargo fuzz run fuzz_escrow_create

# Fuzz the ZK proof verifier byte array
cargo fuzz run fuzz_proof_verify

# Bound a run to 60 seconds (matches CI)
cargo fuzz run fuzz_escrow_create -- -max_total_time=60
cargo fuzz run fuzz_proof_verify -- -max_total_time=60
```

Seed inputs live in `fuzz/corpus/<target>/` and include boundary cases such as
zero amount, `u64::MAX` amount, empty proof, and truncated proof bytes. Add new
edge cases there so they are picked up automatically on the next run.

### Reproducing a crash

When a target finds a crash, the offending input is written to
`fuzz/artifacts/<target>/`. Re-run it directly:

```bash
cargo fuzz run fuzz_proof_verify fuzz/artifacts/fuzz_proof_verify/crash-<hash>
```

Fix the underlying validation bug before closing the issue, then re-run the
target to confirm the crash no longer reproduces.

## Quality Checks

```bash
# Check code formatting
cargo fmt --all -- --check

# Run clippy linter
cargo clippy --all-targets --all-features -- -D warnings

# Run all quality checks (fmt + clippy + test)
cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test
```

## Deployment

### Local Network (for testing)

```bash
# Start local Soroban network
soroban dev

# Deploy contract to local network
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/quickex.wasm \
  --source default

# Initialize contract (if needed)
soroban contract invoke \
  --id <CONTRACT_ID> \
  --source default \
  -- \
  health_check
```

### Testnet Deployment

```bash
# Deploy to testnet
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/quickex.wasm \
  --source test \
  --network testnet

# Verify deployment
soroban contract invoke \
  --id <CONTRACT_ID> \
  --source test \
  --network testnet \
  -- \
  health_check
```

### Mainnet Deployment

Mainnet deployments must use the reviewed gate-enabled deploy script. See [the mainnet deployment gate](documentation/mainnet-deployment-gate.md) for required evidence and trusted reviewer keys.

```bash
./scripts/deploy.sh \
  --network mainnet \
  --source quickex-mainnet \
  --admin "$QUICKEX_MAINNET_ADMIN" \
  --wasm target/wasm32v1-none/release/quickex.wasm \
  --mainnet-gate /secure/release/mainnet-gate.json \
  --testnet-manifest /secure/release/testnet-deployment-manifest.json \
  --audit-report /secure/release/security-audit.pdf
```

## Contract Spec Export

Export the contract's method/argument spec, along with the current
contract and event schema versions, as a stable JSON artifact:

```bash
./scripts/export-contract-spec.sh
```

The artifact is written to `docs/contract-spec/contract-spec.json` and
includes `contract_version`, `event_schema_version`, and the full function
interface, so contributors and tooling can introspect available methods
without reading the Rust source. `scripts/test-contract-spec-export.sh`
verifies the export is stable across repeat builds and includes all
required fields.

## Development Workflow

1. Make changes to the contract code
2. Run quality checks: `cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings`
3. Run tests: `cargo test`
4. Build and test deployment locally: `soroban dev`
5. Create PR with changes

## Main Flows

### 1. Deployment & initialisation
1. Deploy the contract WASM.
2. Call `initialize(admin)` once to set the bootstrap admin.
3. For production, call `initialize_governance(caller, signers, threshold, timelock_secs)` to activate M-of-N governance before configuring funds or production parameters. Once enabled, privileged changes and upgrades require proposals; direct legacy admin calls are rejected.

### 2. Deposit → Withdraw (escrow)
1. **Deposit**: Call `deposit(token, amount, owner, salt)` or `deposit_with_commitment(from, token, amount, commitment)`. The owner/from must authorize the token transfer.
2. Store the returned commitment (or the one you provided) securely; it is required to withdraw.
3. **Withdraw**: Call `withdraw(_token, amount, _commitment, to, salt)` with `to` as the recipient. The commitment is recomputed from `to`, `amount`, and `salt`; it must match an existing pending escrow. `to` must authorize.

### 3. Privacy
- **Boolean**: `set_privacy(owner, enabled)` and `get_privacy(owner)` for on/off privacy.
- **Level-based**: `enable_privacy(account, level)`, `privacy_status(account)`, `privacy_history(account)` for numeric levels.

### 4. Admin
- Before multisig bootstrap, legacy admin entrypoints can pause, transfer admin, and upgrade.
- After bootstrap, use `propose_governance_action`, `approve_governance_proposal`, and `execute_governance_proposal` for privileged changes, signer rotation, and timelocked upgrades. Cancellation requires M-of-N cancellation votes.
- `activate_emergency_mode(caller)` remains an immediate, irreversible stop callable by the bootstrap admin or any active governance signer.
- `get_version()` – inspect the stored schema version (`0` means a legacy deployment with no version key yet).

See [governance and compatibility guarantees](docs/GOVERNANCE_AND_COMPATIBILITY.md) for stable error codes, signer rotation, upgrade cancellation, and CI resource budgets.

### 5. Read-only queries
- `get_commitment_state(commitment)` – escrow status (Pending/Spent/Expired).
- `verify_proof_view(amount, salt, owner)` – verify withdrawal params without submitting a tx.
- `get_escrow_details(commitment)` – full escrow entry.

---

## Contract Interface

The contract exposes the following functions:

### Storage Layout

The contract uses persistent storage with the following structure:

- `DataKey::Escrow(Bytes)` - Maps commitment hash to `EscrowEntry` containing token address, amount, owner, status, and creation timestamp
- `DataKey::EscrowCounter` - Tracks the number of escrows created
- `DataKey::Admin` - Stores the admin address
- `DataKey::Paused` - Stores the paused state of the contract
- `DataKey::PrivacyLevel(Address)` - Stores privacy level for each account
- `DataKey::PrivacyHistory(Address)` - Stores privacy history for each account

The `EscrowEntry` struct contains:
- `token: Address` - The token address
- `amount: i128` - The escrowed amount
- `owner: Address` - The owner of the escrow
- `status: EscrowStatus` - The status (Pending, Spent, Expired)
- `created_at: u64` - The ledger timestamp when created

Helper functions:
- `put_escrow(env: &Env, commitment: &Bytes, entry: &EscrowEntry)` - Store an escrow entry
- `get_escrow(env: &Env, commitment: &Bytes)` - Retrieve an escrow entry
- `has_escrow(env: &Env, commitment: &Bytes)` - Check if an escrow entry exists

### Privacy Management

- `enable_privacy(account: Address, level: u32)` - Enable privacy for an account
- `privacy_status(account: Address)` - Get privacy status for an account
- `privacy_history(account: Address)` - Get privacy change history

### Escrow

- `deposit(token: Address, amount: i128, owner: Address, salt: Bytes)` - Deposit funds and create an escrow entry
- `withdraw(to: Address, amount: i128, salt: Bytes)` - Withdraw funds by proving commitment ownership
- `create_escrow(from: Address, to: Address, amount: u64)` - Create escrow

### Amount Commitments (X-Ray Privacy Placeholder)

- `create_amount_commitment(owner: Address, amount: i128, salt: Bytes) -> Bytes` - Create a deterministic commitment hash
- `verify_amount_commitment(commitment: Bytes, owner: Address, amount: i128, salt: Bytes) -> bool` - Verify a commitment against claimed values

### X-Ray Proof Verification (testnet stub, issue #456)

- `verify_proof(commitment: BytesN<32>, proof: Bytes) -> bool` - Verify a versioned X-Ray proof. Version `0x01` is a SHA-256 hash-commitment opening (**not ZK**); Groth16 is reserved as `0x02`.
- `create_xray_commitment(amount: i128, blinding: BytesN<32>) -> BytesN<32>` - Reference commitment helper for client conformance.

See [docs/ZK-PROOF-SPEC.md](docs/ZK-PROOF-SPEC.md) for the byte-level format and test vector.

## Amount Commitments API

### Overview

The amount commitment functions provide a **placeholder** for X-Ray privacy shielded flows. These use KECCAK256-based deterministic commitments for optimal security.
