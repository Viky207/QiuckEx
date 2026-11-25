# Soroban Contract Developer Guide

This document is the single source of truth for building, testing, and deploying the QuickEx Soroban contract.

## Prerequisites

Install the following before you start:

- Rust 1.70+
- `soroban-cli`
- WASM target for Rust (`wasm32-unknown-unknown`)

```bash
# Install Rust (if not installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add WASM build target
rustup target add wasm32-unknown-unknown

# Install Soroban CLI
cargo install soroban-cli
```

Verify tools:

```bash
rustc --version
cargo --version
soroban --version
```

## Setup

From the repository root:

```bash
cd app/contract
```

(Optional, recommended) use Rust stable:

```bash
rustup default stable
```

## Build

Use standard build commands below.

```bash
# Debug build
cargo build

# Release build for Soroban WASM
cargo build --target wasm32-unknown-unknown --release

# Alternative profile used in this repo
cargo build --target wasm32-unknown-unknown --profile release-with-logs
```

Expected contract artifact path:

```text
target/wasm32-unknown-unknown/release/quickex.wasm
```

## Test

Run all tests:

```bash
cargo test
```

Run a specific test:

```bash
cargo test test_enable_and_check_privacy
```

Run tests with output:

```bash
cargo test -- --nocapture
```

## Required Verification Evidence

To confirm the documented setup works, contributors **must attach a screenshot** of a successful test run in their PR.

Minimum acceptable evidence:

- Terminal screenshot showing command: `cargo test`
- Output indicating tests passed (e.g. `test result: ok`)
- Timestamp visible in terminal/shell prompt if possible

## Deployment

Before any testnet or mainnet release, complete the checklist in [deployment-checklist.md](deployment-checklist.md).
For the repeatable operator flow and registry schema, use [deployment-playbook.md](deployment-playbook.md).
Use [environment-registry.toml](environment-registry.toml) as the canonical deployed address/hash registry.

### 1) Local network deployment

```bash
# In one terminal: start local Soroban network
soroban dev
```

In another terminal:

```bash
cd app/contract

stellar contract deploy \
  --wasm target/wasm32v1-none/release/quickex.wasm \
  --source default
```

Optionally verify with a read/invoke call:

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source default \
  -- \
  health_check
```

### 2) Testnet deployment

Use the same release artifact and operator order that passed the deployment checklist.
Record the result in [environment-registry.toml](environment-registry.toml).

```bash
cd app/contract

stellar contract deploy \
  --wasm target/wasm32v1-none/release/quickex.wasm \
  --source test \
  --network testnet
```

Verify:

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source test \
  --network testnet \
  -- \
  health_check
```

Recommended post-deploy validation:

1. Call `get_deployment_metadata` and confirm the returned contract ID, schema version, and wasm hash are correct.
2. Run one known event-emitting action and confirm the event payload still matches [docs/events-schema.md](../docs/events-schema.md).
3. Record the contract ID and network in the PR.
4. Update the environment registry with the contract ID, wasm hash, admin address, and init params.

### 3) Mainnet deployment

Mainnet deployment must repeat the validated testnet flow with the mainnet source key and network.
Mainnet promotion also requires the registry entry to be reviewed and approved. Use the gate-enabled deploy script; a raw mainnet CLI deploy bypasses required evidence verification and is not an approved deployment path.

```bash
cd app/contract

./scripts/deploy.sh \
  --network mainnet \
  --source quickex-mainnet \
  --admin "$QUICKEX_MAINNET_ADMIN" \
  --wasm target/wasm32v1-none/release/quickex.wasm \
  --mainnet-gate /secure/release/mainnet-gate.json \
  --testnet-manifest /secure/release/testnet-deployment-manifest.json \
  --audit-report /secure/release/security-audit.pdf
```

> Caution: Mainnet deployment is irreversible and should only be done after review and testnet validation.

## Deployment gates

The following checks are required before a deploy PR can be merged:

- [ ] Benchmarks are green: `cargo test bench_ -- --nocapture`
- [ ] Upgrade harness is green: `cargo test upgrade_harness_ -- --nocapture`
- [ ] Event schema is locked: `cargo test test_event_schema_catalog_locks_canonical_topics_and_payloads`
- [ ] Governance settings are documented: threshold keys and pause policy
- [ ] Post-deploy validation is defined: metadata view and event smoke test
- [ ] Environment registry is updated for every affected network

### Upgrade safety gate

