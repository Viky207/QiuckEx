# CI token permissions

Every workflow in `.github/workflows/` follows one rule: **the workflow-wide
`GITHUB_TOKEN` has no scopes, and every job states the exact scopes it needs.**

```yaml
permissions: {}

jobs:
  example:
    runs-on: ubuntu-latest
    permissions:
      contents: read
```

This is a deliberate follow-up to the workflow-wide write tokens that used to
cover read-only validation jobs. A job-level `permissions` block *replaces* the
workflow default, so leaving the default empty prevents accidental inheritance
and makes each job's effective token reviewable in one place.

## Policy

| Job category | Allowed scopes | Examples |
|---|---|---|
| Static/deploy-placeholder jobs with no GitHub API calls | `{}` (no scopes) | `contract.yml/deploy`, `staging-preview.yml/guard`, `staging-preview.yml/teardown` |
| Build, test, lint, migration, smoke, audit, docs | `contents: read` | `backend.yml/build-and-test`, `contract.yml/test`, `ci.yml/docs-gate` |
| CodeQL analysis upload | `actions: read`, `contents: read`, `security-events: write` | `codeql-analysis.yml/analyze` |
| Dependency review PR comment | `contents: read`, `pull-requests: write` | `dependency-review.yml/dependency-review` |
| Dependabot auto-merge | `contents: write`, `pull-requests: write` | `dependabot-auto-merge.yml/auto-merge` |
| Secret-scan PR annotations | `contents: read`, `pull-requests: write` | `secret-scanning.yml/gitleaks` |
| Staging preview comment | `contents: read`, `pull-requests: write` | `staging-preview.yml/deploy` |
| GitHub Pages deploy | `pages: write`, `id-token: write` | `storybook.yml/deploy` |
| Label sync | `contents: read`, `issues: write` | `sync-labels.yml/sync` |

Publishing/deploy jobs that authenticate with a repository secret (for example
GHCR, EAS, Vercel, Sentry, or the production deploy token) still use
`contents: read` for the token managed by GitHub; their external credentials are
unchanged by this policy.

The exact expected map for every workflow and job is declared in
`scripts/check-workflow-permissions.js`. It is the single source of truth for
the CI gate.

## Changing a workflow

1. Keep `permissions: {}` at workflow level. Do not restore a workflow-wide
   `write` scope, even for a workflow with a single job.
2. Add a `permissions` block to every new job. Start with `contents: read` and
   add a scope only when an action or API call actually requires it.
3. If a new write scope is genuinely needed, update the expected map in
   `scripts/check-workflow-permissions.js` **in the same PR**, with the reason in
   the PR description. The checker fails on any undeclared scope or job.
4. Run locally before pushing:

   ```bash
   npm run check:workflow-permissions
   npm run test:workflow-permissions
   ```

The `Workflow Token Permissions` job in `ci.yml` runs both commands for every
push and pull request. It is dependency-free and offline, so it works on forks
without an install step or repository secrets.

## Failure cases covered

The checker's unit tests cover the boundary cases that matter for least
privilege:

- a workflow-wide write scope inherited by a read-only job;
- a job with no explicit permissions block;
- an unexpected write scope on a read-only job;
- a required write job that silently loses its write scope;
- an undeclared new job;
- permission-like text inside a shell script block scalar (ignored).

No token values, credentials, or secrets are logged by the checker.
