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

/**
 * Endpoints the troubleshooting guide depends on (issue #576). The guide links
 * readers to the machine-readable error registry, so the spec must keep
 * exposing it; a rename here would silently break every guide link.
 */
const REQUIRED_DOC_PATHS = ["/api/errors", "/api/errors/{code}"];

/**
 * Error codes the troubleshooting guide documents. Each must appear in the
 * canonical error registry enum so the guide cannot describe a code the API
 * never emits, or omit one it does.
 */
const REQUIRED_ERROR_CODES = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "internal_error",
];

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

const CURSOR_PARAM_NAMES = ["cursor", "after", "page_token", "pageToken", "next_cursor", "starting_after"];

/** True when a parameter looks like an opaque pagination cursor. */
function isCursorParameter(parameter) {
  if (!parameter || typeof parameter !== "object") return false;
  const name = parameter.name ?? parameter.$ref?.split("/").pop() ?? "";
  return CURSOR_PARAM_NAMES.includes(name);
}

/** Resolve a parameter that may be a `$ref` into its concrete definition. */
function derefParameter(document, parameter) {
  if (parameter && typeof parameter === "object" && typeof parameter.$ref === "string") {
    const resolved = resolveRef(document, parameter.$ref);
    if (!resolved.found) return null;
    let cursor = document;
    for (const segment of parameter.$ref.slice(2).split("/")) {
      cursor = cursor?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    return cursor ?? null;
  }
  return parameter;
}

/** Resolve a schema that may be a `$ref` into its concrete definition. */
function derefSchema(document, schema) {
  if (schema && typeof schema === "object" && typeof schema.$ref === "string") {
    if (!schema.$ref.startsWith("#/")) return null;
    let cursor = document;
    for (const segment of schema.$ref.slice(2).split("/")) {
      cursor = cursor?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    return cursor ?? null;
  }
  return schema;
}

/** Collect the textual prose attached to an operation (summary + description). */
function operationProse(operation) {
  return [operation.summary, operation.description].filter((value) => typeof value === "string").join("\n");
}

/**
 * Validate a single example value against a (dereferenced) schema, checking
 * required fields, primitive types and enum membership. Returns a list of
 * human-readable problems; an empty list means the example conforms.
 */
export function validateExampleAgainstSchema(document, schema, value, where, problems = [], depth = 0) {
  if (depth > 12) return problems;
  const resolved = derefSchema(document, schema);
  if (!resolved || typeof resolved !== "object") return problems;

  if (resolved.type === "object" || resolved.properties) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`${where}: expected an object`);
      return problems;
    }
    for (const required of resolved.required ?? []) {
      if (!(required in value)) problems.push(`${where}: missing required field "${required}"`);
    }
    for (const [key, childSchema] of Object.entries(resolved.properties ?? {})) {
      if (key in value) validateExampleAgainstSchema(document, childSchema, value[key], `${where}.${key}`, problems, depth + 1);
    }
    return problems;
  }

  if (resolved.type === "array") {
    if (!Array.isArray(value)) {
      problems.push(`${where}: expected an array`);
      return problems;
    }
    if (resolved.items) {
      value.forEach((entry, index) =>
        validateExampleAgainstSchema(document, resolved.items, entry, `${where}[${index}]`, problems, depth + 1),
      );
    }
    return problems;
  }

  if (Array.isArray(resolved.enum) && !resolved.enum.includes(value)) {
    problems.push(`${where}: value ${JSON.stringify(value)} is not one of ${JSON.stringify(resolved.enum)}`);
  }

  const typeChecks = {
    string: (v) => typeof v === "string",
    integer: (v) => typeof v === "number" && Number.isInteger(v),
    number: (v) => typeof v === "number" && Number.isFinite(v),
    boolean: (v) => typeof v === "boolean",
  };
  if (resolved.type && typeChecks[resolved.type] && !typeChecks[resolved.type](value)) {
    problems.push(`${where}: expected type ${resolved.type}, got ${Array.isArray(value) ? "array" : typeof value}`);
  }
  return problems;
}

/** Pull every embedded example out of a media-type object. */
function mediaExamples(media) {
  const examples = [];
  if (media && typeof media === "object") {
    if ("example" in media) examples.push(media.example);
    for (const entry of Object.values(media.examples ?? {})) {
      if (entry && typeof entry === "object" && "value" in entry) examples.push(entry.value);
    }
  }
  return examples;
}

/**
 * Cursor pagination documentation — issue #571.
 *
 * Paginated operations must explain that cursors are opaque (clients must not
 * construct them), how page limits are constrained, how a client knows it has
 * reached the last page, when cursors expire, and what an invalid cursor looks
 * like. Embedded request/response examples must also conform to the component
 * schemas they claim to illustrate.
 */
