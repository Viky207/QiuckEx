# Verified-Asset Onboarding Guide for Maintainers

> Issue: #572 — Verified-asset onboarding guide for maintainers
>
> Related documents:
> - [docs/GOVERNANCE.md](GOVERNANCE.md)
> - [docs/policies/ASSET-LISTING-POLICY.md](policies/ASSET-LISTING-POLICY.md)
>
> Source of truth for the constants referenced below:
> `app/backend/src/asset-listing/asset-listing.policy.ts`
> (`ASSET_LISTING_EVIDENCE`, `ASSET_LISTING_TRANSITIONS`, `ASSET_LISTING_TRIGGERS`,
> `ASSET_LISTING_ERROR_HTTP`, `ASSET_LISTING_FEATURE_FLAGS`,
> `ASSET_LISTING_COOLING_OFF_DAYS_BEFORE_RELIST`,
> `ASSET_LISTING_MIN_ISSUER_ACCOUNT_AGE_DAYS`) and the admin controller routes
> `GET /admin/asset-listing/registry`, `GET /admin/asset-listing/decisions`,
> `POST /admin/asset-listing/decisions`.

This guide turns the asset listing policy into a repeatable operator workflow. It
covers the evidence an issuer must supply, who signs off, how the registry is
updated, how caches are invalidated, how delisting and rollback work, and what
audit trail is produced. Every step must be evidenced before a decision is
recorded.

---

## 1. Required issuer proof

Evidence is tiered. Each tier requires a specific set of evidence kinds, and each
evidence item has an expiry requirement. Evidence kinds are defined in
`ASSET_LISTING_EVIDENCE`; the required set per tier is enforced by the policy
module. Do not record a decision until every required evidence item for the
target tier is present, current, and unexpired.

| Evidence kind | What it proves | Expiry requirement |
| --- | --- | --- |
| `toml_document` | The issuer's `stellar.toml` is published, reachable, and matches the asset code and issuer account. | Must be re-fetched and re-verified at review time; stale documents are rejected. |
| `attestation_of_reserve` | Backing/reserve attestation for the asset. | Must be current at review time; expired attestations block listing. |
| `issuer_identity` | The legal/operational identity of the issuer. | Must be current at review time; expired identity evidence blocks listing. |
| `sanctions_screen` | The issuer and controlling parties have been screened. | Must be current at review time; expired screens block listing. |
| `security_review` | Security review of the issuer integration and asset configuration. | Must be current at review time; expired reviews block listing. |

Additional issuer-account gate:

- The issuer account must be at least
  `ASSET_LISTING_MIN_ISSUER_ACCOUNT_AGE_DAYS` days old. Accounts younger than
  this minimum are rejected regardless of other evidence.

Operator checklist for this step:

1. Collect each required evidence kind for the requested tier.
2. Confirm each item is unexpired and matches the asset code and issuer account.
3. Record the evidence reference (`evidenceRef`) for each item so it can be
   stored in `asset_listing_evidence`.
4. If any required evidence is missing or expired, stop and return the
   appropriate error (see §6) — do not record a decision.

---

## 2. Review ownership

Decisions are owned by named reviewers; no single person may both prepare and
approve a decision.

| Decision | Approver | Notes |
| --- | --- | --- |
| List (verify) | Asset listing reviewer on the governance roster | Requires complete, unexpired evidence per §1. |
| Suspend | Asset listing reviewer on the governance roster | Used for temporary risk; see §5 for max suspension window. |
| Delist | Governance sign-off (per [docs/GOVERNANCE.md](GOVERNANCE.md)) | Requires documented trigger and evidence. |

Access and feature-flag sign-off:

- The operator must hold the admin scope required by the admin controller routes
  (`GET /admin/asset-listing/registry`, `GET`/`POST /admin/asset-listing/decisions`).
  Requests without the required admin scope are rejected.
- The `assets.listing_decisions` feature flag (see
  `ASSET_LISTING_FEATURE_FLAGS`) must be enabled and signed off before decisions
  can be recorded. If the flag is disabled, decision writes are refused — do not
  attempt to bypass it.

Operator checklist for this step:

1. Confirm the reviewer is on the governance roster and is not the preparer.
2. Confirm the operator session holds the required admin scope.
3. Confirm `assets.listing_decisions` is enabled and the sign-off is recorded.
4. Record the reviewer identity in the decision payload.

---

## 3. Registry update path

All registry changes flow through the admin decisions endpoint. There is no
out-of-band path to mutate the registry.

Endpoints:

- `GET /admin/asset-listing/registry` — read the current verified-asset registry.
- `GET /admin/asset-listing/decisions` — read the decision history.
- `POST /admin/asset-listing/decisions` — record a new decision and apply it.

`POST /admin/asset-listing/decisions` requirements:

- **`Idempotency-Key` header is required.** Retries with the same key must not
  create duplicate decisions. Generate a fresh key per logical decision and reuse
  it only for retries of that same decision.
- **`evidenceRef`** — reference to the stored evidence supporting the decision.
  Must resolve to current, unexpired evidence in `asset_listing_evidence`.
- **`trigger`** — the reason for the decision. For delist/suspend this must be one
  of the delisting trigger ids in `ASSET_LISTING_TRIGGERS` (see §5). For listing,
  the trigger records the onboarding reason.

Storage:

