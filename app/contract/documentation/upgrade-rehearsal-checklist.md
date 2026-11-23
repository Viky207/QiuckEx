# Contract Upgrade Rehearsal Checklist

This checklist gives contributors a repeatable way to validate storage compatibility and version metadata **before** changing deployed contract state. Work through every step in order. Do not skip steps, and do not proceed past a **Stop Condition** until it is resolved and recorded.

> Scope: this checklist applies to any change that touches contract storage layout, storage keys, schema/version metadata, or the upgrade entrypoint. If you are unsure whether your change qualifies, treat it as if it does.

---

## 0. Before you start

- [ ] Confirm the current upgrade safety gate scripts exist and are the ones you will run:
  - `scripts/mainnet-gate.sh` — the mainnet upgrade safety gate.
  - `scripts/testnet-upgrade-rehearsal.sh` — the testnet upgrade rehearsal driver.
- [ ] Read the deployment gates section of [`soroban.md`](./soroban.md) so you understand which gate applies to your target network.
- [ ] Create a working branch and note the commit SHA you are rehearsing from (`git rev-parse HEAD`).
- [ ] Confirm you have **no** secrets, signing material, or personal data in your working tree or in any artifact you will commit. Rehearsal artifacts must contain only public, non-sensitive data.

**Stop Condition:** If either gate script is missing, renamed, or its behavior is unclear, stop and raise it with the maintainers before continuing.

---

## 1. Select prior state

You must rehearse the upgrade against a realistic *prior* deployed state, not a blank contract.

- [ ] Identify the prior release/tag or commit whose storage layout you are upgrading **from**. Record it.
- [ ] Capture the prior deployment's metadata so you can compare it later:
  - [ ] `get_deployment_metadata` — record the full output.
  - [ ] `get_schema_version` — record the value.
- [ ] If a prior rehearsal artifact exists under `docs/rehearsal-artifacts`, use it as the baseline instead of re-deriving prior state, and note which artifact you used.
- [ ] Store the captured prior-state metadata in a new file under `docs/rehearsal-artifacts/` (see [Required artifacts](#required-artifacts)).

**Stop Condition:** If you cannot identify or reproduce the prior state, stop. Do not rehearse against an unknown baseline.

---

## 2. Run the upgrade tests

Run the focused upgrade test suites and capture their output.

- [ ] Run the upgrade harness tests:

  ```sh
  cargo test upgrade_harness_
  ```

- [ ] Run the upgrade safety gate tests:

  ```sh
  cargo test upgrade_safety_gate_
  ```

- [ ] Save the full output of both commands to `docs/rehearsal-artifacts/` (see [Required artifacts](#required-artifacts)).

**Stop Condition:** If any test in either suite fails, stop. Do not proceed to metadata comparison until the failure is understood and fixed (or explicitly waived by a maintainer, with the waiver recorded in the artifact).

---

## 3. Run the network gates

Run the gate that matches your target network. Run both if you are rehearsing for both.

- [ ] Testnet rehearsal:

  ```sh
  scripts/testnet-upgrade-rehearsal.sh
  ```

- [ ] Mainnet safety gate (dry run / rehearsal context only — never against live mainnet state without maintainer sign-off):

  ```sh
  scripts/mainnet-gate.sh
  ```

- [ ] Capture the exit status and full output of each gate you run into `docs/rehearsal-artifacts/`.

**Stop Condition:** If either gate exits non-zero, stop. Record the failure, the gate output, and the commit SHA in the artifact, then escalate to maintainers.

---

## 4. Compare storage and version metadata

After the upgrade path has run, compare the post-upgrade metadata against the prior state captured in Step 1.

- [ ] Read post-upgrade `get_deployment_metadata` and `get_schema_version`.
- [ ] Compare against the prior-state values:
  - [ ] **Schema version** advanced as expected (and only as expected).
  - [ ] **Deployment metadata** differences are intentional and documented.
  - [ ] **Storage keys / layout** are backward compatible, or a deliberate migration is included and documented.
- [ ] Record the before/after comparison (a table or diff) in the artifact.

**Stop Condition:** If the schema version did not change when it should have, changed unexpectedly, or storage layout is incompatible without a documented migration, stop. Do not merge.

---

## 5. Preserve rollback evidence

Every rehearsal must leave behind enough evidence to roll back or to justify *not* rolling back.

- [ ] Confirm all artifacts from Steps 1–4 are saved under `docs/rehearsal-artifacts/`.
- [ ] Record the exact commands run, their exit codes, and the commit SHA(s) involved.
- [ ] Record the rollback plan: what prior state/version you would restore to, and how.
- [ ] Confirm no secrets, signing material, or personal data are present in any committed artifact.

**Stop Condition:** If rollback evidence is incomplete or contains sensitive data, stop and fix before committing.

---

## Required artifacts

Each rehearsal must produce, under `docs/rehearsal-artifacts/`:

| Artifact | Contents |
| --- | --- |
| Prior-state metadata | `get_deployment_metadata` and `get_schema_version` output from the prior release, plus the release/tag/commit it came from. |
| Upgrade test output | Full output and exit status of `cargo test upgrade_harness_` and `cargo test upgrade_safety_gate_`. |
| Gate output | Full output and exit status of `scripts/testnet-upgrade-rehearsal.sh` and/or `scripts/mainnet-gate.sh`. |
| Metadata comparison | Before/after comparison of `get_deployment_metadata` and `get_schema_version`, with intentional differences explained. |
| Rollback evidence | Commands run, exit codes, commit SHA(s), and the rollback plan. |

Name artifacts with the date and commit SHA (e.g. `2025-01-01-<sha>-prior-metadata.json`) so they are easy to find and correlate.

---

## Stop conditions (summary)

Stop and escalate to maintainers if **any** of the following is true:

- The gate scripts (`scripts/mainnet-gate.sh`, `scripts/testnet-upgrade-rehearsal.sh`) are missing or behave unexpectedly.
- Prior state cannot be identified or reproduced.
- Any `upgrade_harness_` or `upgrade_safety_gate_` test fails.
- Either network gate exits non-zero.
- `get_schema_version` or `get_deployment_metadata` differ from expectations without a documented, deliberate migration.
- Storage layout is incompatible and no migration is included.
- Rollback evidence is incomplete or contains secrets/signing material/personal data.

---

## Related documentation

- [`soroban.md`](./soroban.md) — deployment gates and network-specific upgrade requirements.
- `scripts/mainnet-gate.sh` — mainnet upgrade safety gate.
- `scripts/testnet-upgrade-rehearsal.sh` — testnet upgrade rehearsal driver.