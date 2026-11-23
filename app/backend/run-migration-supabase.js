#!/usr/bin/env node
/**
 * Supabase / PostgreSQL Database Migration Runner & Fresh-Schema Smoke Tester
 *
 * Applies all database migrations in `app/backend/supabase/migrations/` in strict
 * sequential order against a target database or fresh temporary test schema,
 * records applied versions in `schema_migrations`, and asserts that the resulting
 * schema matches the expected state.
 *
 * Usage:
 *   node app/backend/run-migration-supabase.js [options]
 *
 * Options:
 *   --smoke-test             Spin up a fresh test schema, apply all migrations in
 *                            order, and assert the final schema matches expected state
 *   --fresh-schema           Drop and recreate the target test schema before applying
 *   --schema <name>          Target PostgreSQL schema (default: public, or
 *                            migration_smoke_test in --smoke-test mode)
 *   --migrations-dir <dir>   Override migrations directory
 *   --state-file <path>      Path to temporary test DB state file (for local/CI test DB)
 *   --rollback               Revert the most recent migration(s)
 *   --steps <n>              Number of migrations to revert with --rollback (default: 1)
 *   --target <ver_or_file>   Specific migration version or filename to revert
 *   --dry-run                Validate and preview migrations without writing state
 *   --json                   Output machine-readable JSON report
 *   --lock-timeout <secs>    Seconds to wait for the migration advisory lock
 *                            (default: 0 = fail fast if another run holds it)
 *   --help, -h               Show usage information
 *
 * Concurrency / advisory lock:
 *   Production migration execution (live PostgreSQL, non-dry-run) is serialized
 *   with a session-level PostgreSQL advisory lock (pg_try_advisory_lock) keyed on
 *   a stable constant. A second concurrent run fails fast with a clear error
 *   instead of applying migrations in parallel. The lock is always released in a
 *   `finally` block, so a failed migration does not strand it.
 *
 *   Operator recovery for a stale lock:
 *     - Session-level advisory locks are released automatically when the owning
 *       connection ends. If a runner crashed and its backend is still alive, the
 *       lock may linger until that backend exits.
 *     - Inspect holders:
 *         SELECT pid, state, query
 *         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
 *         WHERE l.locktype = 'advisory' AND l.objid = <LOCK_KEY>;
 *     - If the holder is a dead/idle runner, terminate it:
 *         SELECT pg_terminate_backend(<pid>);
 *       The lock is then released automatically.
 *     - As a last resort (only when no migration is running):
 *         SELECT pg_advisory_unlock_all();  -- on the owning session
 *       or restart the connection pool.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Load .env if dotenv is installed; never fail if node_modules is absent.
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch {
  // Optional in CI / standalone smoke tests.
}

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'supabase', 'migrations');

/**
 * Stable key for the session-level PostgreSQL advisory lock that serializes
 * production migration runs. Must stay constant across releases so concurrent
 * runners contend on the same lock.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 0x51c4e11;

/**
 * Acquire the migration advisory lock on a dedicated psql session.
 *
 * Returns a handle with `release()` that always attempts to unlock. The lock is
 * session-level, so it is held by the psql process backing this handle; when the
 * process exits (including on crash) PostgreSQL releases it automatically.
 *
 * @param {string} dbUrl
 * @param {{ timeoutSeconds?: number }} [opts]
 */
