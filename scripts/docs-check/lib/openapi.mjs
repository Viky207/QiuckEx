/**
 * OpenAPI document structure and internal consistency — issue #295.
 *
 * `docs/openapi.json` is the machine-readable contract clients generate
 * against, so a malformed or self-contradictory document is worse than no
 * document at all: it looks authoritative while being wrong.
 *
 * Every rule here is internal to the document (it never needs the server to be
 * running), which is what lets the gate run on a fresh clone in CI.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS, readJson, unique } from "./shared.mjs";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];

/** Resolve a local JSON pointer (`#/components/schemas/Foo`) against a document. */
export function resolveRef(document, ref) {
  if (!ref.startsWith("#/")) return { found: true, external: true };
  let cursor = document;
  for (const segment of ref.slice(2).split("/")) {
    if (cursor === undefined || cursor === null) return { found: false };
    cursor = cursor[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return { found: cursor !== undefined };
}

/** Every operation in a document, as `{ method, path, operation }`. */
export function collectOperations(document) {
  const operations = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method)) continue;
      operations.push({ method, path, operation });
    }
  }
  return operations;
}

/** Every `$ref` string appearing anywhere in a document. */
export function collectRefs(node, found = new Set()) {
  if (Array.isArray(node)) {
    for (const entry of node) collectRefs(entry, found);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") found.add(value);
      else collectRefs(value, found);
    }
  }
  return found;
}

/**
 * Parse the deprecation migration guide (issue #580).
 *
 * The guide is a Markdown template maintainers fill in per release. We only
 * understand the small, stable subset of its shape:
 *
 *   - a `Guide version: <x.y.z>` line, which must match `info.version`;
 *   - a table whose header contains `Alias` and `Replacement` columns, where
 *     each row names a deprecated alias and the endpoint that replaces it.
 *
 * Anything else is ignored, so prose can change freely without breaking the
 * gate. Returns `{ version, rows }` where each row is `{ alias, replacement }`.
 */
export function parseMigrationGuide(text) {
  const versionMatch = text.match(/^\s*Guide version:\s*`?([^`\s]+)`?\s*$/m);
  const version = versionMatch ? versionMatch[1] : null;

  const rows = [];
  const lines = text.split(/\r?\n/);
  let columns = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      columns = null;
      continue;
    }
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (!columns) {
      const aliasIndex = cells.findIndex((cell) => /^alias$/i.test(cell));
      const replacementIndex = cells.findIndex((cell) => /^replacement$/i.test(cell));
      if (aliasIndex !== -1 && replacementIndex !== -1) columns = { aliasIndex, replacementIndex };
      continue;
    }
    const alias = cells[columns.aliasIndex] ?? "";
    const replacement = cells[columns.replacementIndex] ?? "";
    if (!alias || !replacement) continue;
    rows.push({ alias, replacement });
  }

  return { version, rows };
}

/** Extract the path portion of an endpoint cell like `` `GET /v1/things` ``. */
export function endpointPath(cell) {
  const match = cell.match(/`?\b(?:GET|PUT|POST|DELETE|PATCH|OPTIONS|HEAD|TRACE)\s+(\/[^\s`]*)`?/i);
  if (match) return match[1];
  const bare = cell.match(/`?(\/[^\s`]*)`?/);
  return bare ? bare[1] : null;
}

/**
 * Validate the migration guide against the OpenAPI contract.
 *
 * Errors: a documented replacement endpoint that is not in the document.
 * Warnings: a guide version that has drifted from `info.version`, or a guide
 * that cannot be parsed at all (so a typo does not silently disable the gate).
 */
export function checkMigrationGuide(root) {
  const errors = [];
  const warnings = [];
  const summary = { version: null, rows: 0, checked: 0 };

  let text;
  try {
    text = readFileSync(join(root, PATHS.migrationGuide), "utf8");
  } catch {
    return { errors, warnings, summary };
  }

  let document;
  try {
    document = readJson(root, PATHS.openapi);
  } catch {
    // The structure check already reports an unreadable document.
    return { errors, warnings, summary };
  }

  const { version, rows } = parseMigrationGuide(text);
  summary.version = version;
  summary.rows = rows.length;

  if (!version) {
    warnings.push(`${PATHS.migrationGuide}: no \`Guide version:\` line, so it cannot be checked against \`info.version\``);
  } else if (document.info?.version && version !== document.info.version) {
    warnings.push(
      `${PATHS.migrationGuide}: guide version ${version} is stale; \`info.version\` is ${document.info.version}`,
    );
  }

  const documentedPaths = new Set(Object.keys(document.paths ?? {}));
  for (const { alias, replacement } of rows) {
    const path = endpointPath(replacement);
    if (!path) {
      warnings.push(`${PATHS.migrationGuide}: replacement for "${alias}" does not name an endpoint path`);
      continue;
    }
    summary.checked += 1;
    if (!documentedPaths.has(path)) {
      errors.push(
        `${PATHS.migrationGuide}: replacement for "${alias}" points at ${path}, which is not in ${PATHS.openapi}`,
      );
    }
  }

  return { errors, warnings, summary };
}

