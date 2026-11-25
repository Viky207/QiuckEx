# QuickEx Governance

This is the entry point for QuickEx's published policies, standards, and architecture decision records — the
artefacts that constrain what contributors may change without an explicit, reviewable decision. It exists because
QuickEx handles money and custody: undocumented governance is indistinguishable from no governance.

Companion maps: [CAPABILITY-MAP.md](./CAPABILITY-MAP.md) (what is actually built),
[BACKEND-CLIENT-CONTRACT-MAP.md](./BACKEND-CLIENT-CONTRACT-MAP.md) (client ↔ backend contracts),
[INVARIANTS.md](./INVARIANTS.md) (financial and state-machine invariants),
[RUNTIME-CONFIG-MATRIX.md](./RUNTIME-CONFIG-MATRIX.md) (config drift).

---

## 1. Policies and standards

| Document | Covers | Machine-readable companion | Enforcing check |
|---|---|---|---|
| [policies/ASSET-LISTING-POLICY.md](./policies/ASSET-LISTING-POLICY.md) | Issuer eligibility, verification tiers, delisting, re-listing, listing evidence | [policies/data/asset-listing-policy.json](./policies/data/asset-listing-policy.json) | `--only assets` |
| [policies/DATA-RETENTION-PRIVACY-POLICY.md](./policies/DATA-RETENTION-PRIVACY-POLICY.md) | Retention windows, deletion requests, holds, subject rights, on-chain limits | [policies/data/retention-schedule.json](./policies/data/retention-schedule.json) | `--only retention` |
| [policies/ACCESSIBILITY-LOCALIZATION-STANDARD.md](./policies/ACCESSIBILITY-LOCALIZATION-STANDARD.md) | WCAG 2.2 AA target, per-surface a11y rules, i18n rules, testing, ratchet | [policies/data/a11y-i18n-baseline.json](./policies/data/a11y-i18n-baseline.json) | `--only a11y` |
| [adr/README.md](./adr/README.md) + `adr/NNNN-*.md` | Irreversible protocol and custody decisions | `adr/README.md` index | `--only adr` |
| [policies/DEPENDENCY-PROVENANCE-POLICY.md](./policies/DEPENDENCY-PROVENANCE-POLICY.md) | Where dependency code may come from, lockfile integrity, manifest ↔ lockfile agreement | `pnpm-lock.yaml` | `node scripts/deps/check.mjs --only provenance` / `--only lockfile` |
| [policies/DEPENDENCY-LICENSE-POLICY.md](./policies/DEPENDENCY-LICENSE-POLICY.md) | Permitted dependency licences, deny list, review list, recorded exceptions | [policies/data/dependency-license-policy.json](./policies/data/dependency-license-policy.json) | `node scripts/deps/check.mjs --only license` |
| [policies/RELEASE-ARTIFACT-RETENTION.md](./policies/RELEASE-ARTIFACT-RETENTION.md) | Ephemeral-vs-release artifact classes, retention windows by CI workflow | — | `retention-days` on each `.github/workflows/*.yml` `actions/upload-artifact` step |
| [security.md](./security.md), [../RELEASE_READINESS_CHECKLIST.md](../RELEASE_READINESS_CHECKLIST.md) | Secret handling, release gating | `.secrets.baseline` | CI secret scanning |

Machine-readable files are the **canonical** form; the prose documents explain them, and the backend mirrors them in
TypeScript with unit tests asserting equality (so prose, JSON, and code cannot drift apart silently).

## 2. Owners

| Area | Owner | Escalation |
|---|---|---|
| Listing/delisting decisions, issuer reviews | backend maintainers + contract maintainers | release readiness review |
| Retention sweeps, deletion requests, holds | privacy owner | release readiness review |
| Accessibility & localization baseline | frontend maintainers (web) + mobile maintainers (app) | release readiness review |
| ADR process and irreversible choices | contract maintainers + backend maintainers | architecture review |
| Invariants ([INVARIANTS.md](./INVARIANTS.md)) | contract maintainers | architecture review |

Owners are named by role, not by person, so the policy survives staffing changes. Escalation happens in the release
readiness review described in [../RELEASE_READINESS_CHECKLIST.md](../RELEASE_READINESS_CHECKLIST.md).

## 3. Review cadence

| Artefact | Cadence | Evidence |
|---|---|---|
| ADR set | every release train; mandatory before any mainnet-affecting release | release checklist entry |
| Asset listing policy | on every listing decision and at least once per release train | decision records + policy version bump |
| Retention schedule | quarterly, and whenever a new data store is added | sweep reports + schedule diff |
| Accessibility/localization baseline | every release train; the baseline must shrink over time | baseline diff in the PR |
| Invariants | whenever a contract change lands | contract test suite (`cargo test`) |

## 4. Architecture decision records

The ADR process, format contract, and lifecycle live in [adr/README.md](./adr/README.md). In short:

- `docs/adr/NNNN-kebab-title.md`, numbered sequentially, never renumbered or reused.
- Required sections in a fixed order: Status, Context, Decision, Consequences, Reversal Cost, Invariants Affected,
  References.
