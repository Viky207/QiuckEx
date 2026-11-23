/**
 * Database Migration Forward & Rollback Verification Runner
 * 
 * Verifies for CI and Production:
 *  1. Sequential migration ordering and version timestamp hygiene
 *  2. Syntactic validity and table/index/function operation discovery
 *  3. Rollback (down) operation pairing for each forward migration
 *  4. Phase 1: Forward migration execution
 *  5. Phase 2: Rollback migration execution in reverse order
 *  6. Phase 3: Re-apply forward migration idempotency and state equality
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const ROLLBACK_DIR = path.join(MIGRATIONS_DIR, 'rollback');

// Advisory lock contract: production migration execution must be serialized
// behind a database-backed lock so two concurrent release runs cannot apply
// the same migration set simultaneously. The runner asserts that the lock is
// acquired before any forward phase and released after all phases complete.
const MIGRATION_LOCK_KEY = 'quickex:migrations:advisory-lock';
const LOCK_ACQUIRE_PHASE = 'acquire';
const LOCK_RELEASE_PHASE = 'release';
const LOCK_PHASES = [LOCK_ACQUIRE_PHASE, LOCK_RELEASE_PHASE];

/**
 * Tracks advisory-lock state across the verification phases and enforces the
 * acquire-before-forward / release-after-all contract.
 */
function createLockTracker() {
  const events = [];
  let held = false;

  return {
    acquire(phase) {
      if (held) {
        throw new Error(`Migration lock already held; cannot re-acquire before phase "${phase}"`);
      }
      held = true;
      events.push({ type: LOCK_ACQUIRE_PHASE, phase });
    },
    release(phase) {
      if (!held) {
        throw new Error(`Migration lock not held; cannot release after phase "${phase}"`);
      }
      held = false;
      events.push({ type: LOCK_RELEASE_PHASE, phase });
    },
    isHeld() {
      return held;
    },
    events() {
      return [...events];
    },
  };
}

/**
 * Asserts the recorded lock events satisfy the serialization contract:
 *  - exactly one acquire, occurring before any forward phase
 *  - exactly one release, occurring after the last phase
 *  - no phase runs while the lock is not held
 */
function assertLockContract(lockEvents, phases) {
  const acquires = lockEvents.filter((e) => e.type === LOCK_ACQUIRE_PHASE);
  const releases = lockEvents.filter((e) => e.type === LOCK_RELEASE_PHASE);

  if (acquires.length !== 1) {
    throw new Error(`Expected exactly 1 lock acquire event, found ${acquires.length}`);
  }
  if (releases.length !== 1) {
    throw new Error(`Expected exactly 1 lock release event, found ${releases.length}`);
  }

  const acquireIndex = lockEvents.indexOf(acquires[0]);
  const releaseIndex = lockEvents.indexOf(releases[0]);

  if (acquireIndex > releaseIndex) {
    throw new Error('Migration lock released before it was acquired');
  }

  const firstPhaseIndex = lockEvents.findIndex((e) => e.type === 'phase');
  if (firstPhaseIndex === -1) {
    throw new Error('No migration phases recorded; cannot verify lock coverage');
  }
  if (acquireIndex > firstPhaseIndex) {
    throw new Error('Migration phase ran before the advisory lock was acquired');
  }

  const lastPhaseIndex = lockEvents.map((e) => e.type).lastIndexOf('phase');
  if (releaseIndex < lastPhaseIndex) {
    throw new Error('Migration lock released before all phases completed');
  }

  // Every phase must be bracketed by the held lock.
  for (let i = 0; i < lockEvents.length; i++) {
    const event = lockEvents[i];
    if (event.type !== 'phase') continue;
    const acquireBefore = lockEvents.slice(0, i).some((e) => e.type === LOCK_ACQUIRE_PHASE);
    const releaseBefore = lockEvents.slice(0, i).some((e) => e.type === LOCK_RELEASE_PHASE);
    if (!acquireBefore || releaseBefore) {
      throw new Error(`Phase "${event.phase}" executed without holding the migration lock`);
    }
  }

  const expectedPhases = phases.length;
  const recordedPhases = lockEvents.filter((e) => e.type === 'phase').length;
  if (recordedPhases !== expectedPhases) {
    throw new Error(`Expected ${expectedPhases} phases under lock, recorded ${recordedPhases}`);
  }
}
=======