- `verified_assets` — the current registry state (asset code, issuer, status,
  tier, timestamps).
- `asset_listing_evidence` — the evidence records referenced by `evidenceRef`.

Transition rules are enforced by `ASSET_LISTING_TRANSITIONS`; a decision that
requests an illegal transition is rejected (see §6).

Operator checklist for this step:

1. Read the current registry (`GET /admin/asset-listing/registry`) and confirm
   the asset's present status.
2. Confirm the requested transition is permitted by `ASSET_LISTING_TRANSITIONS`.
3. Generate an `Idempotency-Key`.
4. Submit `POST /admin/asset-listing/decisions` with `evidenceRef` and `trigger`.
5. Verify the response and re-read the registry to confirm the new state.

---

## 4. Cache invalidation checks

After a decision is applied, confirm caches reflect the new state before closing
the task.

- **Asset-metadata cache** — keyed by `CODE:ISSUER`. Invalidate the entry for the
  affected asset so metadata is re-served from the registry.
- **List cache** — invalidate the cached asset listing so the registry change is
  visible to consumers.
- **Served-status filter** — the served status is filtered via
  `assets.listing_policy`; confirm the served status matches the new registry
  state (e.g. a delisted asset is no longer served as listed).

Operator checklist for this step:

1. Invalidate the `CODE:ISSUER` asset-metadata cache entry.
2. Invalidate the list cache.
3. Confirm the served-status filter (`assets.listing_policy`) returns the
   expected status for the asset.
4. Record the cache checks performed in the decision notes.

---

## 5. Delisting and rollback

Delisting and suspension are reversible only through the documented path.

Transitions (`ASSET_LISTING_TRANSITIONS`):

- `listed → suspended` (suspend)
- `listed → delisted` (delist)
- `suspended → listed` (reinstate, subject to cooling-off)
- `suspended → delisted` (delist)
- `delisted → listed` (re-list, subject to cooling-off and evidence re-check)

Delisting triggers (`ASSET_LISTING_TRIGGERS`) — the `trigger` on a delist/suspend
decision must be one of:

- `issuer_request`
- `sanctions_hit`
- `reserve_failure`
- `security_incident`
- `metadata_mismatch`
- `regulatory_order`
- `inactivity`

Cooling-off and suspension limits:

- **Cooling-off before re-list:** a delisted asset may not be re-listed until
  `ASSET_LISTING_COOLING_OFF_DAYS_BEFORE_RELIST` days have elapsed since
  delisting.
- **Maximum suspension window:** a suspended asset must be resolved within the
  suspension maximum; if the window elapses without resolution, escalate to
  delist per governance.
- **Re-list evidence re-check:** before re-listing, every required evidence item
  for the tier must be re-collected and re-verified per §1 — prior evidence is not
  sufficient if expired.

Rollback steps:

1. Record the delist/suspend decision with the correct `trigger` and
   `evidenceRef`.
2. Complete the cache invalidation checks in §4.
3. To reverse, wait out the cooling-off period (if applicable), re-check all
   evidence, then record a re-list decision through
   `POST /admin/asset-listing/decisions`.

---

## 6. Evidence and audit trail

Every decision produces an auditable record.

- **Decision records** — each `POST /admin/asset-listing/decisions` writes a
  decision record retrievable via `GET /admin/asset-listing/decisions`, including
  the reviewer, `trigger`, `evidenceRef`, and resulting state.
- **Metrics** — decisions increment `asset_listing_decisions_total`; use it to
  confirm the decision was recorded.
- **No secrets** — never record signing material, secrets, or unnecessary
  personal data in evidence references or decision notes.

Error codes (`ASSET_LISTING_ERROR_HTTP`) — map each failure to its HTTP status
and resolve before retrying:

- `ASSET_LISTING_EVIDENCE_MISSING` — required evidence absent.
- `ASSET_LISTING_EVIDENCE_EXPIRED` — required evidence expired.
- `ASSET_LISTING_ISSUER_ACCOUNT_TOO_NEW` — issuer account younger than
  `ASSET_LISTING_MIN_ISSUER_ACCOUNT_AGE_DAYS`.
- `ASSET_LISTING_INVALID_TRANSITION` — transition not permitted by
  `ASSET_LISTING_TRANSITIONS`.
- `ASSET_LISTING_INVALID_TRIGGER` — trigger not in `ASSET_LISTING_TRIGGERS`.
- `ASSET_LISTING_COOLING_OFF_ACTIVE` — re-list attempted before
  `ASSET_LISTING_COOLING_OFF_DAYS_BEFORE_RELIST` elapsed.
- `ASSET_LISTING_SUSPENSION_EXPIRED` — suspension window elapsed; escalate to
  delist.
- `ASSET_LISTING_FEATURE_DISABLED` — `assets.listing_decisions` flag disabled.
- `ASSET_LISTING_FORBIDDEN` — caller lacks required admin scope.
- `ASSET_LISTING_IDEMPOTENCY_CONFLICT` — `Idempotency-Key` reused for a
  different decision.

Operator checklist for this step:

1. Confirm the decision record is visible via
   `GET /admin/asset-listing/decisions`.
2. Confirm `asset_listing_decisions_total` incremented.
3. Confirm no secrets or unnecessary personal data were recorded.
4. On any error code above, resolve the cause and retry with the same
   `Idempotency-Key` only for the same logical decision.