- `Accepted` ADRs are immutable except for the status line and link fixes; replace one by writing a new ADR and
  setting `Superseded by ADR-NNNN`.
- Every ADR appears in the index table with a matching title and status.


## 5. Machine checks

```bash
node scripts/governance/check.mjs                       # everything (adr, assets, retention, a11y, docs)
node scripts/governance/check.mjs --only assets --json  # single target, machine-readable report
node scripts/governance/check.mjs --only a11y --write-baseline   # refresh the a11y/i18n baseline
node --test scripts/governance/__tests__/               # tests for the gate itself
node scripts/deps/check.mjs                             # dependency provenance, lockfile, licenses
node --test scripts/deps/__tests__/deps.test.mjs        # tests for the dependency gate
```

A second, non-governance gate keeps the published API documentation in step with the code:

```bash
node scripts/docs-check/check.mjs                     # OpenAPI, contract, and mobile docs
node scripts/docs-check/check.mjs --only contract     # single target
node --test scripts/docs-check/__tests__/docs.test.mjs  # tests for the gate itself
```

| Target | Enforces |
|---|---|
| `openapi` | the document is valid 3.x, every operation declares responses, a tag, and a description, every tag used is declared, every `$ref` resolves, no schema referenced but undeclared, no unused schema |
| `contract` | every `@Controller` is documented in the OpenAPI document or the contract map, and the documented "no global route prefix" claim still matches `main.ts` |
| `mobile` | every `EXPO_PUBLIC_*` variable the app reads is documented, and the API URL default is stated |

It reads the backend routes as text and never starts the server, so it runs on a fresh
clone before `pnpm install`. Adding a controller without documenting it becomes a CI
failure rather than a 404 someone finds in production. See
[`../scripts/docs-check/README.md`](../scripts/docs-check/README.md).

The gate has **no dependencies** and never executes repository code, so it runs on a fresh clone and in CI before
`pnpm install`. It runs in [../.github/workflows/ci.yml](../.github/workflows/ci.yml) and must pass before merge.

| Target | Enforces |
|---|---|
| `adr` | file naming/numbering, required sections and their order, status vocabulary, index ↔ file agreement, supersede links |
| `assets` | policy JSON shape, tier coverage for every seeded asset, trigger vocabulary, mainnet-gating declaration, doc ↔ JSON ↔ backend-mirror agreement |
| `retention` | schedule shape, SLA coherence, unique categories, method vocabulary, hold justification, PII classification, doc ↔ JSON ↔ mirror agreement |
| `a11y` | both catalogs parse, declared switcher locales have catalogs, key parity against the baseline, the standard's required sections |
| `docs` | this hub's structure and the cross-links from each policy back here |

A second, non-governance gate keeps the local development fixtures honest:

```bash
node scripts/local-dev/check-seed.mjs                    # seed matches the migrations, holds no signing material
node --test scripts/local-dev/__tests__/seed.test.mjs    # tests for the seed check
bash -n scripts/local-dev/bootstrap.sh                   # the bootstrap script parses
```

| Check | Enforces |
|---|---|
| `schema` | every table and column the seed names is created by a migration (including later `ALTER TABLE` additions) |
| `idempotency` | every insert carries an `ON CONFLICT` clause, so re-running the bootstrap cannot duplicate rows |
| `secrets` | no Stellar secret key, mnemonic, PEM private key block, 64-hex key, or JWT in a fixture |
| `publicKeys` | every Stellar key in a fixture is a syntactically valid public key |
| `localGuard` | the seed aborts unless `current_database()` is local, and runs in an explicit transaction |

See [../scripts/local-dev/README.md](../scripts/local-dev/README.md).

## 6. Waivers

A failed check may be waived only by adding an explicit, time-boxed entry to the relevant baseline file:

```json
{ "id": "<check>.<what>", "surface": "frontend", "reason": "why", "owner": "role", "expires": "release train" }
```

Waivers are reviewed in the release readiness review; an expired waiver is a defect. Waivers are never granted for
missing account-funds protections, self-custody violations, or invariant regressions — those are release blockers.

## 7. Adding a policy

1. Write the policy with the required sections (target/scope, states or categories, requirements, authorization,
   observability, configuration, rollout/rollback, references) — the gate checks that list.
2. Add the machine-readable companion under `docs/policies/data/`, then add the mirror constant in the owning backend
   module plus a unit test asserting the JSON and the constant are equal.
3. Add a row to [§1](#1-policies-and-standards), a target to the owning gate (`scripts/governance/check.mjs` for
   governance artefacts, `scripts/deps/check.mjs` for dependency policy), and tests under that gate's
   `__tests__/` directory.
4. Update [CAPABILITY-MAP.md](./CAPABILITY-MAP.md) with the new status (only the four defined status terms), the
   feature-flag table if the behaviour is gated, and [BACKEND-CLIENT-CONTRACT-MAP.md](./BACKEND-CLIENT-CONTRACT-MAP.md)
   if a client-visible route changed.
5. Annotate the release procedure in [../RELEASE_READINESS_CHECKLIST.md](../RELEASE_READINESS_CHECKLIST.md) if the
   policy adds an operational step.