export function checkPaginationDocs(root) {
  const errors = [];
  const warnings = [];
  const summary = { paginatedOperations: 0, examples: 0 };

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

  const operations = collectOperations(document);
  for (const { method, path, operation } of operations) {
    const where = `${method.toUpperCase()} ${path}`;
    const parameters = (operation.parameters ?? []).map((parameter) => derefParameter(document, parameter));
    const cursorParams = parameters.filter(isCursorParameter);
    if (cursorParams.length === 0) continue;
    summary.paginatedOperations += 1;

    const prose = operationProse(operation).toLowerCase();
    if (!/opaque/.test(prose)) {
      errors.push(`${PATHS.openapi}: ${where} has a cursor parameter but does not state that cursors are opaque`);
    }
    if (!/(do not|don't|must not|never) (construct|build|create|parse|modify)/.test(prose)) {
      errors.push(`${PATHS.openapi}: ${where} does not tell clients not to construct or parse cursors`);
    }
    if (!/(last page|no more|next_cursor|nextcursor|has_more|hasmore|end of|terminat)/.test(prose)) {
      errors.push(`${PATHS.openapi}: ${where} does not explain how clients detect the final page`);
    }
    if (!/(expire|expiry|expires|ttl|valid for)/.test(prose)) {
      errors.push(`${PATHS.openapi}: ${where} does not document cursor expiry`);
    }

    for (const parameter of cursorParams) {
      if (parameter.schema && parameter.schema.type && parameter.schema.type !== "string") {
        errors.push(`${PATHS.openapi}: ${where} cursor parameter "${parameter.name}" must be a string`);
      }
    }

    const limitParams = parameters.filter((parameter) => parameter && parameter.name === "limit");
    for (const parameter of limitParams) {
      const schema = derefSchema(document, parameter.schema) ?? {};
      if (schema.maximum === undefined) {
        errors.push(`${PATHS.openapi}: ${where} \`limit\` parameter has no \`maximum\``);
      }
      if (schema.minimum === undefined) {
        warnings.push(`${PATHS.openapi}: ${where} \`limit\` parameter has no \`minimum\``);
      }
    }

    const responses = operation.responses ?? {};
    const hasInvalidCursor = Object.entries(responses).some(([code, response]) => {
      if (!/^4\d\d$/.test(code)) return false;
      const text = JSON.stringify(response ?? {}).toLowerCase();
      return /cursor/.test(text);
    });
    if (!hasInvalidCursor) {
      errors.push(`${PATHS.openapi}: ${where} does not document an invalid-cursor error response`);
    }

    const requestExamples = (operation.requestBody?.content
      ? Object.values(operation.requestBody.content).flatMap(mediaExamples)
      : []);
    const responseExamples = Object.values(responses).flatMap((response) =>
      response?.content ? Object.values(response.content).flatMap(mediaExamples) : [],
    );
    const allExamples = [...requestExamples, ...responseExamples];
    summary.examples += allExamples.length;

    for (const [code, response] of Object.entries(responses)) {
      const schema = response?.content
        ? Object.values(response.content).map((media) => media?.schema).find(Boolean)
        : undefined;
      if (!schema) continue;
      for (const example of mediaExamples(Object.values(response.content)[0])) {
        for (const problem of validateExampleAgainstSchema(document, schema, example, `${where} ${code} example`)) {
          errors.push(`${PATHS.openapi}: ${problem}`);
        }
      }
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

  checkTroubleshootingContract(document, errors, warnings);

  return { errors, warnings, summary };
}

/**
 * Validate the error-code contract the troubleshooting guide is keyed by
 * (issue #576). The guide is generated from the canonical registry, so the
 * spec must expose the registry endpoints and a stable, non-empty enum of
 * public codes that covers every code the guide documents.
 */
function checkTroubleshootingContract(document, errors, warnings) {
  const paths = document.paths ?? {};
  for (const required of REQUIRED_DOC_PATHS) {
    if (!paths[required]) {
      errors.push(`${PATHS.openapi}: missing "${required}", which the troubleshooting guide links to`);
    }
  }

  const errorCodeSchema = document.components?.schemas?.ErrorCode;
  if (!errorCodeSchema) {
    errors.push(`${PATHS.openapi}: missing the \`ErrorCode\` schema the troubleshooting guide is keyed by`);
    return;
  }

  const codes = Array.isArray(errorCodeSchema.enum) ? errorCodeSchema.enum : [];
  if (codes.length === 0) {
    errors.push(`${PATHS.openapi}: \`ErrorCode\` declares no enum values, so the guide has nothing to key on`);
    return;
  }

  const seen = new Set();
  for (const code of codes) {
    if (typeof code !== "string" || code.length === 0) {
      errors.push(`${PATHS.openapi}: \`ErrorCode\` contains a non-string or empty value`);
      continue;
    }
    if (seen.has(code)) {
      errors.push(`${PATHS.openapi}: \`ErrorCode\` lists "${code}" more than once`);
    }
    seen.add(code);
  }

  for (const code of REQUIRED_ERROR_CODES) {
    if (!seen.has(code)) {
      errors.push(`${PATHS.openapi}: \`ErrorCode\` is missing "${code}", which the troubleshooting guide documents`);
    }
  }

  const undocumented = [...seen].filter((code) => !REQUIRED_ERROR_CODES.includes(code));
  if (undocumented.length > 0) {
    warnings.push(
      `${PATHS.openapi}: \`ErrorCode\` lists ${undocumented.map((code) => `"${code}"`).join(", ")} without a troubleshooting entry`,
    );
  }
}
