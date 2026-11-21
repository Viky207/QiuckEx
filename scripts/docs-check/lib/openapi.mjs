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
import { PATHS, readJson, readText, unique } from "./shared.mjs";

/**
 * Canonical payment intent lifecycle states — issue #568.
 *
 * These are the implemented stable values from the backend contract. The
 * lifecycle document and the OpenAPI schema must both agree with this list,
 * otherwise client and operator docs drift from the delivered behavior.
 */
export const PAYMENT_INTENT_STATES = ["pending", "submitted", "confirmed", "expired", "failed"];

/** Terminal states: no further transitions are possible from these. */
export const PAYMENT_INTENT_TERMINAL_STATES = ["confirmed", "expired", "failed"];

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

  const lifecycle = checkPaymentIntentStates(root, document);
  errors.push(...lifecycle.errors);
  warnings.push(...lifecycle.warnings);

  return { errors, warnings, summary };
}

/**
 * Find every schema property that enumerates payment intent states.
 *
 * A property qualifies when its name mentions `status`/`state` and it carries
 * an `enum` whose values overlap the canonical state list. This keeps the rule
 * scoped to payment intent state enums without hard-coding a schema name.
 */
export function collectPaymentIntentStateEnums(document) {
  const found = [];
  const schemas = document.components?.schemas ?? {};
  for (const [schemaName, schema] of Object.entries(schemas)) {
    for (const [propertyName, property] of Object.entries(schema?.properties ?? {})) {
      if (!/status|state/i.test(propertyName)) continue;
      if (!Array.isArray(property?.enum)) continue;
      if (!property.enum.some((value) => PAYMENT_INTENT_STATES.includes(value))) continue;
      found.push({ schemaName, propertyName, values: property.enum });
    }
  }
  return found;
}

/**
 * Validate that payment intent state enums match the canonical lifecycle.
 *
 * Returns errors for missing/extra states and warnings for terminal states that
 * are not documented as terminal in the lifecycle document.
 */
export function checkPaymentIntentStates(root, document) {
  const errors = [];
  const warnings = [];
  const enums = collectPaymentIntentStateEnums(document);

  if (enums.length === 0) {
    errors.push(
      `${PATHS.openapi}: no payment intent state enum found; expected one of ${PAYMENT_INTENT_STATES.join(", ")}`,
    );
    return { errors, warnings };
  }

  for (const { schemaName, propertyName, values } of enums) {
    const where = `${schemaName}.${propertyName}`;
    const missing = PAYMENT_INTENT_STATES.filter((state) => !values.includes(state));
    const extra = values.filter((value) => !PAYMENT_INTENT_STATES.includes(value));
    if (missing.length > 0) {
      errors.push(`${PATHS.openapi}: ${where} is missing payment intent state(s): ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      errors.push(`${PATHS.openapi}: ${where} declares unknown payment intent state(s): ${extra.join(", ")}`);
    }
  }

  const lifecycle = readLifecycleDocument(root);
  if (lifecycle.error) {
    errors.push(lifecycle.error);
  } else {
    const documented = new Set(lifecycle.states);
    for (const state of PAYMENT_INTENT_STATES) {
      if (!documented.has(state)) {
        errors.push(`${PATHS.openapi}: lifecycle document does not document the "${state}" state`);
      }
    }
    for (const state of lifecycle.states) {
      if (!PAYMENT_INTENT_STATES.includes(state)) {
        errors.push(`${PATHS.openapi}: lifecycle document documents unknown state "${state}"`);
      }
    }
    for (const state of PAYMENT_INTENT_TERMINAL_STATES) {
      if (!lifecycle.terminal.has(state)) {
        warnings.push(`${PATHS.openapi}: lifecycle document does not mark "${state}" as terminal`);
      }
    }
  }

  return { errors, warnings };
}

/**
 * Read the canonical lifecycle document and extract the states it lists.
 *
 * The document is expected to contain a fenced block or list of state names;
 * we extract every canonical state token that appears in it so the check stays
 * robust to formatting changes while still catching omissions.
 */
export function readLifecycleDocument(root) {
  let text;
  try {
    text = readText(root, PATHS.paymentIntentLifecycle);
  } catch (error) {
    return { error: `${PATHS.paymentIntentLifecycle} is missing or unreadable: ${error.message}`, states: [], terminal: new Set() };
  }

  const states = PAYMENT_INTENT_STATES.filter((state) =>
    new RegExp(`\\b${state}\\b`, "i").test(text),
  );
  const terminal = new Set(
    PAYMENT_INTENT_TERMINAL_STATES.filter((state) =>
      new RegExp(`\\b${state}\\b[^\\n]*\\bterminal\\b`, "i").test(text),
    ),
  );
  return { states, terminal };
}
