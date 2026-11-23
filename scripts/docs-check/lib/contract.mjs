/**
 * Documentation vs. source drift - issue #295.
 *
 * The OpenAPI document and the contract map are only useful if they describe
 * the API that actually exists. This module reads the backend's route
 * definitions as text and compares them with what the documentation claims,
 * so a controller nobody documented fails CI instead of surfacing as a 404.
 *
 * It never imports or runs the backend, so it works on a fresh clone.
 */
import { PATHS, fileExists, listControllerFiles, listFiles, readText, unique } from "./shared.mjs";

/** Directory holding the backend's SQL migrations. */
export const MIGRATIONS_DIR = "app/backend/supabase/migrations";

/** The guide that must document migration authoring, rollback and verification. */
export const MIGRATION_GUIDE = "docs/DATABASE-MIGRATION-GUIDE.md";

/** Commands the migration guide must document so contributors can verify work. */
export const MIGRATION_VERIFICATION_COMMANDS = [
  "npm run docs:check",
  "supabase db reset",
  "supabase migration list",
];

/**
 * Glossary drift - issue #588.
 *
 * The glossary is the single source of truth for product and protocol terms.
 * A term with two preferred meanings, a canonical link that points at a file
 * that no longer exists, or a missing requested/settlement/conversion
 * distinction all make the glossary worse than none at all, so they fail CI.
 */
export const GLOSSARY_PATH = "docs/glossary.md";

/** Terms whose distinction the glossary must state explicitly. */
export const REQUIRED_DISTINCTIONS = ["requested asset", "settlement asset", "conversion"];

/**
 * Parse the glossary into entries. Each entry is a level-3 heading
 * (`### Term`) followed by a body; the body must contain exactly one
 * `**Preferred:**` line and at least one `**Canonical:**` link.
 */
export function parseGlossary(text) {
  const entries = [];
  const lines = text.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      if (current) entries.push(current);
      current = { term: heading[1], body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) entries.push(current);
  return entries.map((entry) => {
    const body = entry.body.join("\n");
    const preferred = [...body.matchAll(/^\s*\*\*Preferred:\*\*\s*(.+?)\s*$/gm)].map((m) => m[1]);
    const canonical = [...body.matchAll(/^\s*\*\*Canonical:\*\*\s*\[[^\]]*\]\(([^)]+)\)/gm)].map(
      (m) => m[1],
    );
    return { term: entry.term, preferred, canonical };
  });
}

/** A canonical link resolves when it points at a file that exists in the repo. */
export function canonicalLinkResolves(root, link) {
  const target = link.split("#")[0].trim();
  if (!target || /^[a-z]+:\/\//i.test(target)) return false;
  return fileExists(root, target.replace(/^\.?\//, ""));
}

export function checkGlossary(root) {
  const errors = [];
  const warnings = [];
  const summary = { terms: 0, preferred: 0, canonical: 0 };

  if (!fileExists(root, GLOSSARY_PATH)) {
    return { errors: [`${GLOSSARY_PATH} is missing`], warnings, summary };
  }

  const text = readText(root, GLOSSARY_PATH);
  const entries = parseGlossary(text);
  summary.terms = entries.length;

  if (entries.length === 0) {
    errors.push(`${GLOSSARY_PATH} defines no terms - add at least one "### Term" entry.`);
  }

  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.term.toLowerCase())) {
      errors.push(`${GLOSSARY_PATH}: term "${entry.term}" is defined more than once.`);
    }
    seen.add(entry.term.toLowerCase());

    if (entry.preferred.length === 0) {
      errors.push(`${GLOSSARY_PATH}: term "${entry.term}" has no **Preferred:** definition.`);
    } else if (entry.preferred.length > 1) {
      errors.push(
        `${GLOSSARY_PATH}: term "${entry.term}" has ${entry.preferred.length} **Preferred:** definitions - a term must have exactly one preferred meaning.`,
      );
    } else {
      summary.preferred += 1;
    }

    if (entry.canonical.length === 0) {
      errors.push(`${GLOSSARY_PATH}: term "${entry.term}" has no **Canonical:** link.`);
    } else {
      const broken = entry.canonical.filter((link) => !canonicalLinkResolves(root, link));
      if (broken.length > 0) {
        errors.push(
          `${GLOSSARY_PATH}: term "${entry.term}" has a canonical link that does not resolve: ${broken.join(", ")}.`,
        );
      } else {
        summary.canonical += 1;
      }
    }
  }

  const lower = text.toLowerCase();
  for (const term of REQUIRED_DISTINCTIONS) {
    if (!lower.includes(term)) {
      errors.push(
        `${GLOSSARY_PATH}: the distinction between requested asset, settlement asset, and conversion is incomplete - "${term}" is not defined.`,
      );
    }
  }

  return { errors, warnings, summary };
}

