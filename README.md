# QuickEx

<img width="1024" height="1024" alt="quickex no-bg (1)" src="https://github.com/user-attachments/assets/551fc54f-72ed-4fa9-9b8d-5516d8457ca8" />

QuickEx is a fast, privacy-focused payment link platform built on the Stellar blockchain. It enables users to create unique, shareable usernames (e.g., `quickex.to/yourname`) and generate instant payment requests for USDC, XLM, or any Stellar asset. Payments can be received via QR code or direct wallet integration—no apps required—leveraging Stellar's sub-second settlements and optional X-Ray privacy for shielded transactions (mainnet now live). With low fees (<0.01¢), it's designed for instant, borderless transfers.

This tool is ideal for freelancers invoicing clients, creators accepting tips, individuals handling remittances, or anyone facilitating global P2P payments. Whether you're a solo developer sharing a quick link for a gig or a small business streamlining donations, QuickEx prioritises simplicity, self-custody, and security without intermediaries.

## Features

### Core
- **Unique Username Links**: Claim a permanent `quickex.to/yourname` for easy sharing.
- **One-Click Link Generator**: Specify amount, memo, and privacy settings to create links like `quickex.to/yourname/50`.
- **QR Code & Wallet Integration**: Auto-opens Freighter or Lobstr for seamless payments.
- **Real-Time Dashboard**: Tracks earnings, history, and totals via Horizon API.

### Privacy & Security
- **X-Ray Privacy Toggle**: Uses ZK proofs to hide amounts/senders (testnet ready; mainnet live since January 22, 2026).
- **Scam Alerts**: Flags suspicious links (e.g., no memo or unusual patterns).
- **Self-Custody**: Funds route directly to your wallet—no central holding.

### Advanced (v2+)
- Multi-asset support with auto-swap.
- Recurring/subscription links.
- Fiat on/off-ramps (MoneyGram, Banxa).
- Notifications (email/Telegram)..

## Empty States

Charts, transaction lists, and notification panels distinguish four empty states so users can tell whether data is absent, filtered out, restricted, or temporarily unavailable. Each state explains the reason and offers only a valid next action; none of them fabricate sample financial data.

| State | When it appears | What the user sees | Valid next action |
| --- | --- | --- | --- |
| **First-use empty** | The account has no data yet (no transactions, no notifications, no chart history). | A short explanation that nothing has been recorded yet. | Create a payment link or share your username to receive the first payment. |
| **Filtered empty** | Data exists but the active filters/search exclude all of it. | A note that no results match the current filters. | Clear or adjust the filters. |
| **Permission-limited** | The wallet is not connected or lacks the scope needed to read the data. | A note that access is limited by wallet permissions. | Connect or re-authorise the wallet. |
| **Service-unavailable** | The API or Horizon is unreachable or returning errors. | A note that data could not be loaded right now. | Retry the request. |

Loading is shown separately (skeleton/spinner) and is never presented as an empty state, so a blank panel always carries a reason and an action.

## Tech Stack
- **Frontend**: Next.js 16 (`app/frontend`), Tailwind CSS, deployable to Vercel.
- **Backend**: NestJS 12 API (`app/backend`), Supabase (usernames/storage), Horizon API (transactions), Prometheus metrics via `prom-client`, Sentry.
- **Mobile**: React Native / Expo Router (`app/mobile`, iOS + Android).
- **Blockchain**: Stellar SDK, Soroban (Rust contracts in `app/contract` for privacy/escrow).
- **Wallet**: Freighter/Lobstr via WalletConnect.
- **Monorepo**: pnpm workspaces + Turborepo. `packages/*` is reserved for future shared libraries; no shared package is published today.

## Repository Structure
QuickEx is a pnpm/Turborepo monorepo. The workspace packages are everything under `app/`, declared in [`pnpm-workspace.yaml`](pnpm-workspace.yaml). Turborepo pipelines live in [`turbo.json`](turbo.json) and run across all workspace packages.

```
QiuckEx/
├── app/
│   ├── frontend/          # Next.js app (web dashboard and link generator), package "frontend"
│   ├── backend/           # NestJS API (usernames, links, payments, analytics), package "@quickex/backend"
│   ├── mobile/            # React Native / Expo app (iOS + Android), package "mobile"
│   └── contract/          # Soroban Rust contracts (privacy/escrow logic) — Cargo workspace, not a pnpm package
├── docs/                  # Capability map, contract map, invariants, architecture
├── scripts/               # Repository helper scripts (e.g. secret-scan.sh)
├── .github/workflows/     # CI, CD, smoke tests, contract and mobile release pipelines
├── turbo.json             # Turborepo task graph (dev, build, lint, type-check, test)
├── pnpm-workspace.yaml    # Workspace config: packages = app/*, packages/*
└── package.json           # Root package; delegates to Turborepo
```