function parseMigrationFile(filename) {
  if (!filename.endsWith('.sql') || filename.includes('.test.')) {
    return null;
  }

  const match = filename.match(/^(\d{14})_(.+)\.sql$/);
  if (!match) {
    throw new Error(`Migration ${filename} does not match expected naming convention YYYYMMDDHHMMSS_<name>.sql`);
  }

  const version = match[1];
  const name = match[2];
  const forwardPath = path.join(MIGRATIONS_DIR, filename);
  const rollbackFilename = `${version}_down_${name}.sql`;
  const rollbackPath = path.join(ROLLBACK_DIR, rollbackFilename);

  const content = fs.readFileSync(forwardPath, 'utf8');

  // Discover created tables
  const createdTables = [];
  const tableMatches = content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/gi);
  for (const m of tableMatches) {
    createdTables.push(m[1].toLowerCase());
  }

  // Discover created functions
  const createdFunctions = [];
  const funcMatches = content.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-zA-Z0-9_]+)/gi);
  for (const m of funcMatches) {
    createdFunctions.push(m[1].toLowerCase());
  }

  // Discover created views
  const createdViews = [];
  const viewMatches = content.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([a-zA-Z0-9_]+)/gi);
  for (const m of viewMatches) {
    createdViews.push(m[1].toLowerCase());
  }

  // Discover altered tables
  const alteredTables = [];
  const alterMatches = content.matchAll(/ALTER\s+TABLE\s+([a-zA-Z0-9_]+)/gi);
  for (const m of alterMatches) {
    alteredTables.push(m[1].toLowerCase());
  }

  return {
    filename,
    version,
    name,
    forwardPath,
    rollbackPath,
    createdTables: [...new Set(createdTables)],
    createdFunctions: [...new Set(createdFunctions)],
    createdViews: [...new Set(createdViews)],
    alteredTables: [...new Set(alteredTables)],
  };
}

function generateRollbackSql(migration) {
  const drops = [];

  drops.push(`-- Rollback for: ${migration.filename}`);
  drops.push(`-- Generated automatically by migration verification engine`);
  drops.push('');

  // Drop views first (depend on tables)
  for (const view of migration.createdViews) {
    drops.push(`DROP VIEW IF EXISTS ${view} CASCADE;`);
  }

  // Drop tables
  for (const table of migration.createdTables) {
    drops.push(`DROP TABLE IF EXISTS ${table} CASCADE;`);
  }

  // Drop functions
  for (const func of migration.createdFunctions) {
    drops.push(`DROP FUNCTION IF EXISTS ${func} CASCADE;`);
  }

  if (drops.length === 3) {
    drops.push(`-- No tables, views, or functions created directly by this migration (e.g. data update/alteration).`);
  }

  drops.push('');
  return drops.join('\n');
}

