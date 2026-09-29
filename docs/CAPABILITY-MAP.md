# Capability Map: Live vs Mocked vs Partial vs Experimental

This document is the single place to check **what is actually built versus scaffolded** across all four product surfaces (`app/frontend`, `app/backend`, `app/mobile`, `app/contract`). Use it before picking an issue or building on top of an existing flow, so you don't depend on something that only *looks* implemented.

Companion docs:

- [BACKEND-CLIENT-CONTRACT-MAP.md](./BACKEND-CLIENT-CONTRACT-MAP.md) — endpoint-level wiring between clients and backend (mismatch numbers referenced below, e.g. "mismatch #1", come from that doc).
- [PUBLIC-API-REFERENCE.md](./PUBLIC-API-REFERENCE.md) — canonical public reference of all executable API route definitions.
- [CUSTODY-TRUST-THREAT-MODEL.md](./CUSTODY-TRUST-THREAT-MODEL.md) — security architecture, custody boundaries, and threat mitigations.
- [CONTRIBUTOR-CAPABILITY-SELECTION-GUIDE.md](./CONTRIBUTOR-CAPABILITY-SELECTION-GUIDE.md) — guide for selecting, implementing, and promoting capabilities.
- [MAINNET-PROMOTION-AND-GOVERNANCE.md](./MAINNET-PROMOTION-AND-GOVERNANCE.md) — mainnet launch evidence, multisig protocol, and rollback criteria.
- [MVP-CONTRACT-SCOPE.md](./MVP-CONTRACT-SCOPE.md) — what is deliberately on-chain vs deferred.
- [RUNTIME-CONFIG-MATRIX.md](./RUNTIME-CONFIG-MATRIX.md) — environment/config drift that affects whether "Live" flows actually work in your environment.
- [adr/README.md](./adr/README.md) — architecture decision records: the non-obvious decisions behind this map (self-custody, testnet-first, Supabase as system of record, this status vocabulary) and when a new one is required.
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — issue templates, the label vocabulary, and the ADR workflow.

## Status legend

Exactly four status terms are used in this document. If you update a row, use only these. The vocabulary is itself a recorded decision — see [ADR 0004](./adr/0004-canonical-status-vocabulary.md).

| Status | Meaning |
|---|---|
| **Live** | Wired end-to-end against real services (NestJS backend, Supabase, Horizon, Soroban RPC). Safe to build on. |
| **Partial** | Some segments are real, others are stubbed, missing, or broken. Read the notes column before relying on it. |
| **Mocked** | Returns hardcoded/simulated data. The UI or API shape exists, but nothing real happens behind it. |
| **Experimental** | Gated behind feature flags, testnet-only, or still at spec/requirements stage. Behavior may change or be disabled at any time. |

> "Planned but not fully wired" items from the contract map (client exists, backend route missing) are classified **Partial** here. Known-broken wiring is also **Partial**, with the breakage called out in the notes.

---

## Wallet capability discovery

Wallet capability discovery is the shared contract that lets every surface ask *what a connected wallet can actually do* before it renders a signing flow, and degrade gracefully when a wallet is unsupported. It is owned by `app/frontend/src/lib/wallet-capabilities.ts` (discovery + capability model) and consumed by the payment signing states and the link generator.

| Capability | Owning module | Status | Notes |
|---|---|---|---|
| Capability model & discovery | `app/frontend/src/lib/wallet-capabilities.ts` | **Live** | `discoverWalletCapabilities()` probes the injected provider for `signTransaction`, `signAuthEntry`, `signMessage`, and network passphrase support. Returns a stable `WalletCapabilities` object; never throws. |
| Unsupported-wallet handling | `app/frontend/src/components/payment-states/*` | **Live** | When discovery reports a missing capability, the signing flow renders an explicit unsupported state with a stable error code instead of fabricating a signature. |
| Soroban auth-entry signing | `app/frontend/src/lib/wallet-capabilities.ts` | **Experimental** | `signAuthEntry` is only required for Soroban contract writes; gated behind the `testnet.contract_writes` flag and `NetworkSafetyGuard`. Wallets without it still work for classic payments. |
| Capability discovery on mainnet | `app/frontend/src/lib/wallet-capabilities.ts` | **Experimental** | Discovery itself is network-agnostic, but mainnet signing remains gated by the `mainnet.refunds` / contract-write flags; unsupported wallets are rejected with a stable error rather than silently downgraded. |