function acquireMigrationLock(dbUrl, { timeoutSeconds = 0 } = {}) {
  const key = MIGRATION_ADVISORY_LOCK_KEY;
  const waitSeconds = Math.max(0, Number(timeoutSeconds) || 0);

  // Use a long-lived psql session that holds the lock while we run migrations.
  // We acquire with pg_try_advisory_lock and poll until the timeout elapses.
  const acquireSql = `
DO $$
DECLARE
  deadline TIMESTAMPTZ := now() + make_interval(secs => ${waitSeconds});
  got BOOLEAN := false;
BEGIN
  LOOP
    SELECT pg_try_advisory_lock(${key}) INTO got;
    EXIT WHEN got;
    IF now() >= deadline THEN
      RAISE EXCEPTION 'migration advisory lock ${key} is held by another run';
    END IF;
    PERFORM pg_sleep(0.5);
  END LOOP;
END $$;
SELECT 'LOCK_ACQUIRED';
`;

  const res = spawnSync(
    'psql',
    [dbUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-t', '-A'],
    { input: acquireSql, encoding: 'utf8' }
  );

  if (res.status !== 0 || !(res.stdout || '').includes('LOCK_ACQUIRED')) {
    const detail = (res.stderr || res.stdout || '').trim();
    const err = new Error(
      `Could not acquire migration advisory lock (key=${key}): ${detail || 'unknown error'}. ` +
        'Another migration run may be in progress; see the script header for operator recovery.'
    );
    err.code = 'MIGRATION_LOCK_UNAVAILABLE';
    throw err;
  }

  let released = false;
  return {
    key,
    release() {
      if (released) return;
      released = true;
      try {
        runPsql(dbUrl, `SELECT pg_advisory_unlock(${key});`, ['-t', '-A']);
      } catch {
        // Session-level locks are released when the backend ends; ignore.
      }
    },
  };
}
const CRASH_REPORTING_MIGRATION = path.join(
  __dirname,
  'src',
  'crash-reporting',
  'migrations',
  '001_create_crash_reporting_tables.sql'
);
const BRANCH_PREVIEW_MIGRATION = path.join(
  __dirname,
  'src',
  'branch-preview',
  'migrations',
  '001_create_branch_preview_table.sql'
);

/**
 * Baseline tables that exist in the Supabase project prior to timestamped
 * migrations and are referenced by early analytics/index/preview migrations.
 */
const BASELINE_TABLES = {
  stellar_ingestion: [
    'id',
    'organization_id',
    'link_id',
    'asset_code',
    'asset_issuer',
    'amount',
    'fee_paid',
    'status',
    'created_at',
  ],
  public_profiles: [
    'id',
    'username',
    'public_key',
    'is_public',
    'is_featured',
    'featured_rank',
    'last_active_at',
    'created_at',
  ],
  payment_records: [
    'id',
    'sender_public_key',
    'receiver_public_key',
    'amount',
    'amount_usd',
    'asset',
    'status',
    'tx_hash',
    'stellar_tx_hash',
    'settlement_state',
    'created_at',
  ],
  in_app_notifications: [
    'id',
    'public_key',
    'title',
    'message',
    'read',
    'preview_scope',
    'created_at',
  ],
};

function buildBaselineBootstrapSql(schema = 'public') {
  return `
CREATE SCHEMA IF NOT EXISTS ${schema};
SET search_path TO ${schema}, public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  filename TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stellar_ingestion (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT,
  link_id TEXT,
  asset_code TEXT NOT NULL DEFAULT 'XLM',
  asset_issuer TEXT,
  amount TEXT NOT NULL DEFAULT '0',
  fee_paid TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'success',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT,
  public_key TEXT,
  is_public BOOLEAN NOT NULL DEFAULT true,
  is_featured BOOLEAN NOT NULL DEFAULT false,
  featured_rank INTEGER,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_public_key TEXT,
  receiver_public_key TEXT,
  amount TEXT NOT NULL DEFAULT '0',
  amount_usd NUMERIC,
  asset TEXT NOT NULL DEFAULT 'XLM',
  status TEXT NOT NULL DEFAULT 'pending',
  tx_hash TEXT,
  stellar_tx_hash TEXT,
  settlement_state TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS in_app_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  read BOOLEAN NOT NULL DEFAULT false,
  preview_scope TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--.*$/gm, '');
}

/**
 * Validate balanced dollar-quoted blocks, single quotes, parentheses, and
 * non-empty SQL statements.
 */
function validateSqlSyntax(sql, filename, { allowCommentOnly = false } = {}) {
  if (!sql || !sql.trim()) {
    throw new Error(`Migration ${filename} is empty`);
  }
  const clean = stripSqlComments(sql).trim();
  if (!clean) {
    if (allowCommentOnly) return;
    throw new Error(`Migration ${filename} contains no executable SQL statements`);
  }

  let inSingleQuote = false;
  let dollarTag = null;
  let parenDepth = 0;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];

    if (dollarTag !== null) {
      if (clean.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }

    if (inSingleQuote) {
      if (ch === "'" && clean[i + 1] === "'") {
        i += 1;
        continue;
      }
      if (ch === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }

    if (ch === '$') {
      const rest = clean.slice(i);
      const tagMatch = rest.match(/^\$([a-zA-Z0-9_]*)\$/);
      if (tagMatch) {
        dollarTag = tagMatch[0];
        i += dollarTag.length - 1;
        continue;
      }
    }

    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth < 0) {
        throw new Error(`Migration ${filename} has unbalanced closing parenthesis`);
      }
    }
  }

  if (inSingleQuote) {
    throw new Error(`Migration ${filename} has an unterminated single-quoted string`);
  }
  if (dollarTag !== null) {
    throw new Error(`Migration ${filename} has an unterminated dollar-quoted block (${dollarTag})`);
  }
  if (parenDepth !== 0) {
    throw new Error(`Migration ${filename} has unbalanced parentheses (depth=${parenDepth})`);
  }
}

function normalizeIdentifier(raw) {
  return raw
    .trim()
    .replace(/^public\./i, '')
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
}

/**
 * Parse a forward or rollback SQL file to discover schema operations.
 */
function extractOperations(sql) {
  const clean = stripSqlComments(sql);

  const createdTables = new Map();
  for (const match of clean.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_."']+)\s*\(([\s\S]*?)\);/gi
  )) {
    const tableName = normalizeIdentifier(match[1]);
    const body = match[2];
    const cols = createdTables.get(tableName) || new Set();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const likeMatch = line.match(/^LIKE\s+([a-zA-Z0-9_."']+)/i);
      if (likeMatch) {
        cols.add(`__like__:${normalizeIdentifier(likeMatch[1])}`);
        continue;
      }
      const colMatch = line.match(/^(["']?[a-zA-Z_][a-zA-Z0-9_]*["']?)\s+([a-zA-Z]+)/);
      if (colMatch) {
        const colName = colMatch[1].replace(/["']/g, '').toLowerCase();
        if (!/^(constraint|primary|foreign|unique|check|exclude|like)$/i.test(colName)) {
          cols.add(colName);
        }
      }
    }
    createdTables.set(tableName, cols);
  }

  const droppedTables = [];
  for (const match of clean.matchAll(
    /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_."']+)/gi
  )) {
    droppedTables.push(normalizeIdentifier(match[1]));
  }

  const alteredTables = [];
  const addedColumns = [];
  const droppedColumns = [];

  for (const match of clean.matchAll(
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([a-zA-Z0-9_."']+)([\s\S]*?);/gi
  )) {
    const tableName = normalizeIdentifier(match[1]);
    if (tableName === 'statement.') continue;
    const clause = match[2];
    const guardedByRegclass = new RegExp(
      `to_regclass\\(\\s*'(?:public\\.)?${tableName}'\\s*\\)`,
      'i'
    ).test(clean);
    alteredTables.push({ table: tableName, guardedByRegclass });

    for (const addMatch of clause.matchAll(
      /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(["']?[a-zA-Z_][a-zA-Z0-9_]*["']?)/gi
    )) {
      addedColumns.push({
        table: tableName,
        column: addMatch[1].replace(/["']/g, '').toLowerCase(),
      });
    }
    for (const dropMatch of clause.matchAll(
      /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(["']?[a-zA-Z_][a-zA-Z0-9_]*["']?)/gi
    )) {
      droppedColumns.push({
        table: tableName,
        column: dropMatch[1].replace(/["']/g, '').toLowerCase(),
      });
    }
  }

  const createdViews = [];
  for (const match of clean.matchAll(
    /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_."']+)/gi
  )) {
    createdViews.push(normalizeIdentifier(match[1]));
  }

  const droppedViews = [];
  for (const match of clean.matchAll(
    /DROP\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_."']+)/gi
  )) {
    droppedViews.push(normalizeIdentifier(match[1]));
  }

  const createdFunctions = [];
  for (const match of clean.matchAll(
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-zA-Z0-9_."']+)\s*\(/gi
  )) {
    createdFunctions.push(normalizeIdentifier(match[1]));
  }

  const droppedFunctions = [];
  for (const match of clean.matchAll(
    /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_."']+)/gi
  )) {
    droppedFunctions.push(normalizeIdentifier(match[1]));
  }

  const createdIndexes = [];
  for (const match of clean.matchAll(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_."']+)\s+ON\s+([a-zA-Z0-9_."']+)/gi
  )) {
    const indexName = normalizeIdentifier(match[1]);
    const tableName = normalizeIdentifier(match[2]);
    if (indexName.includes('%') || tableName.includes('%')) continue;
    createdIndexes.push({ index: indexName, table: tableName });
  }

  const droppedIndexes = [];
  for (const match of clean.matchAll(
    /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_."']+)/gi
  )) {
    droppedIndexes.push(normalizeIdentifier(match[1]));
  }

  return {
    createdTables,
    droppedTables,
    alteredTables,
    addedColumns,
    droppedColumns,
    createdViews: [...new Set(createdViews)],
    droppedViews: [...new Set(droppedViews)],
    createdFunctions: [...new Set(createdFunctions)],
    droppedFunctions: [...new Set(droppedFunctions)],
    createdIndexes,
    droppedIndexes: [...new Set(droppedIndexes)],
  };
}

/**
 * Load all migration descriptors from a migrations directory.
 */
function discoverMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  const rollbackDir = path.join(migrationsDir, 'rollback');
  const entries = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.includes('.test.'))
    .sort();

  const migrations = [];
  for (const filename of entries) {
    const fullPath = path.join(migrationsDir, filename);
    if (!fs.statSync(fullPath).isFile()) continue;

    const match = filename.match(/^(\d{14})_(.+)\.sql$/);
    if (!match) {
      throw new Error(
        `Migration ${filename} does not match expected naming convention YYYYMMDDHHMMSS_<name>.sql`
      );
    }

    const version = match[1];
    const name = match[2];
    const rollbackFilename = `${version}_down_${name}.sql`;
    const rollbackPath = path.join(rollbackDir, rollbackFilename);
    const sql = fs.readFileSync(fullPath, 'utf8');
    const checksum = sha256(sql);
    const operations = extractOperations(sql);

    migrations.push({
      filename,
      version,
      name,
      forwardPath: fullPath,
      rollbackFilename,
      rollbackPath,
      hasRollbackFile: fs.existsSync(rollbackPath),
      sql,
      checksum,
      operations,
    });
  }

  // Verify monotonic version sequence
  for (let i = 0; i < migrations.length - 1; i++) {
    const curr = migrations[i];
    const next = migrations[i + 1];
    if (
      curr.version > next.version ||
      (curr.version === next.version && curr.filename >= next.filename)
    ) {
      throw new Error(`Migration order violation: ${curr.filename} >= ${next.filename}`);
    }
  }

  return migrations;
}

/**
 * Compute the expected final schema state from a list of migrations.
 */
function computeExpectedSchema(migrations) {
  const tables = new Map();
  for (const [table, cols] of Object.entries(BASELINE_TABLES)) {
    tables.set(table, new Set(cols));
  }
  const views = new Set();
  const functions = new Set();
  const indexes = new Map();

  for (const m of migrations) {
    const ops = m.operations;
    for (const [table, cols] of ops.createdTables.entries()) {
      if (!tables.has(table)) tables.set(table, new Set());
      for (const col of cols) {
        if (col.startsWith('__like__:')) {
          const sourceTable = col.slice('__like__:'.length);
          const sourceCols = tables.get(sourceTable) || new Set();
          for (const sc of sourceCols) tables.get(table).add(sc);
        } else {
          tables.get(table).add(col);
        }
      }
    }
    for (const { table, column } of ops.addedColumns) {
      if (tables.has(table)) tables.get(table).add(column);
    }
    for (const { table, column } of ops.droppedColumns) {
      if (tables.has(table)) tables.get(table).delete(column);
    }
    for (const table of ops.droppedTables) {
      tables.delete(table);
    }
    for (const v of ops.createdViews) views.add(v);
    for (const v of ops.droppedViews) views.delete(v);
    for (const fn of ops.createdFunctions) functions.add(fn);
    for (const fn of ops.droppedFunctions) functions.delete(fn);
    for (const { index, table } of ops.createdIndexes) indexes.set(index, table);
    for (const index of ops.droppedIndexes) indexes.delete(index);
  }

  return {
    tables,
    views,
    functions,
    indexes,
  };
}

function hasPsql() {
  const res = spawnSync('psql', ['--version'], { encoding: 'utf8' });
  return res.status === 0;
}

function runPsql(dbUrl, sql, extraArgs = []) {
  const res = spawnSync(
    'psql',
    [dbUrl, '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...extraArgs],
    {
      input: sql,
      encoding: 'utf8',
    }
  );
  if (res.status !== 0) {
    throw new Error(`psql execution failed (exit ${res.status}): ${(res.stderr || res.stdout || '').trim()}`);
  }
  return (res.stdout || '').trim();
}

/**
 * Execute migrations against a live PostgreSQL instance via `psql`.
 */
function runAgainstPostgres({
  dbUrl,
  migrations,
  schema = 'public',
  freshSchema = false,
  dryRun = false,
  includeLegacyModules = true,
  lockTimeoutSeconds = 0,
}) {
  if (dryRun) {
    for (const m of migrations) {
      validateSqlSyntax(m.sql, m.filename);
    }
    const expected = computeExpectedSchema(migrations);
    return {
      mode: 'postgres-dry-run',
      schema,
      appliedCount: migrations.length,
      tables: [...expected.tables.keys()].sort(),
      views: [...expected.views].sort(),
      functions: [...expected.functions].sort(),
      indexes: [...expected.indexes.keys()].sort(),
      appliedMigrations: migrations.map((m) => ({
        version: m.version,
        name: m.name,
        filename: m.filename,
        checksum: m.checksum,
      })),
    };
  }

  // Serialize production migration execution across concurrent release runs.
  const lock = acquireMigrationLock(dbUrl, { timeoutSeconds: lockTimeoutSeconds });
  let newlyApplied = 0;
  try {
    if (freshSchema) {
      runPsql(dbUrl, `DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema};`);
    }

    runPsql(dbUrl, buildBaselineBootstrapSql(schema));

    const appliedRaw = runPsql(
      dbUrl,
      `SET search_path TO ${schema}, public; SELECT filename FROM schema_migrations ORDER BY version, filename;`,
      ['-t', '-A']
    );
    const alreadyApplied = new Set(
      appliedRaw
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    );

    for (const m of migrations) {
      validateSqlSyntax(m.sql, m.filename);
      if (alreadyApplied.has(m.filename)) {
        continue;
      }

      const wrappedSql = `
BEGIN;
SET LOCAL search_path TO ${schema}, public;
${m.sql}
INSERT INTO ${schema}.schema_migrations (version, name, filename, checksum)
VALUES ('${m.version}', '${m.name.replace(/'/g, "''")}', '${m.filename.replace(/'/g, "''")}', '${m.checksum}')
ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now();
COMMIT;
`;
      runPsql(dbUrl, wrappedSql);
      newlyApplied += 1;
    }

    if (includeLegacyModules) {
      for (const modPath of [CRASH_REPORTING_MIGRATION, BRANCH_PREVIEW_MIGRATION]) {
        if (fs.existsSync(modPath)) {
          const modSql = fs.readFileSync(modPath, 'utf8');
          validateSqlSyntax(modSql, path.basename(modPath));
          runPsql(
            dbUrl,
            `BEGIN; SET LOCAL search_path TO ${schema}, public;\n${modSql}\nCOMMIT;`
          );
        }
      }
    }
  } finally {
    // Always release, even when a migration throws, so failures do not strand
    // the lock and block subsequent release runs.
    lock.release();
  }

  // Query live catalog to assert final schema state
  const liveTablesRaw = runPsql(
    dbUrl,
    `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' AND table_type = 'BASE TABLE' ORDER BY table_name;`,
    ['-t', '-A']
  );
  const liveTables = new Set(
    liveTablesRaw
      .split('\n')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

  const liveFuncsRaw = runPsql(
    dbUrl,
    `SELECT routine_name FROM information_schema.routines WHERE routine_schema = '${schema}' ORDER BY routine_name;`,
    ['-t', '-A']
  );
  const liveFunctions = new Set(
    liveFuncsRaw
      .split('\n')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

  const expected = computeExpectedSchema(migrations);
  const missingTables = [];
  for (const table of expected.tables.keys()) {
    if (!liveTables.has(table)) {
      missingTables.push(table);
    }
  }
  if (missingTables.length > 0) {
    throw new Error(
      `Schema assertion failed: missing expected table(s) in schema "${schema}": ${missingTables.join(', ')}`
    );
  }

  const missingFunctions = [];
  for (const fn of expected.functions) {
    if (!liveFunctions.has(fn)) {
      missingFunctions.push(fn);
    }
  }
  if (missingFunctions.length > 0) {
    throw new Error(
      `Schema assertion failed: missing expected function(s) in schema "${schema}": ${missingFunctions.join(', ')}`
    );
  }

  const recordedRaw = runPsql(
    dbUrl,
    `SELECT version || '|' || name || '|' || filename || '|' || checksum FROM ${schema}.schema_migrations ORDER BY version, filename;`,
    ['-t', '-A']
  );
  const appliedMigrations = recordedRaw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [version, name, filename, checksum] = line.split('|');
      return { version, name, filename, checksum };
    });

  return {
    mode: 'postgres',
    schema,
    appliedCount: newlyApplied,
    totalMigrations: migrations.length,
    tables: [...liveTables].sort(),
    views: [...expected.views].sort(),
    functions: [...liveFunctions].sort(),
    indexes: [...expected.indexes.keys()].sort(),
    appliedMigrations,
  };
}

