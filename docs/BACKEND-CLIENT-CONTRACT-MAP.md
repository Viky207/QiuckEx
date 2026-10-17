# Backend ↔ Client API Contract Map

This document maps the backend HTTP endpoints actually consumed by the **frontend** (`app/frontend`) and **mobile** (`app/mobile`) apps to their owning backend modules (`app/backend/src/*`), so route mismatches and payload drift are caught before contributor work diverges.

Scope: REST contracts between clients and the NestJS backend. For the complete reference of all route definitions, request/response models, and error envelopes, see [PUBLIC-API-REFERENCE.md](./PUBLIC-API-REFERENCE.md). On-chain/Soroban event schemas are covered separately in `app/backend/doc/EVENTS.md` and `app/contract/docs/events-schema.md`.

> **Important:** the backend registers **no global route prefix** (`app/backend/src/main.ts` never calls `setGlobalPrefix`). Controller prefixes are the full public paths. Anything a client prepends (like `/api`) is a bug — see [Known mismatches](#known-mismatches--payload-drift).

## Base URL configuration

| Client | Source | Default / production value |
|---|---|---|
| Frontend | `NEXT_PUBLIC_QUICKEX_API_URL` via `src/lib/api.ts` `getQuickexApiBase()` | `http://localhost:4000`; prod `https://api.quickex.to` (`vercel.json`) |
| Frontend (SSR OG metadata) | `QUICKEX_INTERNAL_API_URL` first, then `NEXT_PUBLIC_QUICKEX_API_URL` (`src/lib/og-metadata.ts`) | `http://localhost:4000` |
| Mobile | Expo `extra.apiUrl` (from `app.config.ts`) or `EXPO_PUBLIC_API_URL` | `http://localhost:4000` for local development; production uses `https://api.quickex.to` |
| Mobile (`payment-confirmation.tsx`) | `EXPO_PUBLIC_API_URL` | Falls back to `https://api.quickex.to` |

Auth conventions:

- **Public** (rate-throttled, no key): `docs` (`/docs`, `/docs/json`, `/docs/openapi.json`), `health`/`ready`/`status`, `username/*`, `payment-links/status`, `v1/receipts/*`
- **Optional `X-API-Key`** (higher rate limits via `ApiKeyGuard`): `links/metadata`, `transactions`, `stellar/*`, `analytics/*`, `contracts/registry` reads
- **Admin-scoped API key** (`@RequireScopes('admin')`): all `admin/*` controllers, contract registry writes (`publish`, `PUT deployments/:name`, `rollback`)
- Errors follow the global envelope `{ code, message, fields? }` (global `ValidationPipe` in `main.ts`, e.g. `VALIDATION_ERROR`)

Correlation IDs:

- Clients **should send** an `X-Correlation-ID` header on every request (any stable, unique string per logical operation, e.g. a UUID). When omitted, the backend generates one.
- The backend **echoes** the effective value back on the `X-Correlation-ID` response header — clients should read it and attach it to client-side logs, error reports, and support requests.
- The same value is included in the error envelope's `correlationId` field (when present) and in structured backend logs, so a single ID ties a client-visible failure to its server-side trace.
- Include the `X-Correlation-ID` value in any support request or bug report about a failed call; without it, server-side diagnosis requires guessing from timestamps.

## Transaction submission, confirmation & retry orchestration

The transaction lifecycle is owned by the `transactions` module (`app/backend/src/transactions/*`) and consumed by the mobile history screen (`app/mobile/services/transactions.ts`). Submission, confirmation polling, and retry are orchestrated server-side so clients never hold signing keys — self-custody is preserved because the backend only ever receives an already-signed XDR envelope and never a secret key.

### Endpoints

| Endpoint | Owning module | Request → response summary |
|---|---|---|
| `POST /transactions/submit` | `transactions` (`transactions.controller.ts`) | `{ signedXdr, network, idempotencyKey }` → `{ hash, status, ledger?, submittedAt }`. Optional `X-API-Key`. |
| `GET /transactions/:hash/status` | `transactions` | → `{ hash, status, ledger?, confirmations, lastCheckedAt }`; polls Horizon for confirmation. |
| `POST /transactions/:hash/retry` | `transactions` | Re-submits a previously failed envelope using the stored idempotency key → same response shape as `submit`. |

### Status model

`status` is one of `pending`, `submitted`, `confirmed`, `failed`, `expired`. Terminal states are `confirmed`, `failed`, and `expired`; only `pending`/`submitted` are retryable.

### Authorization & idempotency

- Submission requires a valid signed envelope whose source account matches the authenticated `X-API-Key` owner (or the public key asserted in the request when no key is configured). Unauthorized submissions return `403 FORBIDDEN`.
- `idempotencyKey` is required and scoped per source account. Replaying the same key returns the original result (`200`) instead of re-submitting; a conflicting payload under the same key returns `409 IDEMPOTENCY_CONFLICT`.
- Duplicate submissions of an already-`confirmed` hash return the cached confirmation rather than a second Horizon call.

### Validation & stable errors

| Condition | HTTP | `code` |
|---|---|---|
| Missing/malformed `signedXdr` | 400 | `VALIDATION_ERROR` |
| Unsupported `network` | 400 | `UNSUPPORTED_NETWORK` |
| Envelope expired (`timeBounds.maxTime` in the past) | 400 | `TRANSACTION_EXPIRED` |
| Source account not authorized for the key | 403 | `FORBIDDEN` |
| Replayed key with different payload | 409 | `IDEMPOTENCY_CONFLICT` |
| Horizon unreachable / 5xx | 503 | `HORIZON_UNAVAILABLE` |
| Horizon rejects the envelope | 422 | `TRANSACTION_REJECTED` |

### Retry & rollback

- Retries use exponential backoff (base 1s, cap 30s, max 5 attempts) and are only issued for `pending`/`submitted` transactions or transient `HORIZON_UNAVAILABLE` failures.
- A retry never mutates the original envelope; it re-submits the stored signed XDR. If Horizon reports the transaction as already applied, the orchestrator reconciles to `confirmed` instead of double-spending.
- Failed submissions leave no partial state: the idempotency record is retained so a later retry is safe, and no balance/ledger mutation is performed by the backend.

### Feature gating

Mainnet submission is gated behind `TESTNET_CONTRACT_WRITES_FLAG` (same flag used by `stellar/soroban-preflight`). When unset, `POST /transactions/submit` returns `503 CONTRACT_NOT_CONFIGURED` on mainnet and only testnet is permitted. `NetworkSafetyGuard` enforces the network/asset allow-list before any Horizon call.

### Observability

- Structured logs emit `{ event, hash, network, status, attempt, latencyMs }` — never the signed XDR, secret keys, or full account balances.
- Metrics: `tx_submit_total{status}`, `tx_confirm_latency_ms` (histogram), `tx_retry_total{reason}`, `tx_idempotency_conflict_total`.
- Degraded mode: when Horizon is unavailable, submissions return `503 HORIZON_UNAVAILABLE` and clients fall back to the cached history view; the orchestrator queues a bounded retry rather than failing the user session.

### Configuration & operations

- `QUICKEX_CONTRACT_ID` — required for mainnet submission (see `docs/horizon-usage.md`).
- `TESTNET_CONTRACT_WRITES_FLAG` — enables mainnet writes; leave unset until mainnet rollout.
- No database migration is required; idempotency records are keyed by `(sourceAccount, idempotencyKey)` and expire after the transaction's `timeBounds` window.
- Operational procedure: on sustained `HORIZON_UNAVAILABLE`, check Horizon status, then replay queued retries via `POST /transactions/:hash/retry`; confirm reconciliation in the `tx_confirm_latency_ms` dashboard.

## Merchant payment preferences

The `links` module stores wallet-authorized payment preferences off-chain. The accepted-asset list controls what is offered on newly generated links; `settlementAsset` is the merchant's preferred requested asset for new links. It is not a standing order, payment authorization, or automatic conversion. Every payment still requires the payer's own wallet approval. Existing links and the contract settlement state machine are unaffected.

### Endpoints

| Endpoint | Auth / behavior |
|---|---|
| `GET /merchant/payment-preferences?publicKey=G...` | Public read of the non-sensitive preference snapshot; an unset wallet receives the XLM default with `version: 0`. |
| `PUT /merchant/payment-preferences` | Requires a valid Ed25519 signature from `publicKey`, a fresh `signedAt`, and `Idempotency-Key`; no API key or secret key is sent to the backend. |

Request fields are `publicKey`, `expectedVersion` (0 for first save), `acceptedAssets` (1-8 unique codes from `XLM`, `USDC`, `AQUA`, `yXLM`), `settlementAsset` (must be in `acceptedAssets`), `signedAt` (Unix milliseconds), and base64 `signature`. The signature is over:

```text
QuickEx merchant payment preferences\n{publicKey}\n{expectedVersion}\n{signedAt}\n{sha256(JSON.stringify({acceptedAssets: sortedAssets, settlementAsset}))}
```

The write is accepted only on Stellar testnet when `merchant.payment_preferences` is enabled. The feature flag defaults enabled in development/test environments and is disabled in production; the service also rejects every non-testnet network. A successful write increments the version exactly once when values change. The same idempotency key and semantic payload replays the original response; reuse with a different wallet or payload conflicts. Idempotency records expire after 24 hours. The database function serializes writes per wallet and commits preference/version/idempotency state atomically.

### Stable errors

| Condition | HTTP | `code` |
|---|---:|---|
| Invalid wallet key, assets, settlement choice, or idempotency key | 400 | `MERCHANT_PREFERENCES_MALFORMED` (DTO validation may use global `VALIDATION_ERROR`) |
| Missing or invalid wallet signature | 401 | `MERCHANT_PREFERENCES_UNAUTHORIZED` |
| Signed authorization older than five minutes | 410 | `MERCHANT_PREFERENCES_EXPIRED` |
| Stale version or idempotency key reused with a different payload | 409 | `MERCHANT_PREFERENCES_CONFLICT` |
| Feature flag off, production environment, or non-testnet network | 503 | `MERCHANT_PREFERENCES_DISABLED` |
| Supabase or feature-flag dependency failure | 503 | `MERCHANT_PREFERENCES_DEPENDENCY_FAILURE` |

Clients retain the last successful version. On `409`, refetch before applying a change; do not retry with a new version without the merchant's confirmation. On dependency errors, leave the existing form values intact and allow a later read/save retry. New-link generation degrades to the caller's existing explicit asset selection if preference reads are disabled or unavailable.

### Configuration, migration, and operations

- Flag: `merchant.payment_preferences`; testnet only, enabled in development/test, off in production. Keep it disabled for mainnet; enabling requires a separate custody/settlement audit and release approval.
- Forward migration: `app/backend/supabase/migrations/20261017000000_merchant_payment_preferences.sql`. Rollback: `app/backend/supabase/migrations/rollback/20261017000000_down_merchant_payment_preferences.sql`.
- Before testnet enablement, apply the forward migration and run `pnpm --dir app/backend test:unit -- merchant-payment-preferences.service.unit.spec.ts --runInBand` plus `node app/backend/scripts/verify-migrations.js`.
- Monitor `quickex_merchant_payment_preferences_requests_total{operation,outcome,code}`, `external_call_duration_seconds{service="merchant_payment_preferences"}`, and `error_total{service="merchant_payment_preferences"}`. Structured `merchant_payment_preferences.*` logs contain stable outcome, version, and latency only; they omit wallet identifiers and signatures.
- For an incident, set the flag's kill switch (or disable the flag) first. Reads/writes then return `503 MERCHANT_PREFERENCES_DISABLED`, and link generators fall back. Preserve a database backup before rollback: applying the paired down migration drops preference and idempotency records. No queued payments or on-chain state require replay or compensation.

## Frontend endpoint map

| Screen / feature | Endpoint | Owning backend module | Request → response summary |
|---|---|---|---|
| Public profile page (`app/[username]/page.tsx`) | `GET /username/:username` | `usernames` (`usernames.controller.ts`) | Path param → `{ id, username, publicKey, isPublic, lastActiveAt, createdAt }`; private profiles return only `{ username, isPublic: false }`; 404 if unknown |
| Profile editing (`settings/profile/page.tsx`) | `PATCH /username/profile` | `usernames` (`usernames.controller.ts`) | Authenticated profile update; see [Profile update contract](#profile-update-contract-patch-usernameprofile) |
| Merchant payment preferences (`settings/page.tsx`) | `GET/PUT /merchant/payment-preferences` | `links` (`merchant-payment-preferences.controller.ts`) | Reads wallet defaults; PUT is wallet-signed and idempotent. See [Merchant payment preferences](#merchant-payment-preferences). |
| Pay page (`pay/PaymentPageClient.tsx`) + SSR OG previews (`lib/og-metadata.ts`) | `GET /payment-links/status?username&amount&asset&memo&acceptedAssets` | `links` (`payment-link.controller.ts`) | Query params → `PaymentLinkStatusDto` (active / expired / paid / refunded) |
| Link generator (`generator/page.tsx`) | `GET /stellar/verified-assets` | `stellar` (`stellar.controller.ts`) | → `AssetListResponseDto` (verified assets + TOML branding metadata) |
| Link generator — wallet capability discovery | `GET /stellar/wallet-capabilities?publicKey` | `stellar` | → `WalletCapabilitiesDto`; drives unsupported-wallet UI gating (see above) |
| Link generator — cross-asset preview | `POST /stellar/path-preview` | `stellar` | `{ destAsset, destAmount, sourceAccount... }` → candidate paths + estimated source amounts (strict-receive) |
| Link generator — contract preflight | `POST /stellar/soroban-preflight` | `stellar` | `{ sourceAccount }` → compose-pipeline `health_check` simulation. Gated: `NetworkSafetyGuard` + `TESTNET_CONTRACT_WRITES_FLAG`; 503 `CONTRACT_NOT_CONFIGURED` if `QUICKEX_CONTRACT_ID` unset |
| Link generator — create link | `POST /links/metadata` | `links` (`links.controller.ts`) | `LinkMetadataRequestDto` → `{ success, data: LinkMetadataResponseDto }`; optional `X-API-Key` raises rate limit 20→120 req/min. New-link defaults may include destination wallet preferences. |
| Link generator — CSV bulk | `POST /links/bulk/generate` | `links` (`bulk-payment-links.controller.ts`, prefix `links/bulk`) | `{ links: [...] }` → per-row results |
| Dashboard analytics (`hooks/analyticsApi.ts`) | `GET /analytics/report?publicKey&startDate&endDate&interval` | `analytics` (`analytics.controller.ts`) | → summary + asset distribution + time-series; client falls back to empty data on failure |
| Analytics export | `GET /analytics/export?...&format` | `analytics` | → CSV/PDF stream (tax/accounting report) |
| Marketplace (`hooks/marketplaceApi.ts`) | `GET /marketplace?limit&cursor`, `GET /marketplace/:listingId/detail?viewerPublicKey` | `marketplace` (`marketplace.controller.ts`) | Cursor-paginated listings; detail view is viewer-aware |
| Developer settings (`settings/developer/page.tsx`) | `GET/POST /api-keys`, `GET /api-keys/usage`, `DELETE /api-keys/:id`, `POST /api-keys/:id/rotate` | `api-keys` (`api-keys.controller.ts`) | Key CRUD; create/rotate responses include the plaintext `key` once |
| Webhook management (`webhooks/page.tsx`) | `POST/GET/DELETE /webhooks/:publicKey[/:id]` + `/logs`, `/stats`, `/redeliver`, `/replays`, `/regenerate-secret`, `GET /webhooks/:publicKey/:id/event-versions`, `POST /webhooks/verify-signature` | `notifications` (`webhooks.controller.ts`) | Full webhook family; UI passes an API key header via `apiFetch`. Deliveries carry `apiVersion` + per-event `version` (#275); `/event-versions` returns version + sunset + migration metadata. `POST .../regenerate-secret?overlapMs=` rotates the signing secret, retaining the previous one for verification during the overlap window and returning `previousSecretExpiresAt` (#277). |
| Admin — system health (`components/admin/SystemHealth.tsx`) | `GET /health` | `health` (`health.controller.ts`, root-level `@Controller()`) | → `HealthResponseDto` (shallow liveness); backend also serves `GET /ready` and `GET /status` (unused by clients) |
| Admin — feature flags (`components/admin/FeatureFlags.tsx`) | `GET /admin/feature-flags`, `PATCH /admin/feature-flags/:key` | `feature-flags` | Flag list + toggle. ⚠️ Called with **no auth header** — see mismatch #7 |
| Admin — audit logs (`components/admin/AuditLogs.tsx`) | `GET /admin/audit` | `audit` | Audit log rows. ⚠️ Same no-auth-header concern |

## Mobile endpoint map

| Screen / feature | Endpoint | Owning backend module | Request → response summary |
|---|---|---|---|
| Transaction history (`services/transactions.ts`) | `GET /transactions?accountId&limit&cursor&asset` | `transactions` (`transactions.controller.ts`) | → `TransactionResponseDto` (normalized payments via Horizon, cached ~60s); expect 429/502/503 semantics |
| Transaction submission (`services/transactions.ts`) | `POST /transactions/submit` | `transactions` | Signed XDR → `{ hash, status }`; see [Transaction submission, confirmation & retry orchestration](#transaction-submission-confirmation--retry-orchestration) |
| Transaction confirmation (`services/transactions.ts`) | `GET /transactions/:hash/status` | `transactions` | Polls confirmation state; terminal states stop polling |
| Transaction retry (`services/transactions.ts`) | `POST /transactions/:hash/retry` | `transactions` | Re-submits a failed envelope; idempotent |
| Link creation (`services/link-metadata.ts`, `app/link-generator.tsx`) | `POST /links/metadata`; `GET /merchant/payment-preferences?publicKey` | `links` | Same metadata contract as frontend; testnet preference reads default new links for that destination wallet. |
| Wallet capability discovery (`services/wallet-capabilities.ts`) | `GET /stellar/wallet-capabilities?publicKey` | `stellar` | Same contract as frontend ✅; drives unsupported-wallet gating on escrow confirmation |
| Asset picker (`app/link-generator.tsx`) | `GET /stellar/verified-assets` | `stellar` | Same as frontend ✅ |
| Notification center (`services/in-app-notifications.ts`) | `GET /notifications/in-app?publicKey`, `POST /notifications/in-app/:id/read`, `POST /notifications/in-app/read-all?publicKey` | `notifications` (`notifications.controller.ts`) | List + read-state; client tolerates both a plain array and a Supabase-style list envelope (defensive drift handling) |
| Escrow confirmation (`app/payment-confirmation.tsx` → `hooks/useContractRegistry.ts` → `services/contract-registry.ts`) | ⚠️ `GET /api/contracts/registry` | `contracts` (`contract-registry.controller.ts`) | **BROKEN** — backend serves `GET /contracts/registry` (with ETag/304 support). The `/api` prefix 404s. See mismatch #1 |
| Session bootstrap (`services/session-bootstrap.ts`) | `GET /session/bootstrap` (Bearer = publicKey) | `session` (`session.controller.ts`) | Runtime configuration, active feature flags, unread count, and authenticated account context; degrades safely when offline |
| In-app feedback (`services/feedback.ts`) | ⚠️ `POST /feedback` | — | **No backend controller.** Client intentionally degrades to an exportable payload on failure |
| Share receipt (`src/screens/ReceiptScreen.tsx`, `hooks/useShareReceipt.ts`) | `${baseUrl}/tx/:receiptHash` | — | A **web** share URL, not an API call. Note the actual receipts API is `GET /v1/receipts/tx/:txHash` — don't confuse the two |

## Profile update contract (`PATCH /username/profile`)

Owned by the `usernames` module (`app/backend/src/usernames/usernames.controller.ts`). Unlike the public `GET /username/:username` read, this route is **authenticated**: the caller proves ownership of the profile's Stellar key by signing the request (self-custody — the backend never receives a secret key).

### Request

| Field | Type | Required | Notes |
|---|---|---|---|
| `username` | string | yes | The profile being edited; must resolve to the authenticated `publicKey`. |
| `publicKey` | string | yes | Stellar public key of the profile owner; must match the signature. |
| `displayName` | string \| null | no | Omit to leave unchanged; `null` clears it. |
| `bio` | string \| null | no | Max 280 chars; omit to leave unchanged; `null` clears it. |
| `avatarUrl` | string \| null | no | Must be an `https://` URL; omit to leave unchanged; `null` clears it. |
| `isPublic` | boolean | no | Toggles public visibility of the profile. |
| `signature` | string | yes | Base64 signature over the canonical payload (see below). |
| `version` | integer | yes | Optimistic-concurrency token; see [Version semantics](#version-semantics). |

Only the fields present in the body are mutated; absent fields are left untouched (partial update). Sending an explicit `null` for a nullable field clears it.

### Canonical signing payload

The signature is computed over the deterministic string:

```
PATCH /username/profile\n{username}\n{publicKey}\n{version}\n{sha256(canonicalJson(fields))}
```

where `fields` is the subset of mutable fields present in the request, serialized with sorted keys. This binds the signature to the exact edit and the version it was based on, so a replayed signature cannot be reused against a different version.

### Response

`200 OK` → the updated profile:

```json
{
  "id": "…",
  "username": "alice",
  "publicKey": "G…",
  "displayName": "Alice",
  "bio": "…",
  "avatarUrl": "https://…",
  "isPublic": true,
  "version": 8,
  "lastActiveAt": "…",
  "createdAt": "…",
  "updatedAt": "…"
}
```

The response always includes the new `version`, which the client must retain for its next update.

### Version semantics

- `version` is a monotonically increasing integer per profile, starting at `1` on creation.
- Every successful `PATCH` increments it by exactly one and returns the new value.
- The client must send the `version` it last observed. If it is stale, the write is rejected with `409 PROFILE_VERSION_CONFLICT` and the current profile is returned in the error `fields` so the client can re-apply its edit.
- A `PATCH` that changes nothing (all provided values equal current values) is a no-op: it returns `200` with the **unchanged** version and does not increment it.

### Errors

| Condition | HTTP | `code` |
|---|---|---|
| Missing/malformed field, bad `avatarUrl` scheme, bio too long | 400 | `VALIDATION_ERROR` |
| Missing/invalid `signature` | 401 | `PROFILE_SIGNATURE_INVALID` |
| `publicKey` does not own `username` | 403 | `FORBIDDEN` |
| Unknown `username` | 404 | `PROFILE_NOT_FOUND` |
| Stale `version` | 409 | `PROFILE_VERSION_CONFLICT` |
| Rate limit exceeded | 429 | `RATE_LIMITED` |

Errors use the global envelope `{ code, message, fields? }`; `PROFILE_VERSION_CONFLICT` populates `fields.current` with the latest profile.

## Known mismatches & payload drift

Explicitly tracked so contributors don't re-discover them:

1. **Mobile contract registry path is wrong** — `app/mobile/services/contract-registry.ts` calls `/api/contracts/registry`; the backend route is `/contracts/registry` (no global `api` prefix exists). This breaks Escrow registry sync on the payment-confirmation screen. Fix: drop the `/api` prefix (and consider adopting `If-None-Match`/ETag, which the backend already supports).
2. **Mobile `GET /session/bootstrap`** — resolved: backend controller implemented (`src/session/session.controller.ts`), delivering runtime configuration, feature flags, unread counts, and account context with degraded fallback in client.
3. **Mobile `POST /feedback`** — no backend controller; the client's export fallback masks this, but every submit silently "fails" to the export path when a backend is configured.
4. **Base-URL drift** — resolved: mobile services default to `http://localhost:4000`, and `payment-confirmation.tsx` uses the canonical `api.quickex.to` fallback. `EXPO_PUBLIC_API_URL` can still override the local default when needed.
5. **Prefix inconsistency** — `v1/receipts` is the only versioned controller; `api/environment-parity` is the only `api/`-prefixed one; everything else is unprefixed. Treat these as historical accidents, not conventions to copy.
6. **Two controllers share the `links` prefix** — `links.controller.ts` (metadata) and `scam-alerts.controller.ts` both mount `@Controller("links")`. Route collisions are possible when adding new `links/*` subroutes; check both files.
7. **`admin/feature-flags` and `admin/audit` are unguarded** — unlike every other `admin/*` controller, `feature-flags.controller.ts` and `audit.controller.ts` have **no `ApiKeyGuard`/`RequireScopes`** (the audit controller even carries a `// In a real app, this route would be protected by an AdminGuard` comment). The frontend admin pages (`FeatureFlags.tsx`, `AuditLogs.tsx`) accordingly call them with no auth header. This is a known security gap: when guards are added, those two frontend pages must add key handling in the same change.
8. **Notification list response shape is loose** — mobile handles both a raw array and a Supabase-style envelope from `/notifications/in-app`. Pin the backend DTO before removing the client's defensive unwrapping.

## Compatibility aliases & migration paths

- **`POST /transactions/build` is a deliberate alias of `POST /transactions/compose`** — both invoke `TransactionsService.composeTransaction()` and return unsigned XDR + `correlationId`. Prefer `compose` in new code; `build` exists for compatibility.
- **Feature-flag gate on contract writes** — `POST /transactions/compose|build|simulate` and `POST /stellar/soroban-preflight` all require `TESTNET_CONTRACT_WRITES_FLAG` + `NetworkSafetyGuard` (+ `ContractMethodAllowlistGuard` on transactions). Clients must handle 403/503 on mainnet or when the flag is off.
- **Contract registry ETag protocol** — `GET /contracts/registry` returns an `ETag`; clients should send `If-None-Match` and treat 304 as "unchanged". This is the sanctioned change-detection path for contract ID rollovers (registry rollback via `POST /contracts/registry/rollback` shifts the active entry without a client-side path change).
- **Event schema compatibility** — ingestion-side per-event `compatibleVersions` lists live in `app/backend/src/ingestion/event-schema.ts` with legacy-topic fallback in the Soroban event parser. Relevant when payloads surfaced through `transactions`/`receipts` change shape.

## Implemented on the backend, no client consumer yet

Useful when picking issues — these are "wire the client" opportunities, not new backend work:

| Endpoint family | Backend module | Docs |
|---|---|---|
| `GET /username/search`, `/trending`, `/recently-active`, `/featured`, `POST /username/toggle-public` | `usernames` | `app/backend/docs/API-REFERENCE-PUBLIC-PROFILES.md` |
| `links/recurring/*` | `links` (`recurring-payments.controller.ts`) | `app/backend/docs/RECURRING-PAYMENTS.md` |
| `GET /v1/receipts/address/:address` | `receipts` | (Address-level listing; single tx verified via `services/receipts.ts`) |
| `GET /payments/recent` | `payments` | — |
| `POST /stellar/quote`, `GET /stellar/quote/:quoteId`, `POST /stellar/path-preview/strict-send` | `stellar` | — |
| `GET /analytics/time-series`, `GET /analytics/assets` | `analytics` | `app/backend/docs/ANALYTICS-API.md` (frontend uses only `report`/`export`) |
| `notifications/preferences/*` | `notifications` | — |
| `admin/refunds`, `admin/rc-validation`, `admin/operations`, `admin/notification-templates`, `admin/support/bundle` | respective modules | operator-facing, admin key required |
| `GET /admin/observability/slo`, `GET /admin/observability/slo/:id` | `observability` (observability.controller.ts) | `@RequireScopes('admin')` | → SLO report: per-objective target, observed ratio, burn rate, remaining budget, status, and the raw `evidence` counters. Unobserved objectives report `insufficient_data`, never `ok` |
| `GET /admin/observability/alerts`, `GET /admin/observability/alerts/rules` | `observability` | `@RequireScopes('admin')` | → alert state (`ok`/`pending`/`firing`/`no_data`), measurement, and per-rule runbook. Evaluates on read |
| `GET /admin/observability/dependencies` | `observability` | `@RequireScopes('admin')` | → per-dependency readiness probe with criticality, status, latency. `ready` reflects critical probes only; an optional dependency outage reports `degraded` |
| `GET`/`POST /admin/observability/replay/:publicKey/:channel/:eventType/:eventId` | `observability` (`replay/`) | `@RequireScopes('admin')`; `POST` additionally gated by `mainnet.operator_replay` (disabled by default) | → delivery status / replay result. Stable errors: `OPERATOR_REPLAY_{MALFORMED,CHANNEL_UNSUPPORTED,NOT_FOUND,ALREADY_DELIVERED,COOLDOWN,DEPENDENCY_FAILURE}`, `WEBHOOK_REPLAY_{COOLDOWN,QUOTA_EXCEEDED}`. No secrets or notification bodies returned |
| `transaction-timeline`, `privacy`, `reconciliation`, `telegram`, `metrics`, `developer/testnet`, `api/environment-parity` | respective modules | server-side only today |
| `GET /asset-listing/policy` | `asset-listing` (asset-listing.controller.ts) | Public (optional key) | → published listing policy: tiers, states, transitions, delisting triggers, evidence max ages, `ASSET_LISTING_*` error codes, feature flags. No personal data |
| `GET /admin/asset-listing/registry`, `GET /admin/asset-listing/decisions` | `asset-listing` (asset-listing-admin.controller.ts) | `@RequireScopes('admin')` | Registry rows with effective status/served flag/reasons; append-only decision trail |
| `POST /admin/asset-listing/decisions` | `asset-listing` | `@RequireScopes('admin')` + `assets.listing_decisions` flag + `Idempotency-Key` | `{action,code,issuer?,trigger?,evidenceRef?,evidence?}` → decision record (`idempotent: true` on replay). Stable errors: `ASSET_LISTING_*` |
| `GET /privacy/retention-policy` | `privacy` (privacy.controller.ts) | Public (optional key) | → published retention schedule: categories, windows, deletion methods, holds, SLA, `DELETION_*`/`RETENTION_*` codes. Always available, even when the flags are off |
| `POST /privacy/deletion-requests/challenge` | `privacy` | Public (optional key) + `privacy.deletion_requests` flag | `{subject, subjectKind?}` → `{challengeId, challenge, expiresAt, purpose}`; the subject signs `challenge` with their Stellar key (self-custody) |
| `POST /privacy/deletion-requests` | `privacy` | Public (optional key) + flag + `Idempotency-Key` | `{subject?, challengeId, signature}` → **202** with SLA dates and per-category outcomes. Errors: `DELETION_SIGNATURE_INVALID` (401), `DELETION_CHALLENGE_EXPIRED` (410), `DELETION_REQUEST_DUPLICATE` / `DELETION_IDEMPOTENCY_CONFLICT` (409), `DELETION_INTAKE_DISABLED` (403) |
| `POST /privacy/deletion-requests/:id/cancel` | `privacy` | Public (optional key) | Signed cancel during the cooling-off window; `DELETION_NOT_CANCELLABLE` / `DELETION_ALREADY_EXECUTED` after it |
| `GET /privacy/deletion-requests/:id` | `privacy` | `@RequireScopes('admin')` | Status, SLA dates, per-category outcomes/holds, salted subject hash (never the raw subject) |
| `POST /admin/privacy/retention/sweep` | `privacy` (admin-privacy.controller.ts) | `@RequireScopes('admin')` + `privacy.retention_sweep` flag + `Idempotency-Key` | `{apply?: boolean, batchSize?: number}` → run result (`planned`, `failed`, `completed`). Dry-run unless `apply: true`; `RETENTION_SWEEP_DISABLED` (403) when the flag is off |
| `GET`/`PATCH /visibility/settings` | `visibility` (visibility.controller.ts) | Optional `X-API-Key` | → per-account visibility settings (profile, activity, balances, receipts) with defaults applied when unset; `PATCH` accepts a partial settings object and returns the merged result. No client consumer yet |
| `GET`/`POST /visibility/rotation` | `visibility` (rotation.controller.ts) | Optional `X-API-Key` | → key-rotation schedule and history; `POST` schedules a rotation window and returns the pending rotation record. No client consumer yet |

## Planned but not fully wired

- **Session bootstrap** (`GET /session/bootstrap`) — mobile client exists, backend missing (mismatch #2).
- **Feedback intake** (`POST /feedback`) — mobile client exists with export fallback, backend missing (mismatch #3).
- **Soroban contract writes on mainnet** — the compose/build/simulate/preflight family is testnet-only behind `TESTNET_CONTRACT_WRITES_FLAG`; mainnet enablement is a future gate, not a bug.
- **Oracle-priced fees** — the on-chain oracle fetch is a stub (`app/contract/contracts/quickex/src/oracle.rs`); no client-facing endpoint yet, fees fall back to static basis points.

## How to use this map

- **Adding a client call?** Confirm the exact controller prefix in `app/backend/src/**/**.controller.ts` — do not assume `/api` or `/v1` prefixes (there is no global prefix).
- **Adding a backend route?** Check whether frontend and mobile need it, keep the prefix conventions above in mind, and update this map in the same PR.
- **Reviewing a PR that touches a route or DTO?** Grep both client apps for the path string; the tables above tell you which screens break.
- **Picking an issue?** The mismatch list is ordered roughly by user impact; #1 (mobile registry path) breaks a live payment screen and is the highest-value small fix.
