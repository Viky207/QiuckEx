# Development Setup

## Environment

Copy the provided environment template.

```bash
cp .env.example .env
```

Fill in all required credentials before starting the application.

---

## Backend

Install dependencies.

```bash
npm install
```

Run migrations.

```bash
pnpm run db:verify-migrations
```

Verify migrations forward and rollback:
```bash
pnpm run db:verify-migrations
```

Run mutation testing for financial authorization:
```bash
pnpm run test:mutation
```

Run Horizon performance regression tests:
```bash
pnpm run test:perf:horizon
```

Run cross-package generated type checks:
```bash
pnpm run check:generated-types
```

Start development.

```bash
npm run dev
```

---

## Rust Contracts

Compile contracts.

```bash
cargo build
```

Execute tests.

```bash
cargo test
```

Lint.

```bash
cargo clippy --all-targets --all-features
```

Format.

```bash
cargo fmt
```

---

## Architecture & Governance Guides

Before starting work, consult these reference documents:

- **[CAPABILITY-MAP.md](./CAPABILITY-MAP.md)**: Status of all features (Live vs Partial vs Mocked vs Experimental).
- **[CONTRIBUTOR-CAPABILITY-SELECTION-GUIDE.md](./CONTRIBUTOR-CAPABILITY-SELECTION-GUIDE.md)**: Decision tree for choosing issues and criteria for advancing capabilities to Live.
- **[BACKEND-CLIENT-CONTRACT-MAP.md](./BACKEND-CLIENT-CONTRACT-MAP.md)**: Client-to-backend endpoint routing, payload definitions, and known mismatches.
- **[PUBLIC-API-REFERENCE.md](./PUBLIC-API-REFERENCE.md)**: Canonical reference of all public and authenticated API routes.
- **[CUSTODY-TRUST-THREAT-MODEL.md](./CUSTODY-TRUST-THREAT-MODEL.md)**: Non-custodial security model, key boundaries, and threat mitigations.
- **[INVARIANTS.md](./INVARIANTS.md)**: Core financial and state-machine invariants that must never be violated.
- **[MAINNET-PROMOTION-AND-GOVERNANCE.md](./MAINNET-PROMOTION-AND-GOVERNANCE.md)**: Production promotion criteria, multisig governance, and emergency runbooks.

---

## Before Opening a Pull Request

Verify that:

- The project builds successfully.
- Database migrations are up to date.
- Rust tests pass (`cargo test`).
- TypeScript tests pass (`npm test`).
- Linting and secret scanning pass (`./scripts/secret-scan.sh --verify`).
- The documentation gate passes (`node scripts/docs-check/check.mjs`) if you added or changed a controller, an `EXPO_PUBLIC_*` variable, or the OpenAPI document. A new route that nobody documented is a 404 waiting to happen.
- If you touched `.github/workflows/`, the permission gate passes (`npm run check:workflow-permissions` and `npm run test:workflow-permissions`). See [CI-TOKEN-PERMISSIONS.md](./CI-TOKEN-PERMISSIONS.md) before adding a write scope.
- Relevant capability maps and contract maps are updated in the same PR.
- Record assumptions about network, custody, and backward compatibility in the PR description.

## Running the backend locally

`scripts/local-dev/bootstrap.sh` brings up a local Supabase and Redis and seeds
deterministic fixtures, so you can work against real services instead of mocks:

```bash
./scripts/local-dev/bootstrap.sh
```

It reports every missing prerequisite in one pass, waits for Postgres, applies the
migrations, seeds idempotent fixtures, and prints the values to export. Redis is
optional — the backend falls back to in-memory caching when `REDIS_URL` is unset.
The fixtures are synthetic and contain **public keys only**; no signing material is
ever stored, consistent with self-custody (ADR 0001). Full details and
troubleshooting: [../scripts/local-dev/README.md](../scripts/local-dev/README.md).