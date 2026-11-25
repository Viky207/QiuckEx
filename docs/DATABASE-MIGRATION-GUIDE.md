# Database Migration Guide

This guide defines the contributor workflow for authoring database migrations, writing rollback scripts, and reviewing schema changes. It applies to all migrations under `app/backend/migrations/` and the tooling in `app/backend/scripts/` and `scripts/`.

> **Before you start:** verify the current migration tooling and the linked capability map. If the tooling described here does not match what is in the repository, stop and update this guide as part of your change.

## 1. Migration naming

- File name format: `YYYYMMDDHHMMSS_<name>.sql`
  - `YYYYMMDDHHMMSS` is a 14-digit UTC timestamp (e.g. `20240115143000`).
  - `<name>` is a short, lowercase, snake_case description of the change (e.g. `add_user_email_index`).
- One logical change per migration. Do not bundle unrelated schema and data changes.
- Migrations are applied in timestamp order. Never edit a migration that has already been applied to a shared environment — add a new one instead.
- Every forward migration **must** have a matching rollback script (see [Rollback safety](#4-rollback-safety)).

## 2. Locking considerations

Long-running or lock-heavy migrations can block production traffic. Before merging:

- [ ] Identify the locks the migration takes (e.g. `ACCESS EXCLUSIVE` for `ALTER TABLE`, `SHARE` for index builds).
- [ ] Prefer non-blocking forms where supported:
  - `CREATE INDEX CONCURRENTLY` instead of `CREATE INDEX`.
  - `ALTER TABLE ... ADD COLUMN` with a nullable column or a default that does not rewrite the table.
  - `ALTER TABLE ... VALIDATE CONSTRAINT` after adding `NOT NULL`/`CHECK` constraints as `NOT VALID`.
- [ ] Set a lock timeout so a blocked migration fails fast rather than queueing behind traffic:
  ```sql
  SET lock_timeout = '5s';
  SET statement_timeout = '60s';
  ```
- [ ] Split large table rewrites into separate migrations (add column → backfill → add constraint).
- [ ] Document any expected lock duration in the migration header comment.

## 3. Data backfill

- [ ] Backfill in **batches** (e.g. 1,000–10,000 rows per statement) to avoid long transactions and lock escalation.
- [ ] Make backfills **idempotent** (`WHERE <column> IS NULL` or equivalent) so re-running is safe.
- [ ] Keep schema changes and data backfills in separate migrations when the backfill is large.
- [ ] Do not reference application code paths in migrations; use plain SQL.
- [ ] Never log secrets, signing material, or unnecessary personal data during backfill.

## 4. Rollback safety

Every migration must have a rollback counterpart. Rollback scripts are applied with `scripts/rollback-migration.sh`.

- [ ] Provide a rollback script for each forward migration.
- [ ] **A migration without a rollback counterpart must be flagged** in its header (see [Irreversible changes](#5-irreversible-data-changes)) and reviewed by a second maintainer.
- [ ] Rollbacks must be safe to run against the schema state produced by the forward migration — test them.
- [ ] Rollbacks that drop data (columns, tables, rows) are destructive. Call this out explicitly in the PR description.

### Rollback tooling

```bash
# Preview what a rollback would do without applying it
scripts/rollback-migration.sh --dry-run

# Roll back the most recent N migrations
scripts/rollback-migration.sh --steps 2

# Roll back to a specific migration (exclusive of the target)
scripts/rollback-migration.sh --target 20240115143000
```

- Always run `--dry-run` first and review the output.
- `--steps` and `--target` are mutually exclusive; pick one.
- Confirm the target environment before running a non-dry-run rollback.

## 5. Irreversible data changes

Some changes cannot be safely reversed (e.g. dropping a column with data, destructive backfills, type narrowing that loses precision). These must be **marked explicitly** with a required annotation in the migration header:

```sql
-- IRREVERSIBLE: true
-- REASON: Drops legacy `phone` column; data is not recoverable after rollback.
```

Rules:

- [ ] Any migration that drops or overwrites data **must** carry `-- IRREVERSIBLE: true` and a `-- REASON:` line.
- [ ] A migration **without a rollback counterpart must be flagged** with `-- IRREVERSIBLE: true` even if the schema change itself is reversible.
- [ ] Irreversible migrations require a second maintainer review and a backup/export step documented in the PR.
- [ ] Do not mark a migration irreversible to avoid writing a rollback — write the rollback whenever it is feasible.

## 6. Verification commands

Run these before opening a PR and again after applying to a staging environment.

```bash
# Apply migrations and run the schema smoke test
node app/backend/run-migration-supabase.js --smoke-test

# Verify migration state, ordering, and checksums
node app/backend/scripts/verify-migrations.js

# Preview a rollback (always dry-run first)
scripts/rollback-migration.sh --dry-run
```

- [ ] `run-migration-supabase.js --smoke-test` passes with no errors.
- [ ] `verify-migrations.js` reports no drift, missing rollbacks, or ordering issues.
- [ ] `rollback-migration.sh --dry-run` shows the expected inverse operations for your migration.
- [ ] Rollback has been exercised against a scratch database and re-applied cleanly.

## 7. Review checklist

Use this checklist when reviewing a migration PR:

- [ ] File name matches `YYYYMMDDHHMMSS_<name>.sql`.
- [ ] One logical change; no unrelated edits.
- [ ] Locking impact documented; non-blocking forms used where possible.
- [ ] Backfill is batched and idempotent.
- [ ] Rollback script present, or migration flagged `-- IRREVERSIBLE: true` with a reason.
- [ ] Irreversible data changes marked explicitly and reviewed by a second maintainer.
- [ ] `run-migration-supabase.js --smoke-test` and `verify-migrations.js` pass.
- [ ] `rollback-migration.sh --dry-run` output reviewed.
- [ ] No secrets, signing material, or unnecessary personal data in migration or logs.
- [ ] Directly affected API, capability, operational, or user documentation updated.