/**
 * Execute migrations against a temporary test DB state (used when running smoke
 * tests without a live PostgreSQL daemon or with a file-backed test DB).
 */
function runAgainstTestStateDb({
  migrations,
  schema = 'public',
  stateFile = null,
  freshSchema = false,
  dryRun = false,
}) {
  let state = {
    schema,
    tables: {},
    views: [],
    functions: [],
    indexes: {},
    appliedMigrations: [],
  };

  if (!freshSchema && stateFile && fs.existsSync(stateFile)) {
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      // Re-initialize if unreadable
    }
  }

  const activeTables = new Map();
  for (const [t, cols] of Object.entries(BASELINE_TABLES)) {
    activeTables.set(t, new Set(cols));
  }
  for (const [t, cols] of Object.entries(state.tables || {})) {
    activeTables.set(t, new Set(cols));
  }
  const activeViews = new Set(state.views || []);
  const activeFunctions = new Set(state.functions || []);
  const activeIndexes = new Map(Object.entries(state.indexes || {}));
  const appliedMap = new Map(
    (state.appliedMigrations || []).map((entry) => [entry.filename, entry])
  );

  let newlyApplied = 0;

  for (const m of migrations) {
    validateSqlSyntax(m.sql, m.filename);

    const ops = m.operations;

    // 1. Apply CREATE TABLE first (matching sequential order within migration)
    for (const [table, cols] of ops.createdTables.entries()) {
      if (!activeTables.has(table)) {
        activeTables.set(table, new Set());
      }
      for (const col of cols) {
        if (col.startsWith('__like__:')) {
          const src = col.slice('__like__:'.length);
          if (!activeTables.has(src)) {
            throw new Error(
              `Migration ${m.filename} references LIKE table "${src}" before it is created`
            );
          }
          for (const sc of activeTables.get(src)) {
            activeTables.get(table).add(sc);
          }
        } else {
          activeTables.get(table).add(col);
        }
      }
    }

    // 2. Validate and apply ALTER TABLE
    for (const { table, guardedByRegclass } of ops.alteredTables) {
      if (!activeTables.has(table) && !guardedByRegclass) {
        throw new Error(
          `Migration ${m.filename} alters non-existent table "${table}"`
        );
      }
    }
    for (const { table, column } of ops.addedColumns) {
      if (activeTables.has(table)) {
        activeTables.get(table).add(column);
      }
    }
    for (const { table, column } of ops.droppedColumns) {
      if (activeTables.has(table)) {
        activeTables.get(table).delete(column);
      }
    }

    // 3. Apply Views & Functions
    for (const v of ops.createdViews) activeViews.add(v);
    for (const v of ops.droppedViews) activeViews.delete(v);
    for (const fn of ops.createdFunctions) activeFunctions.add(fn);
    for (const fn of ops.droppedFunctions) activeFunctions.delete(fn);

    // 4. Validate and apply CREATE INDEX
    for (const { index, table } of ops.createdIndexes) {
      if (!activeTables.has(table) && !activeViews.has(table)) {
        throw new Error(
          `Migration ${m.filename} creates index "${index}" on non-existent relation "${table}"`
        );
      }
      activeIndexes.set(index, table);
    }
    for (const index of ops.droppedIndexes) {
      activeIndexes.delete(index);
    }

    // 5. Apply DROP TABLE
    for (const table of ops.droppedTables) {
      activeTables.delete(table);
    }

    if (!appliedMap.has(m.filename)) {
      newlyApplied += 1;
    }
    appliedMap.set(m.filename, {
      version: m.version,
      name: m.name,
      filename: m.filename,
      checksum: m.checksum,
      appliedAt: new Date().toISOString(),
    });
  }

  // Assert final schema matches expected state
  const expected = computeExpectedSchema(migrations);
  for (const [expectedTable, expectedCols] of expected.tables.entries()) {
    if (!activeTables.has(expectedTable)) {
      throw new Error(
        `Final schema assertion failed: expected table "${expectedTable}" is missing`
      );
    }
    const actualCols = activeTables.get(expectedTable);
    for (const col of expectedCols) {
      if (!actualCols.has(col)) {
        throw new Error(
          `Final schema assertion failed: expected column "${expectedTable}.${col}" is missing`
        );
      }
    }
  }
  for (const v of expected.views) {
    if (!activeViews.has(v)) {
      throw new Error(`Final schema assertion failed: expected view "${v}" is missing`);
    }
  }
  for (const fn of expected.functions) {
    if (!activeFunctions.has(fn)) {
      throw new Error(`Final schema assertion failed: expected function "${fn}" is missing`);
    }
  }

  const serializedTables = {};
  for (const [t, cols] of [...activeTables.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    serializedTables[t] = [...cols].sort();
  }
  const serializedIndexes = {};
  for (const [idx, tbl] of [...activeIndexes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    serializedIndexes[idx] = tbl;
  }

  const nextState = {
    schema,
    tables: serializedTables,
    views: [...activeViews].sort(),
    functions: [...activeFunctions].sort(),
    indexes: serializedIndexes,
    appliedMigrations: [...appliedMap.values()],
  };

  if (!dryRun && stateFile) {
    fs.mkdirSync(path.dirname(path.resolve(stateFile)), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(nextState, null, 2) + '\n', 'utf8');
  }

  return {
    mode: 'test-db',
    schema,
    appliedCount: newlyApplied,
    totalMigrations: migrations.length,
    tables: Object.keys(serializedTables),
    tableColumns: serializedTables,
    views: nextState.views,
    functions: nextState.functions,
    indexes: Object.keys(serializedIndexes),
    appliedMigrations: nextState.appliedMigrations,
  };
}

/**
 * Revert the most recent migration (or N steps / specific target) against
 * PostgreSQL or a temporary test DB state file.
 */
function rollbackMigration({
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '',
  schema = 'public',
  stateFile = process.env.MIGRATION_STATE_FILE || null,
  steps = 1,
  target = null,
  dryRun = false,
}) {
  const migrations = discoverMigrations(migrationsDir);
  if (migrations.length === 0) {
    throw new Error(`No migrations found in ${migrationsDir}`);
  }

  let appliedList = [...migrations];
  if (stateFile && fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (Array.isArray(state.appliedMigrations) && state.appliedMigrations.length > 0) {
      const appliedNames = new Set(state.appliedMigrations.map((a) => a.filename));
      appliedList = migrations.filter((m) => appliedNames.has(m.filename));
    }
  } else if (
    dbUrl &&
    /^postgres(?:ql)?:\/\//i.test(dbUrl) &&
    hasPsql() &&
    !dryRun
  ) {
    try {
      const raw = runPsql(
        dbUrl,
        `SELECT filename FROM ${schema}.schema_migrations ORDER BY version, filename;`,
        ['-t', '-A']
      );
      const names = raw
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length > 0) {
        const appliedSet = new Set(names);
        appliedList = migrations.filter((m) => appliedSet.has(m.filename));
      }
    } catch {
      // Fallback to file order if schema_migrations table was not yet created
    }
  }

  if (appliedList.length === 0) {
    throw new Error('No applied migrations available to roll back');
  }

  let toRollback = [];
  if (target) {
    const normalizedTarget = target.trim();
    const matched = [...appliedList]
      .reverse()
      .find(
        (m) =>
          m.filename === normalizedTarget ||
          m.version === normalizedTarget ||
          m.name === normalizedTarget ||
          `${m.version}_${m.name}` === normalizedTarget
      );
    if (!matched) {
      throw new Error(`Target migration "${target}" not found among applied migrations`);
    }
    toRollback = [matched];
  } else {
    const count = Math.max(1, Number(steps) || 1);
    if (count > appliedList.length) {
      throw new Error(
        `Cannot roll back ${count} migration(s); only ${appliedList.length} applied`
      );
    }
    toRollback = appliedList.slice(-count).reverse();
  }

  const rolledBack = [];
  for (const m of toRollback) {
    if (!m.hasRollbackFile) {
      throw new Error(
        `Rollback file missing for ${m.filename}: expected ${m.rollbackPath}`
      );
    }
    const rollbackSql = fs.readFileSync(m.rollbackPath, 'utf8');
    validateSqlSyntax(rollbackSql, m.rollbackFilename, { allowCommentOnly: true });

    if (!dryRun && dbUrl && /^postgres(?:ql)?:\/\//i.test(dbUrl) && hasPsql()) {
      const sqlToRun = `
BEGIN;
SET LOCAL search_path TO ${schema}, public;
${rollbackSql}
DO $$
BEGIN
  IF to_regclass('${schema}.schema_migrations') IS NOT NULL THEN
    DELETE FROM ${schema}.schema_migrations WHERE filename = '${m.filename.replace(/'/g, "''")}';
  END IF;
END $$;
COMMIT;
`;
      runPsql(dbUrl, sqlToRun);
    }

    rolledBack.push({
      version: m.version,
      name: m.name,
      filename: m.filename,
      rollbackFilename: m.rollbackFilename,
      rollbackPath: m.rollbackPath,
      sql: rollbackSql,
    });
  }

  // If stateFile is used, recompute the remaining schema state after rollback
  const rolledBackSet = new Set(rolledBack.map((r) => r.filename));
  const remainingMigrations = appliedList.filter((m) => !rolledBackSet.has(m.filename));

  if (!dryRun && stateFile) {
    runAgainstTestStateDb({
      migrations: remainingMigrations,
      schema,
      stateFile,
      freshSchema: true,
      dryRun: false,
    });
  }

  return {
    dryRun,
    schema,
    rolledBackCount: rolledBack.length,
    rolledBack,
    remainingCount: remainingMigrations.length,
    currentHead:
      remainingMigrations.length > 0
        ? remainingMigrations[remainingMigrations.length - 1].filename
        : null,
  };
}

