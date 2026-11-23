# Governance gate

Dependency-free, offline validation of QuickEx's published governance artefacts (issues #306–#309).
It never executes repository code: documents are parsed as text and JSON is parsed, not evaluated.

```bash
node scripts/governance/check.mjs                      # all targets
node scripts/governance/check.mjs --only adr           # adr | assets | retention | a11y | docs | release | previews | branch-protection
node scripts/governance/check.mjs --json               # machine-readable report for CI
node scripts/governance/check.mjs --only a11y --write-baseline
node --test scripts/governance/__tests__/              # tests for the gate itself
```

Exit codes: `0` clean, `1` errors, `2` usage error.

## What each target enforces

| Target | Reads | Enforces |
|---|---|---|
| `adr` | `docs/adr/*.md`, `docs/adr/README.md` | filename/numbering sequence, required sections and order, status vocabulary, index ↔ file agreement (title + status), supersede links resolve |
| `assets` | `docs/policies/ASSET-LISTING-POLICY.md`, `docs/policies/data/asset-listing-policy.json`, `app/backend/src/asset-listing/asset-listing.policy.ts`, the `verified_assets` seed migration | policy shape (transitions, tiers, evidence ages, triggers, error codes), every seeded asset has a tier, mainnet gating declared, doc ↔ JSON ↔ backend mirror agreement |
| `retention` | `docs/policies/DATA-RETENTION-PRIVACY-POLICY.md`, `docs/policies/data/retention-schedule.json`, `app/backend/src/privacy/retention/retention-schedule.ts` | schedule shape (SLA coherence, unique categories, method vocabulary, hold justification, PII classification), every category/hold/error code documented, mirror agreement |
| `a11y` | `docs/policies/ACCESSIBILITY-LOCALIZATION-STANDARD.md`, both `src/lib/i18n.ts` catalogs + locale switchers, `docs/policies/data/a11y-i18n-baseline.json` | standard sections present, switcher locales have catalogs, key parity against the baseline (new gaps fail), undiscoverable catalogs warned |
| `docs` | `docs/GOVERNANCE.md`, the three policy docs | governance hub structure and back-links |

## Layout

```
scripts/governance/
├── check.mjs        # CLI entry point
├── lib/
│   ├── shared.mjs   # paths, markdown section/mention helpers
│   ├── adr.mjs      # ADR parsing + index validation
│   ├── assets.mjs   # asset listing policy validation + evaluation (mirrors the backend engine)
│   ├── retention.mjs# retention schedule validation + sweep planning (mirrors the backend service)
│   └── i18n.mjs     # i18next catalog extraction, parity, baseline handling
├── __tests__/       # node:test suites (zero dependencies)
└── README.md        # this file
```

## Release and repository controls

These targets guard the release pipeline and repository settings. They are read-only: nothing here mutates
repository settings, deploys, or deletes infrastructure. None of them log secrets, signing material, or
unnecessary personal data.

| Target | Reads | Enforces |
|---|---|---|
| `release` | `docs/policies/RELEASE-SUPPLY-CHAIN-POLICY.md`, `docs/policies/data/release-supply-chain.json`, the release/deploy workflows | release image digests are signed and the deploy gate verifies signature + source provenance; unsigned or mismatched digests are rejected; post-deploy health-check failures trigger a bounded rollback of the failed deployment only, recording old/new digests and failing loudly if rollback verification fails |
| `previews` | `docs/policies/RELEASE-SUPPLY-CHAIN-POLICY.md`, `docs/policies/data/release-supply-chain.json`, the scheduled preview-cleanup workflow | expired previews are discovered on a schedule and only resources carrying the expected preview ownership metadata are deleted; active previews are preserved; cleanup is idempotent and records deleted resource identifiers (never secrets) |
| `branch-protection` | `docs/policies/data/branch-protection-policy.json`, the audit workflow | main-branch protection is compared against the checked-in policy; missing rules are reported with actionable names; the audit never changes repository settings |

### Deployment gate and rollback

The deploy gate verifies the signature and source provenance of the release image digest before promotion.
A rejection (unsigned image, mismatched digest, or failed provenance check) fails the workflow and the reason
is written to the workflow summary. When post-deploy health checks fail, the rollback path restores the prior
healthy revision for the failed deployment slot only, records the old and new digests in the summary, and
fails loudly if the rollback itself cannot be verified.

### Stale preview cleanup

A scheduled job discovers preview environments past their expiry and deletes only resources whose ownership
metadata matches the expected preview marker. Active previews are left untouched, repeated runs are
idempotent, and deleted resource identifiers are recorded in the workflow summary without secrets.

### Branch protection audit

A read-only audit compares main-branch protection settings with `docs/policies/data/branch-protection-policy.json`.
Missing or drifted rules are reported by name with a suggested fix; the audit never modifies repository
settings automatically.

See `docs/policies/RELEASE-SUPPLY-CHAIN-POLICY.md` for the full policy.

## Baseline discipline

`docs/policies/data/a11y-i18n-baseline.json` records known gaps (missing locale keys, unwired a11y lint, missing
axe tests). Regenerate it with `--write-baseline`; the diff is reviewed like code and every new entry needs a
justification in the PR description. Same ratchet discipline as `.secrets.baseline` (see `docs/security.md`).

## Adding a target

1. Add a `check<Name>(root)` function in `lib/` returning `{errors, warnings}`.
2. Wire it into `runCheck()` in `check.mjs` and add the name to `VALID_TARGETS`.
3. Add tests under `__tests__/` covering the happy path and one violation per rule.
4. Document the target in `docs/GOVERNANCE.md` (§5) and in the policy it guards.