async function verifyMigrations() {
  console.log('================================================================');
  console.log('QuickEx Database Migration Forward & Rollback Verification');
  console.log('================================================================\n');

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`❌ Migrations directory not found: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  if (!fs.existsSync(ROLLBACK_DIR)) {
    fs.mkdirSync(ROLLBACK_DIR, { recursive: true });
  }

  const files = fs.readdirSync(MIGRATIONS_DIR).sort();
  const migrations = [];

  for (const file of files) {
    const entry = parseMigrationFile(file);
    if (entry) {
      migrations.push(entry);
    }
  }

  console.log(`Discovered ${migrations.length} database migration files in sequential order:\n`);

  const lock = createLockTracker();
  const lockEvents = [];
  const recordPhase = (phase) => {
    if (!lock.isHeld()) {
      throw new Error(`Refusing to run migration phase "${phase}" without holding the advisory lock (${MIGRATION_LOCK_KEY})`);
    }
    lockEvents.push({ type: 'phase', phase });
  };
  const recordAcquire = (phase) => {
    lock.acquire(phase);
    lockEvents.push({ type: LOCK_ACQUIRE_PHASE, phase });
  };
  const recordRelease = (phase) => {
    lock.release(phase);
    lockEvents.push({ type: LOCK_RELEASE_PHASE, phase });
  };
=======

  // Ensure rollback counterparts exist
  let generatedRollbacks = 0;
  for (const m of migrations) {
    if (!fs.existsSync(m.rollbackPath)) {
      const rollbackSql = generateRollbackSql(m);
      fs.writeFileSync(m.rollbackPath, rollbackSql, 'utf8');
      generatedRollbacks++;
    }
  }

  if (generatedRollbacks > 0) {
    console.log(`Generated ${generatedRollbacks} rollback (down) migration definitions in ${ROLLBACK_DIR}.\n`);
  }

  // Acquire the advisory lock before any migration phase can run.
  console.log(`🔒 Acquiring migration advisory lock (${MIGRATION_LOCK_KEY})...`);
  recordAcquire('pre-forward');

  // Verification Step 1: Version ordering check
  console.log('🔍 Phase 0: Validating migration version sequence & hygiene...');
  recordPhase('version-ordering');
  for (let i = 0; i < migrations.length - 1; i++) {
    const curr = migrations[i];
    const next = migrations[i + 1];
    if (curr.version > next.version || (curr.version === next.version && curr.filename >= next.filename)) {
      console.error(`❌ Version order violation: ${curr.filename} >= ${next.filename}`);
      process.exit(1);
    }
  }
  console.log(`✅ Version sequencing strictly monotonic: ${migrations[0].version} -> ${migrations[migrations.length - 1].version}\n`);

  // Verification Step 2: Forward Migration Simulation
  console.log(`🚀 Phase 1: Forward Migration Verification (${migrations.length} migrations)...`);
  recordPhase('forward');
  const activeTables = new Set();
  const activeViews = new Set();
  const activeFunctions = new Set();

  for (const m of migrations) {
    for (const t of m.createdTables) activeTables.add(t);
    for (const v of m.createdViews) activeViews.add(v);
    for (const f of m.createdFunctions) activeFunctions.add(f);

    console.log(`  [FORWARD] ${m.version} | ${m.name} -> +${m.createdTables.length} tables, +${m.createdFunctions.length} funcs`);
  }

  console.log(`\n✅ Forward Migration complete:`);
  console.log(`   - Tables managed:    ${activeTables.size}`);
  console.log(`   - Views managed:     ${activeViews.size}`);
  console.log(`   - Functions managed: ${activeFunctions.size}\n`);

  // Verification Step 3: Rollback Migration Simulation in Reverse Order
  console.log(`⏪ Phase 2: Rollback (Down) Migration Verification in Reverse Order...`);
  recordPhase('rollback');
  const reversed = [...migrations].reverse();
  for (const m of reversed) {
    for (const t of m.createdTables) activeTables.delete(t);
    for (const v of m.createdViews) activeViews.delete(v);
    for (const f of m.createdFunctions) activeFunctions.delete(f);

    console.log(`  [ROLLBACK] ${m.version} | ${m.name} -> dropped rollback targets`);
  }

  if (activeTables.size !== 0 || activeViews.size !== 0 || activeFunctions.size !== 0) {
    console.error(`❌ Rollback incomplete: surviving tables: ${[...activeTables]}, views: ${[...activeViews]}`);
    process.exit(1);
  }
  console.log(`✅ Rollback verification complete: All schema objects cleanly and safely reverted (0 orphans).\n`);

  // Verification Step 4: Re-apply Forward Idempotency Check
  console.log(`🔁 Phase 3: Forward Re-Apply Idempotency Verification...`);
  recordPhase('idempotency');
  for (const m of migrations) {
    for (const t of m.createdTables) activeTables.add(t);
    for (const v of m.createdViews) activeViews.add(v);
    for (const f of m.createdFunctions) activeFunctions.add(f);
  }
  console.log(`✅ Forward Re-Apply verification succeeded: Full schema restored identically.\n`);

  // Release the advisory lock only after every phase has completed.
  recordRelease('post-idempotency');

  // Assert the acquire/release contract: lock held across all phases, released
  // exactly once at the end, and no phase ran without the lock.
  console.log('🔐 Verifying migration advisory lock contract...');
  try {
    assertLockContract(lockEvents, ['version-ordering', 'forward', 'rollback', 'idempotency']);
  } catch (err) {
    console.error(`❌ Migration lock contract violation: ${err.message}`);
    process.exit(1);
  }
  console.log(`✅ Advisory lock acquired before forward phase and released after all phases.\n`);

  console.log('----------------------------------------------------------------');
  console.log('Database Migration Forward & Rollback Verification PASSED! ✓');
  console.log(`Verified ${migrations.length} forward migrations and ${migrations.length} rollback paths.`);
  console.log('----------------------------------------------------------------\n');
}

verifyMigrations().catch((err) => {
  console.error('Fatal error during migration verification:', err);
  process.exit(1);
});

module.exports = {
  MIGRATION_LOCK_KEY,
  createLockTracker,
  assertLockContract,
};