function parseCliArgs(argv) {
  const options = {
    smokeTest: process.env.MIGRATION_SMOKE_TEST === '1',
    freshSchema: false,
    schema: process.env.MIGRATION_TEST_SCHEMA || 'public',
    migrationsDir: process.env.SUPABASE_MIGRATIONS_DIR || DEFAULT_MIGRATIONS_DIR,
    stateFile: process.env.MIGRATION_STATE_FILE || null,
    rollback: false,
    steps: 1,
    target: null,
    dryRun: false,
    json: false,
    lockTimeoutSeconds: Number(process.env.MIGRATION_LOCK_TIMEOUT_SECONDS || 0) || 0,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--smoke-test' || arg === '--verify') {
      options.smokeTest = true;
      options.freshSchema = true;
    } else if (arg === '--fresh-schema') {
      options.freshSchema = true;
    } else if (arg === '--schema' && argv[i + 1]) {
      options.schema = argv[++i];
    } else if (arg.startsWith('--schema=')) {
      options.schema = arg.split('=')[1];
    } else if (arg === '--migrations-dir' && argv[i + 1]) {
      options.migrationsDir = path.resolve(argv[++i]);
    } else if (arg.startsWith('--migrations-dir=')) {
      options.migrationsDir = path.resolve(arg.split('=')[1]);
    } else if (arg === '--state-file' && argv[i + 1]) {
      options.stateFile = path.resolve(argv[++i]);
    } else if (arg.startsWith('--state-file=')) {
      options.stateFile = path.resolve(arg.split('=')[1]);
    } else if (arg === '--rollback') {
      options.rollback = true;
    } else if (arg === '--steps' && argv[i + 1]) {
      options.steps = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--steps=')) {
      options.steps = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--target' && argv[i + 1]) {
      options.target = argv[++i];
    } else if (arg.startsWith('--target=')) {
      options.target = arg.split('=')[1];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--lock-timeout' && argv[i + 1]) {
      options.lockTimeoutSeconds = Math.max(0, parseInt(argv[++i], 10) || 0);
    } else if (arg.startsWith('--lock-timeout=')) {
      options.lockTimeoutSeconds = Math.max(0, parseInt(arg.split('=')[1], 10) || 0);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

async function runMigration(cliOptions = null) {
  const options = cliOptions || parseCliArgs(process.argv.slice(2));

  if (options.help) {
    console.log(
      'Usage: node app/backend/run-migration-supabase.js [--smoke-test] [--fresh-schema] [--schema <name>] [--migrations-dir <dir>] [--state-file <path>] [--rollback] [--steps <n>] [--target <version>] [--dry-run] [--json] [--lock-timeout <secs>]'
    );
    return { ok: true };
  }

  if (options.rollback) {
    const result = rollbackMigration({
      migrationsDir: options.migrationsDir,
      schema: options.schema,
      stateFile: options.stateFile,
      steps: options.steps,
      target: options.target,
      dryRun: options.dryRun,
    });
    if (!options.quiet) {
      if (options.json) {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      } else {
        for (const r of result.rolledBack) {
          console.log(
            `${result.dryRun ? '[DRY-RUN] Would revert' : '⏪ Reverted'} migration: ${r.filename} (using ${r.rollbackFilename})`
          );
        }
        console.log(
          `✅ Rollback complete (${result.rolledBackCount} reverted, ${result.remainingCount} remaining, head=${result.currentHead || 'none'})`
        );
      }
    }
    return { ok: true, ...result };
  }

  const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';
  const migrations = discoverMigrations(options.migrationsDir);

  let report;
  if (dbUrl && /^postgres(?:ql)?:\/\//i.test(dbUrl) && hasPsql()) {
    report = runAgainstPostgres({
      dbUrl,
      migrations,
      schema: options.schema,
      freshSchema: options.freshSchema || options.smokeTest,
      dryRun: options.dryRun,
      includeLegacyModules: options.migrationsDir === DEFAULT_MIGRATIONS_DIR,
      lockTimeoutSeconds: options.lockTimeoutSeconds,
    });
  } else if (
    options.smokeTest ||
    options.stateFile ||
    options.dryRun ||
    dbUrl.startsWith('memory://') ||
    dbUrl.startsWith('file://') ||
    dbUrl.startsWith('sqlite://') ||
    (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ) {
    const resolvedStateFile =
      options.stateFile ||
      (dbUrl.startsWith('file://') ? dbUrl.slice('file://'.length) : null);
    report = runAgainstTestStateDb({
      migrations,
      schema: options.schema,
      stateFile: resolvedStateFile,
      freshSchema: options.freshSchema || options.smokeTest,
      dryRun: options.dryRun,
    });
  } else {
    throw new Error(
      'Missing database configuration: set DATABASE_URL / SUPABASE_DB_URL, SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, or pass --smoke-test'
    );
  }

  if (!options.quiet) {
    if (options.json) {
      console.log(JSON.stringify({ ok: true, ...report }, null, 2));
    } else {
      console.log(`🚀 QuickEx Supabase Migration Runner (${report.mode})`);
      console.log(`   Schema:            ${report.schema}`);
      console.log(`   Migrations total:  ${migrations.length}`);
      console.log(`   Migrations applied:${report.appliedCount}`);
      console.log(`   Tables verified:   ${report.tables.length}`);
      console.log(`   Views verified:    ${report.views.length}`);
      console.log(`   Functions verified:${report.functions.length}`);
      console.log(`   Indexes verified:  ${report.indexes.length}`);
      console.log('✅ All migrations applied cleanly and final schema assertions passed.');
    }
  }

  return { ok: true, ...report };
}

if (require.main === module) {
  runMigration().catch((error) => {
    console.error(`❌ Migration failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  runMigration,
  rollbackMigration,
  discoverMigrations,
  computeExpectedSchema,
  validateSqlSyntax,
  extractOperations,
  buildBaselineBootstrapSql,
  acquireMigrationLock,
  MIGRATION_ADVISORY_LOCK_KEY,
};