Notes on the layout:

- There is **no `packages/` directory today**. `pnpm-workspace.yaml` already includes `packages/*` so shared libraries can be added later without a workspace change; until then, shared code stays inside the app that owns it.
- `app/contract` is a Rust/Cargo workspace and is **not** part of the pnpm workspace. Build and test it with `cargo`, not `pnpm`.
- Workspace package names are `frontend`, `@quickex/backend`, and `mobile`, so use `--filter @quickex/backend` (not `--filter app/backend`) in Turborepo commands. See [`app/*/package.json`](app) for the authoritative list.


## Setup Instructions

> New contributor? Start with the [contributor onboarding guide](docs/CONTRIBUTOR-ONBOARDING.md) for a clean setup, local payment flow, tests, and troubleshooting.

### Prerequisites
Before getting started, ensure you have the following installed:
- Node.js 20+ ([nodejs.org](https://nodejs.org)). This matches the version used in CI (`.github/workflows/ci.yml`).
- pnpm 10+ (`corepack enable pnpm` or `npm install -g pnpm`). The version is pinned as `packageManager` in the root `package.json`.
- A Stellar wallet (Freighter recommended; download from [freighter.app](https://freighter.app)).
- Supabase account (free tier; sign up at [supabase.com](https://supabase.com)).
- Git (for cloning).
- Rust toolchain + the `wasm32-unknown-unknown` target (only for `app/contract`; install via [rustup.rs](https://rustup.rs)).
- Expo (only for `app/mobile`; the project is Expo Router based, so no bare React Native CLI is required). See [Expo environment setup](https://docs.expo.dev/workflow/android-studio-emulator/).

### Installation & Local Development Setup
1. Clone the repository:
   ```bash
   git clone https://github.com/Viky207/QiuckEx.git
   cd QiuckEx
   ```

2. **Install workspace dependencies** (from the repository root — this installs `app/frontend`, `app/backend`, and `app/mobile`):
   ```bash
   pnpm install
   ```
   Start the local development servers (Frontend + Backend + Mobile, via Turborepo):
   ```bash
   pnpm dev
   ```

3. **Rust/Soroban setup** (only for `app/contract` — it is not part of the pnpm workspace):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   rustup default stable
   rustup target add wasm32-unknown-unknown
   ```
   Build the contracts locally:
   ```bash
   cd app/contract
   cargo build --target wasm32-unknown-unknown --release
   ```

### Environment Setup

Environment files are **per package**, not at the repository root.

1. **Backend (`app/backend`)** — NestJS. It validates its environment with Joi at startup (`app/backend/src/config/env.schema.ts`) and exits with the list of missing variables.
   ```bash
   cp .env.example app/backend/.env
   ```
   Then set at least:
   ```
   PORT=4000
   SUPABASE_URL=your_supabase_url
   SUPABASE_ANON_KEY=your_supabase_anon_key
   STELLAR_NETWORK=testnet
   ```
   - `PORT` defaults to **4000** in the Joi schema. The committed `.env.example` still shows `PORT=3000`, which collides with the Next.js dev server — override it to `4000` (or any free port) for local work.
   - `STELLAR_NETWORK` accepts `testnet` or `mainnet` and defaults to `testnet`. Supported assets are declared in `app/backend/src/config/stellar.config.ts` under `SUPPORTED_ASSETS`; add an asset by adding a native or issued entry there.
   - Mainnet-only behaviour is feature-gated: all `mainnet.*` flags in `app/backend/src/feature-flags/feature-flags.service.ts` default to **disabled**, so a local run cannot touch mainnet unless you explicitly enable them. See [docs/CAPABILITY-MAP.md](docs/CAPABILITY-MAP.md).
   - `.env.example` also lists `DATABASE_URL`, `JWT_SECRET`, `REDIS_URL`, and `STRIPE_*` keys. Persistence is Supabase-backed; PostgreSQL and Redis are not required for the core flows.

2. **Frontend (`app/frontend`)** — Next.js. Create `app/frontend/.env.local`:
   ```
   NEXT_PUBLIC_QUICKEX_API_URL=http://localhost:4000
   ```
   This defaults to `http://localhost:4000` already (`app/frontend/src/lib/api.ts`), so it is only needed when you point the app at another API.

3. **Mobile (`app/mobile`)** — Expo. Copy the root `RootApp.example.tsx` if you need a custom root, then:
   ```bash
   cd app/mobile && npx expo start
   ```

4. **Contracts (`app/contract`)** — Cargo/Rust. Build with `cargo` as shown above; no `.env` is required for local contract tests.
