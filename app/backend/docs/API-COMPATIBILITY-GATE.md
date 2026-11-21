# API Compatibility Gate

## Purpose

The API Compatibility Gate prevents accidental breaking changes to the public
HTTP API surface. It compares the API exposed by the current build against a
checked-in baseline artifact and fails the build when an incompatible change is
detected.

The gate is intended to catch:

- Removed or renamed endpoints (paths and HTTP methods).
- Removed or renamed request/response fields.
- Changes to field types or required/optional status.
- Changes to enum values that are part of the public contract.
- Changes to authentication or authorization requirements on an endpoint.
- Changes to the error contract of an endpoint, including the error code and
  HTTP status returned for a rejected request (for example, a duplicate
  terminal escrow call).

Additive, backwards-compatible changes (new endpoints, new optional fields) are
allowed and do not fail the gate.

## Baseline Artifact

The baseline is a machine-readable description of the public API surface,
checked into the repository:

```
app/backend/api-baseline.json
```

The baseline is generated from the running application's OpenAPI schema. It is
the single source of truth for "what the API looked like at the last approved
release". Any change to the baseline must be reviewed as part of a pull request.

The gate produces a candidate artifact for the current build and diffs it
against the baseline. The diff is classified as:

- **Compatible** — additive changes only; the gate passes.
- **Breaking** — any incompatible change; the gate fails unless an explicit
  override is present.

## Configuration

The gate is configured through environment variables and a config file.

Environment variables:

| Variable | Description | Default |
| --- | --- | --- |
| `API_COMPAT_GATE_ENABLED` | Enable or disable the gate. | `true` |
| `API_COMPAT_BASELINE_PATH` | Path to the baseline artifact. | `app/backend/api-baseline.json` |
| `API_COMPAT_CANDIDATE_PATH` | Path where the candidate artifact is written. | `build/api-candidate.json` |
| `API_COMPAT_FAIL_ON_BREAKING` | Fail the build on breaking changes. | `true` |
| `API_COMPAT_OVERRIDE_TOKEN` | Token that authorizes an override. | unset |

Config file (optional), located at `app/backend/api-compat-gate.config.json`:

```json
{
  "enabled": true,
  "baselinePath": "app/backend/api-baseline.json",
  "candidatePath": "build/api-candidate.json",
  "failOnBreaking": true,
  "ignorePaths": [],
  "ignoreFields": []
}
```

`ignorePaths` and `ignoreFields` are escape hatches for endpoints or fields
that are intentionally excluded from the gate (for example, internal-only
endpoints). Prefer fixing the API over adding entries here.

## Migration

When you intentionally make a breaking change, you must migrate the baseline as
part of the same change:

1. Make the breaking API change in code.
2. Regenerate the candidate artifact by running the build (or the gate's
   generation command directly).
3. Review the diff between the candidate and the baseline. Confirm every
   breaking entry is intended.
4. Update the baseline artifact with the candidate:

   ```
   cp build/api-candidate.json app/backend/api-baseline.json
   ```

5. Commit the updated baseline together with the code change.
6. Document the breaking change in the changelog and, if applicable, the API
   versioning notes.

The baseline update is the record that the breaking change was reviewed and
approved. Do not update the baseline without a corresponding code change.

## Override Procedure

An override allows a build to pass despite a breaking change without updating
the baseline. Overrides are for exceptional cases only (for example, an
emergency rollback) and must be time-boxed.

To override:

1. Obtain the override token from the release owner. The token is provided via
   `API_COMPAT_OVERRIDE_TOKEN` and is never committed to the repository.
2. Set the token in the build environment:

   ```
   export API_COMPAT_OVERRIDE_TOKEN="<token>"
   ```

3. Run the build. The gate records the override, the detected breaking changes,
   and the operator identity in the build log.
4. File a follow-up issue to reconcile the baseline or revert the change.

Overrides are logged and audited. Repeated overrides for the same change are a
signal that the baseline should be migrated instead.

## Rollback Steps

If the gate fails unexpectedly or a bad baseline was merged:

1. Identify the offending commit (the code change or the baseline update).
2. Revert the commit:

   ```
   git revert <commit-sha>
   ```

3. If the baseline was corrupted, restore it from the last known-good revision:

   ```
   git checkout <last-good-sha> -- app/backend/api-baseline.json
   ```

4. Re-run the gate locally to confirm it passes:

   ```
   API_COMPAT_GATE_ENABLED=true <gate-command>
   ```

5. Push the revert and confirm CI is green before proceeding.

If a breaking change was released and must be undone, follow the standard
service rollback procedure in addition to reverting the baseline, so that the
deployed API and the baseline are consistent.

## Terminal Escrow Calls

Escrow release and refund are terminal transitions: once an escrow has been
released or refunded, it cannot transition again. The gate treats the error
contract for these calls as part of the public API surface.

- The first terminal call (release or refund) succeeds and moves the escrow to
  its terminal state.
- Any later terminal call — a repeated release, a repeated refund, or a call
  crossing terminal states (release after refund, refund after release) — must
  be rejected with a stable error code and HTTP status, and must not change
  balances.

Because retries after a client timeout can replay a terminal call, the
rejection response is part of the contract: changing its error code or status
is a breaking change and must go through the migration or override procedure
above. Automated coverage asserts that exactly one terminal transition succeeds
and that later calls return the same stable error with unchanged balances.