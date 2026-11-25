# Release Artifact Retention Policy

This policy defines how long CI-generated artifacts and reports are kept
before GitHub Actions deletes them. It is enforced by the `retention-days`
input on every `actions/upload-artifact` step in `.github/workflows/`.

## 1. Why a retention policy exists

Build artifacts and temporary reports accumulate storage and clutter the
Actions UI well past the point where anyone still needs them. Left
unconfigured, `actions/upload-artifact` falls back to the repository's
default retention (90 days), which is longer than most CI-only reports are
useful for but can also be shorter than release evidence needs to survive for
an audit.

The policy sets an explicit `retention-days` on every upload step instead of
relying on the implicit default, and distinguishes two classes of artifact so
each gets a window that actually matches its purpose.

## 2. Classes

| Class | Definition | Retention |
|---|---|---|
| **Ephemeral CI artifact** | Generated on a pull request or a plain branch push, consumed as same-run debugging context (coverage reports, visual-diff screenshots, a contract budget report). Not tied to anything that ships. | **7 days** |
| **Release evidence** | Generated on a release-tag push, a release-candidate validation run, or any workflow whose purpose is a go/no-go decision for something that ships. Needs to remain inspectable for the audit period after a release. | **90 days** |

A workflow that serves both purposes (the same job runs on PRs *and* feeds a
release decision) sets `retention-days` conditionally on `github.event_name`
rather than picking one window for both.

## 3. Current mapping

| Workflow | Artifact | Class | Retention |
|---|---|---|---|
| `backend.yml` | `backend-unit-coverage`, `backend-integration-coverage` | Ephemeral | 7 days |
| `frontend-ci.yml` | `visual-regression-diffs` | Ephemeral | 7 days |
| `contract.yml` | `quickex-contract-budget-report` | Ephemeral | 7 days |
| `ci.yml` | `release-quality-scorecard` | Ephemeral on PR, release evidence on a `main` push | 7 days (PR) / 90 days (push) |
| `rc-validate.yml` | `rc-validation-*` gate report, `k6-summary-*` | Release evidence | 90 days |
| `mobile-release.yml` | `maestro-report` | Release evidence (tag-triggered) | 90 days |

## 4. Adding a new upload step

Every new `actions/upload-artifact@v4` step must set `retention-days`
explicitly — do not rely on the repository default. Classify it using the
table in §2, add the mapping to §3, and if the workflow runs for both
ephemeral and release-triggered events, use the conditional-expression form
shown in `ci.yml`:

```yaml
retention-days: ${{ github.event_name == 'pull_request' && 7 || 90 }}
```

Related: [DATA-RETENTION-PRIVACY-POLICY.md](./DATA-RETENTION-PRIVACY-POLICY.md)
(product data, a different concern from CI artifacts).