Any change that touches deployed contract state (storage keys, value layouts, schema/version metadata, or initialization) must pass the upgrade safety gate before merge. Run it from `app/contract`:

```bash
# Upgrade harness: prior-state selection, migration, and rollback coverage
cargo test upgrade_harness_ -- --nocapture

# Storage/version metadata comparison and boundary cases
cargo test upgrade_ -- --nocapture

# Full suite (includes the gates above)
cargo test
```

The gate fails the PR when any of the following hold:

- A storage key or value layout changes without a migration path.
- The schema version is not bumped for a layout change, or is bumped without a migration.
- `get_deployment_metadata` no longer reports the expected contract ID, schema version, or wasm hash.
- The upgrade harness cannot select prior state or cannot restore it after rollback.

### Upgrade rehearsal checklist

Before changing deployed contract state, rehearse the upgrade using [upgrade-rehearsal-checklist.md](upgrade-rehearsal-checklist.md). The checklist is the contributor-facing companion to the upgrade safety gate above and covers:

1. **Select prior state** — capture the current deployed contract ID, wasm hash, schema version, and a storage snapshot from the network being upgraded.
2. **Run upgrade tests** — execute the upgrade harness against the selected prior state, including the failure/boundary case (missing migration, version mismatch, rollback).
3. **Compare storage/version metadata** — diff pre- and post-upgrade `get_deployment_metadata` output and storage entries; every difference must be intentional and documented.
4. **Preserve rollback evidence** — attach the pre-upgrade snapshot, the rollback command, and the post-rollback metadata comparison to the PR.

Required artifacts for an upgrade PR:

- [ ] Prior-state snapshot (contract ID, wasm hash, schema version, storage dump)
- [ ] Upgrade harness output showing the migration and boundary case passing
- [ ] Pre/post `get_deployment_metadata` comparison
- [ ] Rollback evidence: command used and post-rollback metadata comparison
- [ ] Updated [environment-registry.toml](environment-registry.toml) entry for every affected network

Stop conditions — do not proceed with the upgrade if any apply:

- Prior state cannot be reproduced or the snapshot does not match the deployed wasm hash.
- The upgrade harness fails, or the boundary/failure case is skipped.
- Storage or version metadata differs from the documented expectation.
- Rollback cannot be demonstrated or its evidence is missing.
- The environment registry is not updated for an affected network.
=======

## Contract error codes for client integrators

Clients must distinguish **retryable** failures (transient network, timeout, or internal conditions) from **stable contract rejections** (validation, authorization, state, replay, and stealth errors). A retryable failure may succeed if the same request is retried with backoff; a contract rejection will deterministically fail again with the same input and must be surfaced to the user instead of retried.

The table below is sourced from the contract ABI/error definitions and cross-checked against `QuickexErrorCode` in `app/mobile/utils/contract-error-mapper.ts`. Every code emitted by the contract is listed; the `Retryable` column is explicit for each row.

