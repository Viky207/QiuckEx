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
import {
  PATHS,
  fileExists,
  listControllerFiles,
  missingSections,
  readText,
  unique,
} from "./shared.mjs";

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

/**
 * Soroban error-code documentation - issue #573.
 *
 * Clients must be able to tell a retryable network failure from a stable
 * contract rejection. The error mapping table is the contract for that, so it
 * must cover every code the client mapper knows about, classify each one
 * explicitly, and give a safe user-facing interpretation.
 */
export const SOROBAN_DOCS_PATH = "app/contract/documentation/soroban.md";
export const ERROR_MAPPER_PATH = "app/mobile/utils/contract-error-mapper.ts";

/** The QuickexErrorCode members declared in the client error mapper. */
export function extractQuickexErrorCodes(source) {
  const codes = [];
  const enumMatch = source.match(/enum\s+QuickexErrorCode\s*\{([\s\S]*?)\}/);
  if (enumMatch) {
    for (const match of enumMatch[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) {
      codes.push(match[1]);
    }
  }
  // A union type (`type QuickexErrorCode = "A" | "B"`) is equally valid.
  const unionMatch = source.match(/type\s+QuickexErrorCode\s*=\s*([\s\S]*?);/);
  if (unionMatch) {
    for (const match of unionMatch[1].matchAll(/["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g)) {
      codes.push(match[1]);
    }
  }
  return unique(codes);
}

/**
 * Parse the error mapping table. A row is a markdown table line whose first
 * cell is a code; the remaining cells carry the classification and the
 * user-facing interpretation.
 */
export function parseSorobanErrorTable(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const code = cells[0].replace(/[`*]/g, "").trim();
    // Skip the header row and the separator row.
    if (!code || /^code$/i.test(code) || /^-+$/.test(code)) continue;
    if (/^:?-+:?$/.test(cells[0])) continue;
    rows.push({ code, cells });
  }
  return rows;
}

export function checkSorobanErrorDocs(root) {
  const errors = [];
  const warnings = [];
  const summary = { codes: 0, documented: 0, retryable: 0, nonRetryable: 0 };

  if (!fileExists(root, SOROBAN_DOCS_PATH)) {
    return { errors: [`${SOROBAN_DOCS_PATH} is missing`], warnings, summary };
  }
  if (!fileExists(root, ERROR_MAPPER_PATH)) {
    return { errors: [`${ERROR_MAPPER_PATH} is missing`], warnings, summary };
  }

  const codes = extractQuickexErrorCodes(readText(root, ERROR_MAPPER_PATH));
  summary.codes = codes.length;
  if (codes.length === 0) {
    errors.push(
      `${ERROR_MAPPER_PATH}: no QuickexErrorCode members found - the error mapper must declare its codes.`,
    );
  }

  const rows = parseSorobanErrorTable(readText(root, SOROBAN_DOCS_PATH));
  const byCode = new Map();
  for (const row of rows) {
    if (byCode.has(row.code)) {
      errors.push(`${SOROBAN_DOCS_PATH}: error code "${row.code}" is documented more than once.`);
      continue;
    }
    byCode.set(row.code, row);
  }

  for (const code of codes) {
    const row = byCode.get(code);
    if (!row) {
      errors.push(
        `${SOROBAN_DOCS_PATH}: error code "${code}" from ${ERROR_MAPPER_PATH} is missing from the error mapping table.`,
      );
      continue;
    }
    summary.documented += 1;

    const body = row.cells.slice(1).join(" ").toLowerCase();
    const retryable = /\bretryable\b/.test(body);
    const nonRetryable = /\bnon-retryable\b/.test(body);
    if (!retryable && !nonRetryable) {
      errors.push(
        `${SOROBAN_DOCS_PATH}: error code "${code}" has no explicit retryable/non-retryable classification.`,
      );
    } else if (retryable && nonRetryable) {
      errors.push(
        `${SOROBAN_DOCS_PATH}: error code "${code}" is classified as both retryable and non-retryable.`,
      );
    } else if (retryable) {
      summary.retryable += 1;
    } else {
      summary.nonRetryable += 1;
    }

    // The interpretation is the last cell; it must be present and non-empty.
    const interpretation = row.cells[row.cells.length - 1].replace(/[`*]/g, "").trim();
    if (!interpretation || interpretation === "-") {
      errors.push(
        `${SOROBAN_DOCS_PATH}: error code "${code}" has no user-facing interpretation.`,
      );
    }
  }

  return { errors, warnings, summary };
}

/**
 * Verified-asset onboarding guide - issue #572.
 *
 * Asset listing decisions need a repeatable checklist. The guide must cover
 * issuer proof, review ownership, the registry update path, and cache
 * invalidation so an operator can onboard or delist an asset without guessing.
 */
export const ASSET_ONBOARDING_PATH = "docs/ASSET-ONBOARDING-GUIDE.md";

export const ASSET_ONBOARDING_SECTIONS = [
  "Issuer proof",
  "Review ownership",
  "Registry update",
  "Cache invalidation",
  "Delisting",
];

export function checkAssetOnboardingGuide(root) {
  const errors = [];
  const warnings = [];
  const summary = { sections: ASSET_ONBOARDING_SECTIONS.length, present: 0 };

  if (!fileExists(root, ASSET_ONBOARDING_PATH)) {
    return { errors: [`${ASSET_ONBOARDING_PATH} is missing`], warnings, summary };
  }

  const text = readText(root, ASSET_ONBOARDING_PATH);
  const missing = missingSections(text, ASSET_ONBOARDING_SECTIONS);
  summary.present = ASSET_ONBOARDING_SECTIONS.length - missing.length;
  for (const section of missing) {
    errors.push(
      `${ASSET_ONBOARDING_PATH}: required section "${section}" is missing - the onboarding guide must cover issuer proof, review ownership, the registry update path, cache invalidation, and delisting.`,
    );
  }

  return { errors, warnings, summary };
}

/** Every contract check, in the order runCheck reports them. */
export const CONTRACT_CHECKS = [
  ["contract drift", checkContractDrift],
  ["global prefix invariant", checkGlobalPrefixInvariant],
  ["glossary", checkGlossary],
  ["soroban error docs", checkSorobanErrorDocs],
  ["asset onboarding guide", checkAssetOnboardingGuide],
];
