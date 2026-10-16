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

4. **Contracts (`app/contract`)** — Cargo/Rust. Add `app/contract/.env` if you need contract-specific variables (e.g. `STELLAR_NETWORK=testnet`).

5. Fund a testnet account at [laboratory.stellar.org](https://laboratory.stellar.org) so you can claim a username and exercise payment flows. Never reuse a mainnet secret key in a local checkout.

### Running Locally
1. Launch all JS services using Turborepo:
   ```
   pnpm dev
   ```
   This starts the frontend (`app/frontend`, http://localhost:3000) and the backend (`app/backend`, http://localhost:4000). To run one app only:
   ```bash
   pnpm --filter frontend dev
   pnpm --filter @quickex/backend dev
   ```
2. Check backend health: `curl http://localhost:4000/health`.
3. For the mobile app:
   ```
   cd app/mobile && npx expo start        # then press i / a, or use npx expo start --ios
   ```
4. For contracts (testing/deploying):
   ```
   cd app/contract && cargo test  # Run unit tests
   # Deploy to testnet: use the Soroban CLI per the Stellar Soroban docs
   ```

Connect your wallet in the app to claim a username and test features.

### Testing

The root `test` script delegates to Turborepo, so `pnpm <task>` is the canonical entry point:

1. Lint and type-check the whole workspace:
   ```bash
   pnpm lint
   pnpm type-check
   ```
   Scope to one app with `pnpm --filter @quickex/backend lint`, `pnpm --filter @quickex/backend type-check`, etc.

2. Backend tests (Jest). These are the tests that actually execute today — the `frontend` and `mobile` packages currently no-op their `test` script so the monorepo-wide run stays green:
   ```bash
   pnpm test                                    # all backend Jest suites
   pnpm --filter @quickex/backend test:unit     # unit only
   pnpm --filter @quickex/backend test:int      # integration only
   pnpm --filter @quickex/backend test:e2e      # e2e
   pnpm --filter @quickex/backend test:fuzz     # property/fuzz suites
   ```
   E2E and smoke suites talk to Horizon/Soroban and need `STELLAR_NETWORK=testnet` plus reachable endpoints; see [docs/RUNTIME-CONFIG-MATRIX.md](docs/RUNTIME-CONFIG-MATRIX.md).

3. Contract tests (Rust, outside pnpm):
   ```bash
   cd app/contract && cargo test
   ```

4. Secret scanning:
   ```bash
   pnpm secret-scan:verify
   ```

4. Validate a release candidate with one command — the same gate CI runs:
   ```bash
   pnpm rc:validate          # full gate
   pnpm rc:validate:quick    # fast subset while iterating
   pnpm rc:stages            # list the stages
   ```
   See [docs/RELEASE-CANDIDATE-VALIDATION.md](docs/RELEASE-CANDIDATE-VALIDATION.md).

### Deployment
Deployment is automated for most components, but requires platform-specific configuration:

1. **Frontend and Backend**:
   - Frontend: connect the GitHub repository to Vercel via the dashboard. Pushes to `main` trigger auto-deploys; set a custom domain in the Vercel project settings.
   - Backend: `.github/workflows/cd.yml` runs the release pipeline on `main` (release metadata → dependency install → migrations → deploy hook). Migration execution is delegated to `.github/actions/run-migrations`, and the composite deploy + health check lives in `.github/actions/deploy-app`.
   - Configure the platform secrets the workflows expect (`PRODUCTION_DATABASE_URL`, `DEPLOY_TOKEN`, `APP_URL`) as GitHub **environment secrets**, never as committed files.

2. **Mobile (Expo/EAS)**
   - Install Expo CLI if needed: `npm install -g @expo/cli`.
   - For internal testing builds, use EAS and the GitHub workflow defined in `./.github/workflows/mobile-release.yml`.
   - From `app/mobile`: run `npx eas build --profile production --platform android` or `npx eas build --profile production --platform ios` when credentials are configured.
   - Ensure `EAS_TOKEN` is stored in GitHub secrets and not exposed in logs.

3. **Contracts (Soroban)**
   - CI for the Rust workspace lives in `.github/workflows/contract.yml`.
   - For testnet: `cd app/contract && soroban contract deploy --network testnet`.
   - The contract is **not deployed to mainnet**; every `mainnet.*` feature flag defaults to disabled. See [docs/CAPABILITY-MAP.md](docs/CAPABILITY-MAP.md) and the checklist in [RELEASE_READINESS_CHECKLIST.md](RELEASE_READINESS_CHECKLIST.md).

Before promoting anything to production, work through [RELEASE_READINESS_CHECKLIST.md](RELEASE_READINESS_CHECKLIST.md) and follow the promotion procedure in [RELEASE_PROMOTION_FLOW.md](RELEASE_PROMOTION_FLOW.md).

Automated release-gate checks live in [`scripts/rc-validate.sh`](scripts/rc-validate.sh) — run it before promoting, and see [docs/RELEASE-CANDIDATE-VALIDATION.md](docs/RELEASE-CANDIDATE-VALIDATION.md) for the stage list and exit-code contract. Promotion itself follows [RELEASE_PROMOTION_FLOW.md](RELEASE_PROMOTION_FLOW.md).

## Usage
1. **Claim Username**: Connect your wallet in the app, select a name, and confirm the on-chain transaction.
2. **Generate Link**: In the dashboard, input amount, memo, and privacy options, then copy the generated link or QR code.
3. **Receive Payment**: Share the link; the payer clicks or scans to send funds directly to your wallet.
4. **Enable Privacy**: Toggle X-Ray mode to shield transactions (deploys Rust contract on mainnet).

## Contributing
Contributions are welcome and encouraged to help evolve QuickEx! To get started:

- **Report Issues**: Use GitHub Issues with one of the templates in `.github/ISSUE_TEMPLATE`. Include reproduction steps, environment details, and screenshots where possible.
- **Propose Features**: Start a Discussion thread to align on ideas before coding.
- **Submit Pull Requests**:
  1. Fork the repository and create a branch following the convention in [CONTRIBUTING.md](CONTRIBUTING.md) (`feat/`, `fix/`, `docs/`, `chore/`).
  2. Implement changes, ensuring they pass linting and tests.
  3. Commit with clear [Conventional Commits](https://www.conventionalcommits.org/) messages (e.g. `feat: add multi-asset swap support`).
  4. Push and open a PR against `main`. Reference the issue number in the PR body (`closes #123`) so it auto-closes on merge.
- **Monorepo Best Practices**:
  - Use `pnpm build`, `pnpm lint`, `pnpm type-check`, and `pnpm test` from the repository root; these delegate to Turborepo across all workspace packages.
  - Filter by **package name**, not directory: `pnpm --filter @quickex/backend test:unit`, `pnpm --filter frontend lint`.
  - `app/contract` sits outside the pnpm workspace — use `cargo test` / `cargo clippy` there.
  - If a change alters what is actually shipped, update the matching row in [docs/CAPABILITY-MAP.md](docs/CAPABILITY-MAP.md) in the same PR.
- **Dependency review**: PRs that introduce new npm or Cargo dependencies are automatically checked for high/critical CVEs and disallowed licenses. Any exception must be recorded with a GHSA ID and a written justification. See [docs/policies/DEPENDENCY-PROVENANCE-POLICY.md](docs/policies/DEPENDENCY-PROVENANCE-POLICY.md).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution workflow.

## License
This project is licensed under the MIT License.

## Support & Community
- Join the [QuickEx Discord](https://discord.gg/gBmApTNVV) for real-time help, discussions, and updates.
- Have questions? Open an issue or DM @pulsefy.

Built with ❤️ by Pulsefy. Powered by Stellar. 🚀

## Handsoff notes

<!-- handsoff-issue-374 -->
- #374: bug(contract): Escrow release panics when recipient address is a contract account