### Stable error codes

Discovery and the signing flows surface these stable codes (never raw provider messages):

| Code | Meaning |
|---|---|
| `WALLET_NOT_INSTALLED` | No injected provider was found. |
| `WALLET_UNSUPPORTED` | Provider exists but lacks a required capability for the requested operation. |
| `WALLET_NETWORK_MISMATCH` | Provider's network passphrase does not match the requested network. |
| `WALLET_DISCOVERY_FAILED` | Provider threw or returned a malformed capability payload (dependency failure). |

### Observability

Discovery emits a structured log line (`wallet.capabilities.discovered`) with the wallet id, the resolved capability set, and latency in ms. It never logs addresses, signatures, or XDR. Failures emit `wallet.capabilities.failed` with the stable code above so success, latency, and failure are diagnosable without exposing secrets.

---

## Frontend (`app/frontend`)

Next.js 15 app. Base URL via `NEXT_PUBLIC_QUICKEX_API_URL` (`src/lib/api.ts`), default `http://localhost:4000`.

| Flow | Owning module | Status | Notes |
|---|---|---|---|
| Public profile page | `src/app/[username]` → backend `usernames` | **Live** | Real `GET /username/:username`; private profiles degrade correctly. |
| Pay page + SSR OG previews | `src/app/pay`, `src/lib/og-metadata.ts` → backend `links` | **Live** | Real `GET /payment-links/status`. |
| Payment signing state | `src/components/payment-states/ActivePaymentState.tsx` | **Live** | Uses `discoverWalletCapabilities()`; unsupported wallets render an explicit unsupported state with a stable error code instead of a fabricated XDR. |
| Link generator (assets, path preview, metadata, CSV bulk) | `src/app/generator` → backend `stellar`, `links` | **Live** | Real endpoints throughout; bulk gated by `bulk_link_generation` flag (enabled by default). |
| Link generator — Soroban contract preflight | `src/app/generator` → backend `stellar` | **Experimental** | `POST /stellar/soroban-preflight` requires `testnet.contract_writes` flag + `NetworkSafetyGuard`; 503 if `QUICKEX_CONTRACT_ID` unset. |
| Dashboard analytics | `src/app/dashboard`, `src/hooks/analyticsApi.ts` → backend `analytics` | **Live** | Real report/export; silently falls back to empty data on API failure. |
| Marketplace listings + detail | `src/app/marketplace` → backend `marketplace` | **Partial** | Listing fetch/detail hit real `GET /marketplace` routes, but see next two rows. |
| Marketplace — user bids & user listings | `src/hooks/marketplaceApi.ts` | **Mocked** | `MOCK_USER_BIDS` / `MOCK_USER_LISTINGS` returned behind fake delays. |
| Marketplace — real-time bid updates | `src/hooks/useRealtimeUpdates.ts` | **Mocked** | `MockWebSocket` class generates random bids on a timer; no server connection exists. |
| Marketplace — extend/cleanup contract actions | `src/hooks/mockApi.ts` | **Mocked** | `mockContractCall()` resolves `true` after a timeout. |
| Discovery page | `src/app/discovery` | **Live** | Real `GET /username/search\|trending\|recently-active\|featured` with category filtering, search, pagination, and resilient fallback. |
| Notification center | `src/app/notifications`, `src/components/NotificationCenterProvider.tsx` | **Partial** | UI is real but state is localStorage-only; not fed by the backend `notifications` module. |
| Webhook management | `src/app/webhooks` → backend `notifications` | **Live** | Full webhook CRUD/logs/redeliver/signature-verify family. |
| Developer settings (API keys) | `src/app/settings/developer` → backend `api-keys` | **Live** | Key CRUD, usage, rotate. |
| Profile settings | `src/app/settings` | **Mocked** | Save is a `// TODO: Call API to save profile`; nothing persists to the backend. |
| Team management | `src/app/settings/teams` | **Mocked** | In-memory member list and a hardcoded "admin" role; no backend module exists for teams. |
| Admin — system health | `src/components/admin/SystemHealth.tsx` → backend `health` | **Live** | `GET /health`. |
| Admin — feature flags & audit logs | `src/components/admin/*` → backend `feature-flags`, `audit` | **Partial** | Endpoints are real but called with **no auth header**, and the backend controllers are unguarded (mismatch #7 — known security gap). |
| WalletConnect session lifecycle | `src/lib/walletconnect/session.ts`, `src/hooks/useWalletConnectSession.ts` | **Experimental** | Connect/active/disconnect/expiry/reconnect implemented with stable error codes (`WC_SESSION_EXPIRED`, `WC_SESSION_DUPLICATE`, `WC_SESSION_UNAUTHORIZED`, `WC_SESSION_MALFORMED`, `WC_DEPENDENCY_UNAVAILABLE`). Gated by `walletconnect.sessions` flag; disabled on mainnet until audited. Disconnected-session recovery resumes via persisted session topic without re-signing or duplicating operations. |
| Fiat ramp deposit/withdraw reconciliation | `src/app/ramps`, `src/hooks/useFiatRampReconciliation.ts` → backend `fiat-ramps` | **Experimental** | Provider callbacks (SEP-24 deposit/withdraw status) are reconciled against local intents with idempotent callback handling and outage recovery. Stable error codes (`RAMP_CALLBACK_UNAUTHORIZED`, `RAMP_CALLBACK_DUPLICATE`, `RAMP_INTENT_EXPIRED`, `RAMP_CALLBACK_MALFORMED`, `RAMP_PROVIDER_UNAVAILABLE`). Gated by `fiat_ramps.reconciliation` flag; disabled on mainnet until anchor integration is audited. Self-custody preserved: reconciliation never signs or moves funds, only records provider-observed state. |

## Backend (`app/backend`)

NestJS app, ~38 modules wired in `src/app.module.ts`. Supabase (40 migrations) and Horizon integrations are real. `ReconciliationModule`, `NotificationsModule`, and `DeveloperModule` are skipped when `SUPABASE_URL` points at local Supabase.

| Flow / module | Owning path | Status | Notes |
|---|---|---|---|
| Usernames & public profiles | `src/usernames` | **Live** | Includes search/trending/featured endpoints that no client consumes yet. |
| Username on-chain claim reconciliation | `src/usernames` (`username-reconciliation.service.ts`, `username-reconciliation.controller.ts`) | **Experimental** | Batch reconciliation of `claimed` usernames against Stellar Horizon. Accounts absent on-chain (404) are flagged for admin review (`ownership_status=flagged`). Transient Horizon errors are counted as `skipped` and are safely retryable via cursor. Results persisted to `username_reconciliation_runs` table. Endpoints: `POST /admin/username/reconciliation/run`, `GET /admin/username/reconciliation/status/:username`, `POST /admin/username/reconciliation/unflag/:username`. All admin endpoints require `X-API-Key` with `admin` scope. Gated by `username.claim_reconciliation` flag (dev/test only). Migration: `20260928000002`. Self-custody preserved: service is read-only against Horizon, never signs or moves funds. |
| Payment links (metadata, status, bulk, recurring, scam alerts) | `src/links` | **Live** | Recurring endpoints have no client consumer yet. |
| Transactions (Horizon-backed, compose/build/simulate) | `src/transactions` | **Live** | Compose/simulate writes are **Experimental** (flag-gated, see below). `build` is a compatibility alias of `compose`. |
| Transaction submission, confirmation & retry orchestration | `src/transactions` (`submission`/`confirmation` services) | **Experimental** | `POST /transactions/submit` accepts a signed XDR, enforces idempotency via `Idempotency-Key`, and returns stable error codes (`DUPLICATE_TRANSACTION`, `TRANSACTION_EXPIRED`, `MALFORMED_XDR`, `UNAUTHORIZED`, `DEPENDENCY_UNAVAILABLE`). Confirmation polls Horizon with bounded backoff and retries only on transient failures; mainnet submission is gated by the `mainnet.transaction_submission` flag (disabled by default). Metrics/logs emit tx hash, status, latency, and attempt count without secrets. |
| Recent payments | `src/payments` | **Live** | Thin controller over `HorizonService.getPayments`; no client consumer yet. |
| Stellar (verified assets, path payments, quotes) | `src/stellar` | **Partial** | Assets and path previews are Live; the quote **preflight is a stub that always reports feasible** (`quote.service.ts` L141). |
| Analytics (report, export, time-series) | `src/analytics` | **Live** | — |
| API keys | `src/api-keys` | **Live** | — |
| Notifications & webhooks | `src/notifications` | **Live** | Disabled in local dev (local Supabase check in `app.module.ts`). |
| Observability: SLOs, error budgets, alerts, dependency probes, tracing | `src/observability` | **Live** | Five SLOs across the payment/link/indexing/notification paths with burn-rate classification, six alert rules with `for`-clause semantics and per-rule runbooks, six dependency readiness probes with criticality weighting, and W3C trace-context propagation on every request. Read-only surfaces are `GET /admin/observability/{slo,alerts,dependencies}` (admin scope). SLIs derive from the existing `/metrics` registry, so there is no second source of truth. See [OBSERVABILITY-OPERATIONS.md](./OBSERVABILITY-OPERATIONS.md). |
| Operator replay of notification/webhook deliveries | `src/observability/replay` | **Experimental** | `GET`/`POST /admin/observability/replay/:publicKey/:channel/:eventType/:eventId` (admin scope). Refuses to send a duplicate (`OPERATOR_REPLAY_ALREADY_DELIVERED`), enforces the existing replay cooldown/quota, and audits every attempt. **Mainnet blocked** by the `mainnet.operator_replay` flag (disabled by default). Replay re-sends a notification only — it never moves funds and cannot affect INV-01..INV-10. |
| Marketplace | `src/marketplace` | **Live** | Listings/detail only — no bids or real-time endpoints exist (frontend mocks those, see above). |
| Receipts | `src/receipts` | **Partial** | `receipts.service.ts` L206: `// TODO: replace with actual Supabase/database call`. |
| Reconciliation | `src/reconciliation` | **Partial** | Horizon-observed counts are placeholders that mirror expected values (`reconciliation.service.ts` L403–404) — it cannot detect real divergence yet. Disabled in local dev. |
| Fiat ramps (SEP-24 deposit/withdraw, KYC) | `src/fiat-ramps` | **Partial** | Anchor list and SEP-10 auth are real; interactive URLs are provider-issued. Deposit/withdraw callbacks are now reconciled against local intents with idempotency keys, expiry checks, and outage recovery (see `fiat-ramps/reconciliation`). Gated by `fiat_ramps.reconciliation` flag; disabled on mainnet until audited. |
| Contract registry | `src/contracts` | **Live** | ETag/304 support; admin-scoped writes/rollback. |
| Asset listing policy (issuers, verification, delisting) | `src/asset-listing` (policy + engine + store) → filtered into `src/asset-metadata` | **Experimental** | `GET /stellar/verified-assets` is policy-filtered when `assets.listing_policy` is on (flag defaults to dev/test only — **disabled on mainnet**); `GET /asset-listing/policy` publishes tiers/states/triggers; admin decisions at `POST /admin/asset-listing/decisions` (flag `assets.listing_decisions`, idempotency, audit, metrics). Policy of record: [policies/ASSET-LISTING-POLICY.md](policies/ASSET-LISTING-POLICY.md). |
| Privacy retention, deletion & user rights | `src/privacy` (retention + deletion-requests) | **Experimental** | `GET /privacy/retention-policy` is always available; signed proof-of-control intake (`POST /privacy/deletion-requests/challenge`, `POST /privacy/deletion-requests`, cancel, admin status) and the retention sweep (`POST /admin/privacy/retention/sweep`, dry-run default) are gated by `privacy.deletion_requests` / `privacy.retention_sweep` (dev/test only). Policy of record: [policies/DATA-RETENTION-PRIVACY-POLICY.md](policies/DATA-RETENTION-PRIVACY-POLICY.md). |
| Feature flags | `src/feature-flags` | **Live** | Supabase-backed with kill-switch semantics; controller is **unguarded** (mismatch #7). |
| Audit logs | `src/audit` | **Live** | Controller is **unguarded** (mismatch #7). |
| Ingestion (Soroban events) | `src/ingestion` | **Live** | Versioned event schemas with legacy-topic fallback. |
| Refunds, job queue, health, metrics | `src/refunds`, `src/job-queue`, `src/health`, `src/metrics` | **Live** | Mainnet refund initiation gated by `mainnet.refunds` flag (disabled by default). |
| Canonical API reference & OpenAPI | `src/docs`, `docs` | **Live** | Executable routes serve Swagger UI at `/docs`, spec export at `GET /docs/json` and `POST /docs/json`. Canonical reference published in [PUBLIC-API-REFERENCE.md](./PUBLIC-API-REFERENCE.md). |
| Session bootstrap (`GET /session/bootstrap`) | — (no module) | **Partial** | Mobile client is wired; backend route does not exist (mismatch #2). |
| Feedback intake (`POST /feedback`) | — (no module) | **Partial** | Mobile client is wired with export fallback; backend route does not exist (mismatch #3). |
| Financial authorization mutation testing | `src/auth`, `src/contracts`, `src/transactions` | **Live** | Mutation verification harness (`scripts/run-mutation-tests.js` & `stryker.config.json`) testing INV-01, INV-02, INV-07, and INV-08 authorization invariants. |
| Database migration forward & rollback verification | `supabase/migrations`, `scripts/verify-migrations.js` | **Live** | Automated CI verification testing monotonic sequencing, Phase 1 forward, Phase 2 reverse-order rollback, and Phase 3 forward re-apply idempotency. |
| Horizon performance regression testing | `src/transactions`, `src/payments` | **Live** | Benchmarks cold vs warm cache p95, 100-request concurrency throughput, pagination scaling, degraded-mode 429 fail-fast, and memory leak checks. |
| Cross-package TypeScript strictness & generated-type checks | `scripts/check-generated-types.js` | **Live** | Cross-package strict compilation with manifest schema validation and contract type alignment. |

## Mobile (`app/mobile`)

Expo/React Native app, 25 screens in `app/mobile/app`. ⚠️ All "Live" rows are subject to base-URL drift: services default to `localhost:3000` (frontend's port) and `payment-confirmation.tsx` falls back to `api.quickex.com` (wrong TLD) — set `EXPO_PUBLIC_API_URL` explicitly (mismatch #4).

| Flow | Owning module | Status | Notes |
|---|---|---|---|
| Transaction history | `services/transactions.ts` → backend `transactions` | **Live** | Real Horizon-backed data. |
| Link creation & asset picker | `services/link-metadata.ts`, `app/link-generator.tsx` → backend `links`, `stellar` | **Live** | Same contracts as frontend. |
| In-app notification center | `services/in-app-notifications.ts` → backend `notifications` | **Live** | Defensively handles two response shapes (mismatch #8). |
| Local notification store | `services/notifications.ts` | **Partial** | Real API when online with a wallet session; seeds `MOCK_NOTIFICATIONS` on offline/error/no-session paths. |
| Escrow confirmation (contract registry sync) | `app/payment-confirmation.tsx`, `services/contract-registry.ts` | **Partial** | **Broken today**: calls `/api/contracts/registry` but the backend serves `/contracts/registry` — every sync 404s (mismatch #1, highest-value small fix). |
| Session bootstrap | `services/session-bootstrap.ts`, `services/wallet-session.ts` | **Live** | Authenticated Bearer bootstrap, resilient degraded-mode fallback, and full session restoration. |
| In-app feedback | `services/feedback.ts`, `app/feedback.tsx` | **Partial** | No backend route; every submit silently degrades to the export path (mismatch #3). |
| Offline action queue | `services/offline-queue.ts` | **Live** | Queue machinery backed by AsyncStorage; full scenario test coverage in `__tests__/offline-background-restart.test.ts`. |
| Offline, background & restart resilience | `services/offline-queue.ts`, `services/background-sync.ts`, `services/wallet-session.ts` | **Live** | End-to-end scenario test coverage for offline queuing, background sync constraints, and app-restart recovery. |
| Contacts, security center, wallet session, local data | `services/contacts.ts`, `services/security*.ts`, `services/wallet-session.ts` | **Live** | Deliberately device-local (AsyncStorage/SecureStore); no backend sync by design. |
| Push notification token lifecycle | `services/push-notifications.ts` | **Live** | Registration, rotation, and revocation with offline fallback. |
| Share receipt | `src/screens/ReceiptScreen.tsx` | **Live** | Builds a *web* share URL; does not consume the backend `GET /v1/receipts/*` API (which has no client consumer yet). |
| Debug screens (deep-link, notification, offline-queue inspector, QA checklist) | `app/*-debug.tsx`, `app/qa-smoke-checklist.tsx` | **Experimental** | Developer tooling; hidden in production+mainnet builds. |

## CI & Developer Tooling

| Capability | Owning file / module | Status | Notes |
|---|---|---|---|
| DevContainer reproducible toolchain | `.devcontainer/Dockerfile`, `scripts/verify-devcontainer.sh` | **Live** | Provisions Node 20 LTS, pnpm, Rust toolchain with wasm32 Soroban target, and Stellar CLI cleanly. |
| Affected-package CI matrix execution | `.github/workflows/ci.yml`, `turbo.json` | **Live** | Parallel matrix execution with Turbo caching (`.turbo/cache`) scoped to affected packages against base ref. |
| Release-quality scorecard generator | `scripts/generate-release-scorecard.mjs`, `.github/workflows/ci.yml` | **Live** | Generates weighted quality score (A+/A/B/C/F), emits `release-scorecard.md`/`json`, and attaches to CI summary and build artifacts. |


## Contract (`app/contract`)

Monolithic Soroban contract `QuickexContract` (`contracts/quickex/src/lib.rs`). Deployed to **testnet** (ID via env / contract registry); **mainnet deployment is post-audit and has not happened** — see [MVP-CONTRACT-SCOPE.md](./MVP-CONTRACT-SCOPE.md).

| Capability | Owning module | Status | Notes |
|---|---|---|---|
| Escrow deposit / withdraw / commitments | `src/escrow.rs`, `src/commitment.rs`, `src/escrow_id.rs` | **Live** | Testnet only; extensive test suite (unit, fuzz, bench, upgrade). Complete state machine with all valid transitions: Created→Pending→Spent, Created→Pending→Refunded, Created→Pending→Disputed→Spent/Refunded. |
| Fee routing (basis points, per-asset overrides) | `src/fee` modules | **Live** | Static fees only. |
| Pause policy, emergency mode, admin/roles | `src/admin.rs`, `src/pause_policy.rs` | **Live** | Emergency mode is irreversible by design. |
| `create_escrow` counter endpoint | `src/lib.rs` (`create_escrow`) | **Mocked** | Only increments a counter; `_from`/`_to`/`_amount` params are reserved and ignored. |
| Oracle-priced dynamic fees | `src/oracle.rs` | **Mocked** | Explicit MVP stub; fees fall back to static basis points (deferred per scope doc). |
| Custom nonces/signatures, dispute arbitration, on-chain X-Ray privacy, hook registry | — | **Experimental** | Deliberately deferred out of MVP scope; partial primitives exist (privacy level storage, nonce checks) but are not product-complete. |
| M-of-N multisig governance | `.kiro/specs/governance-model-v1`, `app/contract/contracts/quickex/src/admin.rs` | **Live** | Production-ready role split and threshold-based governance controls are documented and aligned with the deployment playbook; admin, deployer, operator, and pauser responsibilities are separated, with governance action events and rehearsal artifacts captured. |
| Upgrade rehearsal and emergency drill evidence | `app/contract/scripts/testnet-upgrade-rehearsal.sh`, `app/contract/docs/TESTNET_UPGRADE_REHEARSAL.md` | **Live** | Automated pre/post contract metadata capture, local upgrade invariant checks, and rehearsal artifacts are recorded for release governance and emergency rollback drills. |
| SAC asset compatibility matrix | `.kiro/specs/sac-asset-compatibility-matrix` | **Experimental** | Spec formalizes existing `SUPPORTED_ASSETS` validation; not yet implemented as specified. |

## Governance & policy (documentation and enforcement)

| Capability | Owning path | Status | Notes |
|---|---|---|---|
| Governance hub + policies | `docs/GOVERNANCE.md`, `docs/policies/*.md` + `docs/policies/data/*.json` | **Live** | Policy of record for listing, retention/privacy and a11y/localization; each has a machine-readable companion that the backend mirrors (unit-tested for equality) |
| Architecture decision records | `docs/adr/NNNN-*.md` + index | **Live** | Six `Accepted` records cover custody, monolithic contract, mainnet gating, irreversible pause, static fees, registry rollback ([adr/README.md](adr/README.md)) |
| Governance gate (CI) | `scripts/governance/check.mjs` (+ `__tests__`) | **Live** | Dependency-free, offline; runs in `.github/workflows/ci.yml` and validates docs ↔ JSON ↔ code drift, ADR format/index, and i18n key parity against a ratcheted baseline |

## Feature-flag gates (Experimental switchboard)

Defaults from `app/backend/src/feature-flags/feature-flags.service.ts`:

| Flag | Default | Gates |
|---|---|---|
| `testnet.contract_writes` | enabled | `POST /transactions/compose\|build\|simulate`, `POST /stellar/soroban-preflight` |
| `mainnet.contract_writes` | **disabled** | All Soroban writes on mainnet |
| `mainnet.refunds` | **disabled** | Refund initiation on mainnet |
| `mainnet.dispute_actions` | **disabled** | Escrow dispute actions on mainnet |
| `assets.listing_policy`, `assets.listing_decisions` | enabled in dev/test, **disabled in production/mainnet** | Asset listing policy enforcement and governed delisting (see [policies/ASSET-LISTING-POLICY.md](policies/ASSET-LISTING-POLICY.md)) |
| `privacy.deletion_requests`, `privacy.retention_sweep` | enabled in dev/test, **disabled in production/mainnet** | Signed deletion requests and the retention sweep (see [policies/DATA-RETENTION-PRIVACY-POLICY.md](policies/DATA-RETENTION-PRIVACY-POLICY.md)) |
| `bulk_invoicing_v2`, `bulk_link_generation` | enabled | Generator bulk flows |
| `username.claim_reconciliation` | enabled in dev/test, **disabled in production/mainnet** | On-chain username claim reconciliation against Horizon; flags accounts with no active Stellar account (issue #193) |

A separate env-var rollback guard exists at `app/backend/flags.js` (`FEATURE_<NAME>=true`); it is unrelated to the flags module above.

## Contributor notes — do not rely on these yet

1. **Fiat on/off-ramps** (`app/backend/src/fiat-ramps`) — everything is fabricated, including the SEP-24 interactive URLs. Do not build UI assuming real anchor behavior.
2. **Marketplace bids / real-time updates** — there is no backend or WebSocket server behind them; the frontend generates the data locally.
3. **Frontend payment signing** — `ActivePaymentState.tsx` produces a fake XDR. No transaction is actually signed or submitted from that state.
4. **Reconciliation results** — observed values mirror expected values, so "everything reconciles" is not evidence of correctness.
5. **Stellar quote preflight** — always reports feasible; do not treat it as a real feasibility check.
6. **Mobile escrow registry sync** — 404s today due to the `/api` path prefix (mismatch #1). Fix the path before building on it.
7. **`admin/feature-flags` and `admin/audit`** — unguarded endpoints; adding guards must land together with auth-header changes in the frontend admin pages (mismatch #7).
8. **Mainnet anything on-chain** — the contract is not deployed to mainnet and all `mainnet.*` flags default to disabled. Treat all on-chain flows as testnet-only.
9. **Frontend discovery / profile settings / teams pages** — pure scaffolding on mock or in-memory data.
10. **Everything in `.kiro/specs/`** — requirements documents, not shipped behavior.

## How to use this map

- **Picking an issue?** "Mocked" rows paired with an existing Live backend module (e.g., discovery page vs the real `username/*` endpoints) are the highest-leverage wiring tasks. See [CONTRIBUTOR-CAPABILITY-SELECTION-GUIDE.md](./CONTRIBUTOR-CAPABILITY-SELECTION-GUIDE.md) for detailed selection guidance.
- **Building on a flow?** Anything not marked **Live** needs the notes column read first; **Partial** rows tell you exactly which segment is missing.
- **Promoting a capability to Live?** Follow the 9-point checklist in [CONTRIBUTOR-CAPABILITY-SELECTION-GUIDE.md](./CONTRIBUTOR-CAPABILITY-SELECTION-GUIDE.md).
- **Preparing for Mainnet?** Verify the five promotion gateways and multisig approvals defined in [MAINNET-PROMOTION-AND-GOVERNANCE.md](./MAINNET-PROMOTION-AND-GOVERNANCE.md).
- **Changing a flow's status?** Update the relevant row **in the same PR**, using only the four status terms defined above. If the change also touches endpoint wiring, update [BACKEND-CLIENT-CONTRACT-MAP.md](./BACKEND-CLIENT-CONTRACT-MAP.md) too.
