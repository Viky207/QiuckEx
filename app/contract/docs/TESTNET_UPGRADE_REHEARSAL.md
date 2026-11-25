# Testnet Upgrade Rehearsal

This document describes the repeatable QuickEx **testnet upgrade rehearsal** flow added for issue #570.

## What the rehearsal covers

The rehearsal is split into two layers:

1. **Local upgrade simulation and invariant validation** using the existing Rust harness in `contracts/quickex/src/upgrade_test.rs`
2. **Testnet operator rehearsal** using `scripts/testnet-upgrade-rehearsal.sh`, which records pre/post metadata and exports backend-consumable artifacts.

The local harness already covers the golden-state migration path and upgrade safety checks:

```bash
cargo test -p quickex upgrade_harness_ -- --nocapture
cargo test -p quickex upgrade_safety_gate_ -- --nocapture
```

## Running a rehearsal from CI (issue #564)

A manual, testnet-only workflow — `.github/workflows/testnet-rehearsal.yml` —
wraps `scripts/testnet-upgrade-rehearsal.sh` so a rehearsal can be triggered
from the Actions tab (`workflow_dispatch`) without being tied to an ordinary
push, pull request, or release event.

It requires two inputs: `contract_id` (the deployed contract to rehearse
against) and `confirm_testnet`, which the operator must type as exactly
`testnet`. The job's network is hardcoded to `testnet` in the workflow
itself — there is no input that can route it to mainnet, and the first step
fails immediately if `confirm_testnet` doesn't match before any other step
(including any write operation) runs.

The job records the rehearsal's outcome, the resulting
`rehearsal-artifact.json` (contract ID, target schema version, before/after
metadata, health check result), and the raw `stellar contract invoke` log to
the run's job summary and as an uploaded artifact (30-day retention). Note:
the Stellar CLI's `contract invoke` output is the function's return value,
not a dedicated transaction hash per call unless the CLI is run with `-v` —
capturing a tx hash for every invocation would require changing
`scripts/testnet-upgrade-rehearsal.sh` itself, which this workflow does not
do; the raw log is preserved so an operator can still locate each submitted
transaction.