/** Controller prefixes, as declared in @Controller('...'). */
export function extractControllerPrefixes(sources) {
  const prefixes = [];
  for (const { file, content } of sources) {
    // A quoted argument is a path prefix; a bare `@Controller()` is the root
    // controller, which has no prefix to document and must not be skipped
    // silently by the pattern.
    for (const match of content.matchAll(/@Controller\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g)) {
      prefixes.push({ file, prefix: match[1] ?? "" });
    }
  }
  return prefixes;
}

/** The distinct first path segments of a documented route set, as a Set. */
export function documentedPathSegments(paths) {
  return new Set(
    unique(paths.map((path) => path.replace(/^\//, "").split("/")[0]).filter(Boolean)),
  );
}

/**
 * A prefix counts as documented when any of its segments appears among the
 * documented path segments. Matching on segments rather than whole prefixes is
 * deliberate: the goal is to catch an entirely undocumented module, not to
 * police how the docs group routes.
 */
export function isPrefixDocumented(prefix, segments) {
  if (prefix === "" || prefix === "/") return true;
  return prefix
    .split("/")
    .filter(Boolean)
    .some((segment) => segments.has(segment));
}

/** Route prefixes the backend mounts, read from @Controller(...). */
export function collectBackendRoutes(root) {
  const sources = listControllerFiles(root).map((file) => ({
    file,
    content: readText(root, file),
  }));
  const owners = extractControllerPrefixes(sources);
  return {
    files: sources.length,
    prefixes: unique(owners.map((entry) => entry.prefix)),
    owners,
  };
}

export function checkContractDrift(root) {
  const errors = [];
  const warnings = [];
  const summary = { controllers: 0, documented: 0, undocumented: 0 };

  if (!fileExists(root, PATHS.openapi)) {
    return { errors: [`${PATHS.openapi} is missing`], warnings, summary };
  }

  let document;
  try {
    document = JSON.parse(readText(root, PATHS.openapi));
  } catch (error) {
    return { errors: [`${PATHS.openapi} is not valid JSON: ${error.message}`], warnings, summary };
  }

  const backend = collectBackendRoutes(root);
  summary.controllers = backend.prefixes.length;

  const segments = documentedPathSegments(Object.keys(document.paths ?? {}));
  // Contract prose counts as documentation too: a route described in the
  // contract map is not undocumented even if the generated document lags.
  const prose = fileExists(root, PATHS.contractMap) ? readText(root, PATHS.contractMap) : "";

  const undocumented = [];
  for (const prefix of backend.prefixes) {
    if (prefix === "" || prefix === "/") continue;
    if (isPrefixDocumented(prefix, segments)) {
      summary.documented += 1;
      continue;
    }
    const owner = backend.owners.find((entry) => entry.prefix === prefix)?.file;
    if (prose.includes(`/${prefix.split("/")[0]}`)) {
      warnings.push(
        `${owner}: controller "${prefix}" is absent from ${PATHS.openapi} but is described in ${PATHS.contractMap}`,
      );
      continue;
    }
    undocumented.push({ prefix, owner });
  }

  summary.undocumented = undocumented.length;
  for (const { prefix, owner } of undocumented) {
    errors.push(
      `${owner}: controller "${prefix}" is documented in neither ${PATHS.openapi} nor ${PATHS.contractMap}. An undocumented route is a 404 waiting to happen - add it to both.`,
    );
  }

  return { errors, warnings, summary };
}

/**
 * The backend registers no global route prefix. This is a documented contract
 * the contract map calls out explicitly, because a client that prepends /api
 * would break every route at once.
 */
/**
 * Migration authoring and rollback review - issue #583.
 *
 * Every forward migration needs a way back. This check pairs each
 * `*.sql` migration with a rollback counterpart (`*.down.sql` or
 * `*_rollback.sql`) and accepts a migration without one only when the guide
 * marks it explicitly irreversible. It also verifies the guide documents the
 * current verification commands.
 */
export function checkMigrationRollbacks(root) {
  const errors = [];
  const warnings = [];
  const summary = { migrations: 0, withRollback: 0, irreversible: 0, missing: 0 };

  if (!fileExists(root, MIGRATION_GUIDE)) {
    return {
      errors: [`${MIGRATION_GUIDE} is missing - it must document migration authoring and rollback review`],
      warnings,
      summary,
    };
  }

  const guide = readText(root, MIGRATION_GUIDE);
  for (const command of MIGRATION_VERIFICATION_COMMANDS) {
    if (!guide.includes(command)) {
      errors.push(`${MIGRATION_GUIDE} does not document the verification command "${command}"`);
    }
  }

  const files = listFiles(root, MIGRATIONS_DIR).filter((file) => file.endsWith(".sql"));
  const forward = files.filter((file) => !isRollbackFile(file));
  const rollbacks = new Set(files.filter(isRollbackFile).map(rollbackBase));
  summary.migrations = forward.length;

  for (const file of forward) {
    const base = file.replace(/\.sql$/, "");
    if (rollbacks.has(base)) {
      summary.withRollback += 1;
      continue;
    }
    if (isMarkedIrreversible(guide, file)) {
      summary.irreversible += 1;
      continue;
    }
    summary.missing += 1;
    errors.push(
      `${MIGRATIONS_DIR}/${file}: no rollback script (expected ${base}.down.sql) and it is not marked irreversible in ${MIGRATION_GUIDE}. Add a rollback or document why the change cannot be reversed.`,
    );
  }

  return { errors, warnings, summary };
}

/** A rollback script is a `.down.sql` or `_rollback.sql` sibling. */
export function isRollbackFile(file) {
  return /(\.down|_rollback)\.sql$/.test(file);
}

/** The forward-migration base name a rollback file belongs to. */
export function rollbackBase(file) {
  return file.replace(/(\.down|_rollback)\.sql$/, "");
}

/**
 * A migration is explicitly irreversible when the guide names its file (or
 * base name) on a line that also says "irreversible". Naming the file keeps
 * the exception auditable instead of blanket-exempting a directory.
 */
export function isMarkedIrreversible(guide, file) {
  const base = file.replace(/\.sql$/, "");
  return guide
    .split("\n")
    .filter((line) => /irreversible/i.test(line))
    .some((line) => line.includes(file) || line.includes(base));
}

export function checkGlobalPrefixInvariant(root) {
  const errors = [];
  if (!fileExists(root, PATHS.mainEntry)) {
    return { errors: [`${PATHS.mainEntry} is missing`], warnings: [], summary: {} };
  }
  const main = readText(root, PATHS.mainEntry);
  const usesGlobalPrefix = /setGlobalPrefix\s*\(/.test(main);
  if (usesGlobalPrefix) {
    const map = fileExists(root, PATHS.contractMap) ? readText(root, PATHS.contractMap) : "";
    // Agreement requires the map to actually document a prefix. A map that
    // still *denies* one is the exact drift this check exists to catch, so a
    // mention of "no global route prefix" is a contradiction, not agreement.
    const documentsAPrefix = map.includes("setGlobalPrefix");
    const deniesAPrefix = /no global route prefix|registers no global/i.test(map);
    if (!documentsAPrefix || deniesAPrefix) {
      errors.push(
        `${PATHS.mainEntry} calls setGlobalPrefix, but ${PATHS.contractMap} ${deniesAPrefix ? "states the backend registers no global prefix" : "does not document the prefix"}. Update the contract map or remove the prefix.`,
      );
    }
  }
  return { errors, warnings: [], summary: { globalPrefix: usesGlobalPrefix } };
}

/** Every contract check, in the order runCheck reports them. */
export const CONTRACT_CHECKS = [
  ["contract drift", checkContractDrift],
  ["global prefix invariant", checkGlobalPrefixInvariant],
  ["glossary", checkGlossary],
];