export function checkOpenApiStructure(root) {
  const errors = [];
  const warnings = [];
  const summary = { paths: 0, operations: 0, schemas: 0, tags: 0 };

  let document;
  try {
    document = readJson(root, PATHS.openapi);
  } catch (error) {
    return {
      errors: [`${PATHS.openapi} is not valid JSON: ${error.message}`],
      warnings,
      summary,
    };
  }

  if (typeof document.openapi !== "string" || !document.openapi.startsWith("3.")) {
    errors.push(`${PATHS.openapi}: missing a 3.x \`openapi\` version`);
  }
  for (const field of ["info", "paths"]) {
    if (!document[field]) errors.push(`${PATHS.openapi}: missing the required \`${field}\` field`);
  }
  if (document.info) {
    for (const field of ["title", "version"]) {
      if (!document.info[field]) errors.push(`${PATHS.openapi}: \`info.${field}\` is required`);
    }
  }
  if (Object.keys(document.paths ?? {}).length === 0) {
    errors.push(`${PATHS.openapi}: \`paths\` is empty, so no route is documented`);
  }
  summary.paths = Object.keys(document.paths ?? {}).length;
  summary.schemas = Object.keys(document.components?.schemas ?? {}).length;
  summary.tags = (document.tags ?? []).length;

  const operations = collectOperations(document);
  summary.operations = operations.length;

  for (const { method, path, operation } of operations) {
    const where = `${method.toUpperCase()} ${path}`;
    if (!operation.responses || Object.keys(operation.responses).length === 0) {
      errors.push(`${PATHS.openapi}: ${where} declares no responses`);
    }
    if (!operation.tags || operation.tags.length === 0) {
      errors.push(`${PATHS.openapi}: ${where} has no tag, so it cannot be grouped in the docs UI`);
    }
    if (!operation.operationId) {
      warnings.push(`${PATHS.openapi}: ${where} has no \`operationId\`, which generators use for client method names`);
    }
    if (!operation.description && !operation.summary) {
      errors.push(`${PATHS.openapi}: ${where} has neither a summary nor a description`);
    }
    if (path.includes("//")) {
      errors.push(`${PATHS.openapi}: "${path}" contains an empty path segment`);
    }
  }

  const declaredTags = new Set((document.tags ?? []).map((tag) => tag.name));
  for (const name of unique(operations.flatMap(({ operation }) => operation.tags ?? []))) {
    if (!declaredTags.has(name)) {
      errors.push(`${PATHS.openapi}: operations use the tag "${name}", which is not declared in \`tags\``);
    }
  }

  const refs = collectRefs(document);
  for (const ref of refs) {
    if (!resolveRef(document, ref).found) {
      errors.push(`${PATHS.openapi}: \`${ref}\` does not resolve to anything in the document`);
    }
  }

  const schemaNames = new Set(Object.keys(document.components?.schemas ?? {}));
  const usedSchemas = new Set(
    [...refs]
      .filter((ref) => ref.startsWith("#/components/schemas/"))
      .map((ref) => ref.split("/").pop()),
  );
  for (const name of usedSchemas) {
    if (!schemaNames.has(name)) {
      errors.push(`${PATHS.openapi}: schema "${name}" is referenced but not declared`);
    }
  }
  for (const name of schemaNames) {
    if (!usedSchemas.has(name)) {
      warnings.push(`${PATHS.openapi}: schema "${name}" is declared but never referenced`);
    }
  }

  return { errors, warnings, summary };
}