| Code | Name | Category | Retryable | User-facing interpretation | Recommended client action |
| --- | --- | --- | --- | --- | --- |
| 100 | `Unauthorized` | Auth | No | You are not authorized to perform this action. | Do not retry. Re-authenticate or ask the account owner for permission. |
| 101 | `NotInitialized` | State | No | The contract is not ready yet. | Do not retry blindly. Verify the contract is initialized/deployed correctly and report to operators. |
| 102 | `AlreadyInitialized` | State | No | The contract has already been set up. | Do not retry. Treat as a configuration error and report to operators. |
| 200 | `InvalidAmount` | Validation | No | The amount is not valid. | Do not retry. Prompt the user to enter a valid amount. |
| 201 | `InvalidRecipient` | Validation | No | The recipient address is not valid. | Do not retry. Ask the user to correct the recipient. |
| 202 | `InvalidAsset` | Validation | No | The asset is not supported. | Do not retry. Ask the user to choose a supported asset. |
| 300 | `InsufficientBalance` | Validation | No | You do not have enough funds for this operation. | Do not retry. Show the balance and let the user adjust the amount. |
| 301 | `InvalidSignature` | Auth | No | The signature could not be verified. | Do not retry. Re-sign the request or re-authenticate. |
| 302 | `Expired` | Validation | No | This request has expired. | Do not retry the same request. Build a fresh request with a new deadline. |
| 303 | `NotFound` | State | No | The requested record does not exist. | Do not retry. Refresh local state and confirm the identifier. |
| 304 | `AlreadyExists` | State | No | This record already exists. | Do not retry. Treat as an idempotency conflict and reconcile state. |
| 305 | `InvalidState` | State | No | The operation is not allowed in the current state. | Do not retry. Refresh state and guide the user to a valid flow. |
| 306 | `Paused` | State | No | The contract is temporarily paused. | Do not retry immediately. Inform the user and retry only after operators resume the contract. |
| 307 | `InvalidFee` | Validation | No | The fee value is not valid. | Do not retry. Correct the fee input. |
| 308 | `InvalidDeadline` | Validation | No | The deadline is not valid. | Do not retry. Correct the deadline and resubmit. |
| 309 | `InvalidNonce` | Replay | No | This request was already used or is out of order. | Do not retry the same nonce. Generate a new nonce and resubmit. |
| 310 | `ReplayDetected` | Replay | No | This request has already been processed. | Do not retry. Treat as a duplicate and reconcile with the original result. |
| 311 | `InvalidThreshold` | Validation | No | The approval threshold is not valid. | Do not retry. Correct the threshold configuration. |
| 312 | `InvalidOwner` | Validation | No | The owner address is not valid. | Do not retry. Correct the owner address. |
| 313 | `InvalidAdmin` | Validation | No | The admin address is not valid. | Do not retry. Correct the admin address. |
| 314 | `InvalidToken` | Validation | No | The token is not valid. | Do not retry. Ask the user to select a valid token. |
| 315 | `InvalidMemo` | Validation | No | The memo is not valid. | Do not retry. Correct the memo and resubmit. |
| 316 | `InvalidMetadata` | Validation | No | The metadata is not valid. | Do not retry. Correct the metadata payload. |
| 317 | `InvalidVersion` | Validation | No | The version is not supported. | Do not retry. Upgrade the client to a supported version. |
| 318 | `InvalidOperation` | Validation | No | The operation is not supported. | Do not retry. Use a supported operation. |
| 319 | `InvalidParameter` | Validation | No | A parameter is not valid. | Do not retry. Correct the input and resubmit. |
| 320 | `InvalidStealthAddress` | Stealth | No | The stealth address is not valid. | Do not retry. Ask the user to provide a valid stealth address. |
| 321 | `StealthAddressAlreadyUsed` | Stealth | No | This stealth address has already been used. | Do not retry. Generate a new stealth address. |
| 400 | `InvalidProof` | Validation | No | The proof could not be verified. | Do not retry. Recompute the proof and resubmit. |
| 401 | `ProofExpired` | Validation | No | The proof has expired. | Do not retry the same proof. Generate a fresh proof. |
| 402 | `InvalidCommitment` | Validation | No | The commitment is not valid. | Do not retry. Recompute the commitment and resubmit. |
| 500 | `InternalError` | Internal | Yes | Something went wrong on our side. | Retry with exponential backoff and a bounded attempt count; if it persists, report to operators. |
| 501 | `NotSupported` | Validation | No | This feature is not supported. | Do not retry. Hide or disable the unsupported feature. |
| 900 | `NetworkError` | Network | Yes | A network problem interrupted the request. | Retry with exponential backoff; verify connectivity before resubmitting. |
| 901 | `RegistryError` | Network | Yes | A registry lookup failed. | Retry with backoff; if it persists, report to operators. |

Retry guidance summary:

- **Retryable:** network/timeout failures and transient internal or registry conditions (`500`, `900`, `901`). Retry with exponential backoff and a bounded attempt count.
- **Non-retryable:** all stable contract rejections — validation, auth, state, replay, and stealth codes. Surface the user-facing interpretation and let the user correct the input; do not retry automatically.

This table is validated by `node scripts/docs-check/check.mjs --only contract`, which checks it against the contract ABI and the mobile `QuickexErrorCode` mapper. Update all three together when adding or changing an error code (see issue #573).

## Recommended local quality checks

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

Or in one line:

```bash
cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test
```

## Troubleshooting

- `target not found: wasm32v1-none`
  - Ensure your Stellar CLI toolchain and build target are installed for Soroban contracts.
- `stellar: command not found`
  - Ensure Stellar CLI is installed and on `PATH`.
- Failing tests after dependency changes
  - Run `cargo clean && cargo test`

## Pull Request checklist (for this doc)

- [ ] `app/contract/documentation/soroban.md` exists
- [ ] Steps for Prerequisites, Setup, Build, Test, Deploy are present and ordered
- [ ] Markdown formatting is clean and readable
- [ ] PR includes screenshot of successful `cargo test`
- [ ] Deploy checklist is linked and used for release-related changes
