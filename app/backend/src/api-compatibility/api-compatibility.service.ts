import { Injectable, Logger } from '@nestjs/common';
import { OpenApiDocumentHolder } from './openapi-document.holder';
import { ERROR_REGISTRY } from '../errors/error-registry';

/**
 * Classification of a detected change between two OpenAPI documents.
 */
export type ChangeSeverity = 'breaking' | 'non-breaking';

/**
 * A single structural difference between the baseline and current spec.
 */
export interface ApiChange {
  /** Stable, deterministic identifier for the change (used for allowlisting). */
  id: string;
  severity: ChangeSeverity;
  /** Logical category of the change. */
  kind:
    | 'path-removed'
    | 'path-added'
    | 'method-removed'
    | 'method-added'
    | 'request-parameter-removed'
    | 'request-parameter-added'
    | 'request-parameter-required'
    | 'request-parameter-optional'
    | 'request-body-removed'
    | 'request-body-added'
    | 'request-body-required'
    | 'request-body-optional'
    | 'request-property-removed'
    | 'request-property-added'
    | 'request-property-required'
    | 'request-property-optional'
    | 'request-property-type-changed'
    | 'request-enum-value-removed'
    | 'request-enum-value-added'
    | 'response-status-removed'
    | 'response-status-added'
    | 'response-property-removed'
    | 'response-property-added'
    | 'response-property-required'
    | 'response-property-optional'
    | 'response-property-type-changed'
    | 'response-enum-value-removed'
    | 'response-enum-value-added'
    | 'error-code-removed'
    | 'error-code-added';
  /** HTTP path the change applies to (e.g. `/users/{id}`). */
  path: string;
  /** HTTP method (lowercase) the change applies to, when applicable. */
  method?: string;
  /** Dotted location within the operation (e.g. `request.body.name`). */
  location?: string;
  /** Human readable description of the change. */
  message: string;
}

/**
 * The result of diffing a baseline spec against a current spec.
 */
export interface ApiCompatibilityReport {
  /** All detected changes, sorted deterministically. */
  changes: ApiChange[];
  /** Changes that were suppressed by the allowlist/override. */
  allowed: ApiChange[];
  /** Breaking changes that were not suppressed. */
  breaking: ApiChange[];
  /** Non-breaking changes that were not suppressed. */
  nonBreaking: ApiChange[];
  /** True when there are no unsuppressed breaking changes. */
  compatible: boolean;
  /**
   * Public stable error codes whose presence in the canonical registry differs
   * between the baseline and current documents. Used to keep the
   * troubleshooting guide in sync when codes are added or removed.
   */
  errorCodeChanges: ErrorCodeChange[];
}

/**
 * A change to the set of public stable error codes.
 */
export interface ErrorCodeChange {
  /** The public stable error code (e.g. `RESOURCE_NOT_FOUND`). */
  code: string;
  /** Whether the code was added or removed relative to the baseline. */
  change: 'added' | 'removed';
}

/**
 * Extracts the set of public stable error codes referenced by an OpenAPI
 * document. Codes are sourced from the canonical error registry; internal-only
 * codes are excluded so they never leak into the troubleshooting guide.
 */
function collectPublicErrorCodes(
  doc: OpenApiDocument | undefined,
): Set<string> {
  const codes = new Set<string>();
  if (!doc) {
    return codes;
  }

  const publicCodes = new Set(
    ERROR_REGISTRY.filter((entry) => entry.public).map((entry) => entry.code),
  );

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!isPlainObject(value)) {
      return;
    }
    const enumValues = value.enum;
    if (Array.isArray(enumValues)) {
      for (const candidate of enumValues) {
        if (typeof candidate === 'string' && publicCodes.has(candidate)) {
          codes.add(candidate);
        }
      }
    }
    for (const key of Object.keys(value)) {
      visit(value[key]);
    }
  };

  visit(doc);
  return codes;
}

/**
 * Computes the added/removed public stable error codes between two documents.
 */
function diffErrorCodes(
  baseline: OpenApiDocument | undefined,
  current: OpenApiDocument | undefined,
): ErrorCodeChange[] {
  const baselineCodes = collectPublicErrorCodes(baseline);
  const currentCodes = collectPublicErrorCodes(current);

  const changes: ErrorCodeChange[] = [];
  for (const code of currentCodes) {
    if (!baselineCodes.has(code)) {
      changes.push({ code, change: 'added' });
    }
  }
  for (const code of baselineCodes) {
    if (!currentCodes.has(code)) {
      changes.push({ code, change: 'removed' });
    }
  }

  return changes.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/**
 * Minimal structural shape of an OpenAPI document used by the diff engine.
 * We intentionally avoid a hard dependency on a specific OpenAPI typings
 * package so the engine stays resilient to schema variations.
 */
export interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  paths?: Record<string, PathItemObject>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PathItemObject {
  [method: string]: OperationObject | unknown;
}

export interface OperationObject {
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
  [key: string]: unknown;
}

export interface ParameterObject {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: SchemaObject;
  [key: string]: unknown;
}

export interface RequestBodyObject {
  required?: boolean;
  content?: Record<string, MediaTypeObject>;
  [key: string]: unknown;
}

export interface ResponseObject {
  content?: Record<string, MediaTypeObject>;
  [key: string]: unknown;
}

export interface MediaTypeObject {
  schema?: SchemaObject;
  [key: string]: unknown;
}

export interface SchemaObject {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  enum?: unknown[];
  $ref?: string;
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  [key: string]: unknown;
}

const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
];

/**
 * Resolves a `$ref` pointer (e.g. `#/components/schemas/Foo`) against the
 * document. Returns the referenced object or `undefined` when unresolvable.
 */
function resolveRef(
  doc: OpenApiDocument,
  ref: string,
  seen: Set<string> = new Set(),
): SchemaObject | undefined {
  if (!ref || !ref.startsWith('#/')) {
    return undefined;
  }
  if (seen.has(ref)) {
    // Circular reference guard.
    return undefined;
  }
  seen.add(ref);

  const segments = ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

  let current: unknown = doc;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  if (current && typeof current === 'object') {
    const resolved = current as SchemaObject;
    if (resolved.$ref) {
      return resolveRef(doc, resolved.$ref, seen);
    }
    return resolved;
  }
  return undefined;
}

/**
 * Fully resolves a schema, following `$ref` and merging `allOf` members.
 */
function dereferenceSchema(
  doc: OpenApiDocument,
  schema: SchemaObject | undefined,
): SchemaObject | undefined {
  if (!schema) {
    return undefined;
  }

  if (schema.$ref) {
    const resolved = resolveRef(doc, schema.$ref);
    return dereferenceSchema(doc, resolved);
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged: SchemaObject = { ...schema };
    delete merged.allOf;
    const properties: Record<string, SchemaObject> = {
      ...(merged.properties ?? {}),
    };
    const required = new Set<string>(merged.required ?? []);

    for (const member of schema.allOf) {
      const resolvedMember = dereferenceSchema(doc, member);
      if (!resolvedMember) {
        continue;
      }
      if (resolvedMember.properties) {
        Object.assign(properties, resolvedMember.properties);
      }
      for (const req of resolvedMember.required ?? []) {
        required.add(req);
      }
      if (!merged.type && resolvedMember.type) {
        merged.type = resolvedMember.type;
      }
      if (resolvedMember.enum && !merged.enum) {
        merged.enum = resolvedMember.enum;
      }
    }

    merged.properties = properties;
    if (required.size > 0) {
      merged.required = Array.from(required);
    }
    return merged;
  }

  return schema;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value)
  );
}

function normalizeType(type: string | string[] | undefined): string[] {
  if (!type) {
    return [];
  }
  return (Array.isArray(type) ? type : [type]).slice().sort();
}

function typesEqual(
  a: string | string[] | undefined,
  b: string | string[] | undefined,
): boolean {
  const left = normalizeType(a);
  const right = normalizeType(b);
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function enumValues(schema: SchemaObject | undefined): unknown[] {
  if (!schema || !Array.isArray(schema.enum)) {
    return [];
  }
  return schema.enum;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify(
          (value as Record<string, unknown>)[key],
        )}`,
    )
    .join(',')}}`;
}

function makeChangeId(change: Omit<ApiChange, 'id' | 'message'>): string {
  return [
    change.severity,
    change.kind,
    change.method ?? '',
    change.path,
    change.location ?? '',
  ].join('|');
}

function buildChange(
  change: Omit<ApiChange, 'id' | 'message'> & { message: string },
): ApiChange {
  return {
    ...change,
    id: makeChangeId(change),
  };
}

interface DiffContext {
  doc: OpenApiDocument;
  changes: ApiChange[];
}

function pushChange(
  ctx: DiffContext,
  change: Omit<ApiChange, 'id' | 'message'> & { message: string },
): void {
  ctx.changes.push(buildChange(change));
}

/**
 * Compares two schemas and records structural differences.
 *
 * @param baselineDoc document used to resolve baseline `$ref`s
 * @param currentDoc document used to resolve current `$ref`s
 * @param baseline baseline schema
 * @param current current schema
 * @param direction whether the schema describes a request or a response
 */
function diffSchema(
  baselineDoc: OpenApiDocument,
  currentDoc: OpenApiDocument,
  baseline: SchemaObject | undefined,
  current: SchemaObject | undefined,
  direction: 'request' | 'response',
  path: string,
  method: string,
  location: string,
  changes: ApiChange[],
): void {
  const base = dereferenceSchema(baselineDoc, baseline);
  const curr = dereferenceSchema(currentDoc, current);

  if (!base && !curr) {
    return;
  }

  // Type changes.
  if (base && curr && !typesEqual(base.type, curr.type)) {
    changes.push(
      buildChange({
        severity: 'breaking',
        kind:
          direction === 'request'
            ? 'request-property-type-changed'
            : 'response-property-type-changed',
        path,
        method,
        location,
        message: `Type changed from ${JSON.stringify(
          base.type ?? 'any',
        )} to ${JSON.stringify(curr.type ?? 'any')} at ${location}`,
      }),
    );
  }

  // Enum changes.
  const baseEnum = enumValues(base);
  const currEnum = enumValues(curr);
  if (baseEnum.length > 0 || currEnum.length > 0) {
    const baseSet = new Set(baseEnum.map(stableStringify));
    const currSet = new Set(currEnum.map(stableStringify));

    for (const value of baseEnum) {
      if (!currSet.has(stableStringify(value))) {
        changes.push(
          buildChange({
            severity: direction === 'request' ? 'breaking' : 'breaking',
            kind:
              direction === 'request'
                ? 'request-enum-value-removed'
                : 'response-enum-value-removed',
            path,
            method,
            location,
            message: `Enum value ${JSON.stringify(value)} removed at ${location}`,
          }),
        );
      }
    }

    for (const value of currEnum) {
      if (!baseSet.has(stableStringify(value))) {
        changes.push(
          buildChange({
            severity: direction === 'request' ? 'non-breaking' : 'breaking',
            kind:
              direction === 'request'
                ? 'request-enum-value-added'
                : 'response-enum-value-added',
            path,
            method,
            location,
            message: `Enum value ${JSON.stringify(value)} added at ${location}`,
          }),
        );
      }
    }
  }

  // Object property changes.
  const baseProps = base?.properties ?? {};
  const currProps = curr?.properties ?? {};
  const baseRequired = new Set(base?.required ?? []);
  const currRequired = new Set(curr?.required ?? []);

  for (const propName of Object.keys(baseProps)) {
    const propLocation = `${location}.${propName}`;
    if (!(propName in currProps)) {
      changes.push(
        buildChange({
          severity: direction === 'request' ? 'breaking' : 'non-breaking',
          kind:
            direction === 'request'
              ? 'request-property-removed'
              : 'response-property-removed',
          path,
          method,
          location: propLocation,
          message: `Property ${propName} removed at ${propLocation}`,
        }),
      );
      continue;
    }

    // Required-ness transitions.
    const wasRequired = baseRequired.has(propName);
    const isRequired = currRequired.has(propName);
    if (wasRequired !== isRequired) {
      if (direction === 'request') {
        if (!wasRequired && isRequired) {
          changes.push(
            buildChange({
              severity: 'breaking',
              kind: 'request-property-required',
              path,
              method,
              location: propLocation,
              message: `Property ${propName} became required at ${propLocation}`,
            }),
          );
        } else {
          changes.push(
            buildChange({
              severity: 'non-breaking',
              kind: 'request-property-optional',
              path,
              method,
              location: propLocation,
              message: `Property ${propName} became optional at ${propLocation}`,
            }),
          );
        }
      } else {
        if (!wasRequired && isRequired) {
          changes.push(
            buildChange({
              severity: 'non-breaking',
              kind: 'response-property-required',
              path,
              method,
              location: propLocation,
              message: `Property ${propName} became required at ${propLocation}`,
            }),
          );
        } else {
          changes.push(
            buildChange({
              severity: 'breaking',
              kind: 'response-property-optional',
              path,
              method,
              location: propLocation,
              message: `Property ${propName} became optional at ${propLocation}`,
            }),
          );
        }
      }
    }

    diffSchema(
      baselineDoc,
      currentDoc,
      baseProps[propName],
      currProps[propName],
      direction,
      path,
      method,
      propLocation,
      changes,
    );
  }

  for (const propName of Object.keys(currProps)) {
    if (propName in baseProps) {
      continue;
    }
    const propLocation = `${location}.${propName}`;
    changes.push(
      buildChange({
        severity: direction === 'request' ? 'non-breaking' : 'breaking',
        kind:
          direction === 'request'
            ? 'request-property-added'
            : 'response-property-added',
        path,
        method,
        location: propLocation,
        message: `Property ${propName} added at ${propLocation}`,
      }),
    );
  }

  // Array item changes.
  if (base?.items || curr?.items) {
    diffSchema(
      baselineDoc,
      currentDoc,
      base?.items,
      curr?.items,
      direction,
      path,
      method,
      `${location}[]`,
      changes,
    );
  }
}

function diffParameters(
  baselineDoc: OpenApiDocument,
  currentDoc: OpenApiDocument,
  baselineParams: ParameterObject[],
  currentParams: ParameterObject[],
  path: string,
  method: string,
  changes: ApiChange[],
): void {
  const keyOf = (param: ParameterObject): string =>
    `${param.in ?? 'query'}:${param.name ?? ''}`;

  const baseMap = new Map<string, ParameterObject>();
  for (const param of baselineParams) {
    baseMap.set(keyOf(param), param);
  }
  const currMap = new Map<string, ParameterObject>();
  for (const param of currentParams) {
    currMap.set(keyOf(param), param);
  }

  for (const [key, baseParam] of baseMap) {
    const location = `parameters.${key}`;
    const currParam = currMap.get(key);
    if (!currParam) {
      changes.push(
        buildChange({
          severity: 'breaking',
          kind: 'request-parameter-removed',
          path,
          method,
          location,
          message: `Parameter ${key} removed`,
        }),
      );
      continue;
    }

    const wasRequired = baseParam.required === true;
    const isRequired = currParam.required === true;
    if (wasRequired !== isRequired) {
      if (!wasRequired && isRequired) {
        changes.push(
          buildChange({
            severity: 'breaking',
            kind: 'request-parameter-required',
            path,
            method,
            location,
            message: `Parameter ${key} became required`,
          }),
        );
      } else {
        changes.push(
          buildChange({
            severity: 'non-breaking',
            kind: 'request-parameter-optional',
            path,
            method,
            location,
            message: `Parameter ${key} became optional`,
          }),
        );
      }
    }

    diffSchema(
      baselineDoc,
      currentDoc,
      baseParam.schema,
      currParam.schema,
      'request',
      path,
      method,
      location,
      changes,
    );
  }

  for (const [key] of currMap) {
    if (baseMap.has(key)) {
      continue;
    }
    const location = `parameters.${key}`;
    changes.push(
      buildChange({
        severity: 'non-breaking',
        kind: 'request-parameter-added',
        path,
        method,
        location,
        message: `Parameter ${key} added`,
      }),
    );
  }
}

function diffRequestBody(
  baselineDoc: OpenApiDocument,
  currentDoc: OpenApiDocument,
  baselineBody: RequestBodyObject | undefined,
  currentBody: RequestBodyObject | undefined,
  path: string,
  method: string,
  changes: ApiChange[],
): void {
  if (baselineBody && !currentBody) {
    changes.push(
      buildChange({
        severity: 'breaking',
        kind: 'request-body-removed',
        path,
        method,
        location: 'request.body',
        message: 'Request body removed',
      }),
    );
    return;
  }

  if (!baselineBody && currentBody) {
    changes.push(
      buildChange({
        severity: 'non-breaking',
        kind: 'request-body-added',
        path,
        method,
        location: 'request.body',
        message: 'Request body added',
      }),
    );
    return;
  }

  if (!baselineBody || !currentBody) {
    return;
  }

  const wasRequired = baselineBody.required === true;
  const isRequired = currentBody.required === true;
  if (wasRequired !== isRequired) {
    if (!wasRequired && isRequired) {
      changes.push(
        buildChange({
          severity: 'breaking',
          kind: 'request-body-required',
          path,
          method,
          location: 'request.body',
          message: 'Request body became required',
        }),
      );
    } else {
      changes.push(
        buildChange({
          severity: 'non-breaking',
          kind: 'request-body-optional',
          path,
          method,
          location: 'request.body',
          message: 'Request body became optional',
        }),
      );
    }
  }

  const baseContent = baselineBody.content ?? {};
  const currContent = currentBody.content ?? {};
  const mediaTypes = new Set([
    ...Object.keys(baseContent),
    ...Object.keys(currContent),
  ]);

  for (const mediaType of mediaTypes) {
    diffSchema(
      baselineDoc,
      currentDoc,
      baseContent[mediaType]?.schema,
      currContent[mediaType]?.schema,
      'request',
      path,
      method,
      `request.body.${mediaType}`,
      changes,
    );
  }
}

function diffResponses(
  baselineDoc: OpenApiDocument,
  currentDoc: OpenApiDocument,
  baselineResponses: Record<string, ResponseObject>,
  currentResponses: Record<string, ResponseObject>,
  path: string,
  method: string,
  changes: ApiChange[],
): void {
  for (const status of Object.keys(baselineResponses)) {
    if (!(status in currentResponses)) {
      const isError = /^[45]/.test(status) || status === 'default';
      changes.push(
        buildChange({
          severity: 'breaking',
          kind: isError ? 'error-code-removed' : 'response-status-removed',
          path,
          method,
          location: `responses.${status}`,
          message: `Response status ${status} removed`,
        }),
      );
    }
  }

  for (const status of Object.keys(currentResponses)) {
    if (!(status in baselineResponses)) {
      const isError = /^[45]/.test(status) || status === 'default';
      changes.push(
        buildChange({
          severity: 'non-breaking',
          kind: isError ? 'error-code-added' : 'response-status-added',
          path,
          method,
          location: `responses.${status}`,
          message: `Response status ${status} added`,
        }),
      );
    }
  }

  for (const status of Object.keys(baselineResponses)) {
    const baseResponse = baselineResponses[status];
    const currResponse = currentResponses[status];
    if (!baseResponse || !currResponse) {
      continue;
    }

    const baseContent = baseResponse.content ?? {};
    const currContent = currResponse.content ?? {};
    const mediaTypes = new Set([
      ...Object.keys(baseContent),
      ...Object.keys(currContent),
    ]);

    for (const mediaType of mediaTypes) {
      diffSchema(
        baselineDoc,
        currentDoc,
        baseContent[mediaType]?.schema,
        currContent[mediaType]?.schema,
        'response',
        path,
        method,
        `responses.${status}.${mediaType}`,
        changes,
      );
    }
  }
}

function diffOperations(
  baselineDoc: OpenApiDocument,
  currentDoc: OpenApiDocument,
  baselineOp: OperationObject,
  currentOp: OperationObject,
  path: string,
  method: string,
  changes: ApiChange[],
): void {
  diffParameters(
    baselineDoc,
    currentDoc,
    baselineOp.parameters ?? [],
    currentOp.parameters ?? [],
    path,
    method,
    changes,
  );

  diffRequestBody(
    baselineDoc,
    currentDoc,
    baselineOp.requestBody,
    currentOp.requestBody,
    path,
    method,
    changes,
  );

  diffResponses(
    baselineDoc,
    currentDoc,
    baselineOp.responses ?? {},
    currentOp.responses ?? {},
    path,
    method,
    changes,
  );
}

/**
 * Pure structural diff between two OpenAPI documents.
 *
 * The function does not mutate its inputs and produces a deterministic,
 * stably-sorted list of changes.
 */
export function diffOpenApiDocuments(
  baseline: OpenApiDocument | undefined,
  current: OpenApiDocument | undefined,
): ApiChange[] {
  const changes: ApiChange[] = [];

  if (!baseline || !current) {
    return changes;
  }

  const baselinePaths = baseline.paths ?? {};
  const currentPaths = current.paths ?? {};

  for (const path of Object.keys(baselinePaths)) {
    const baselinePathItem = baselinePaths[path];
    const currentPathItem = currentPaths[path];

    if (!currentPathItem) {
      changes.push(
        buildChange({
          severity: 'breaking',
          kind: 'path-removed',
          path,
          message: `Path ${path} removed`,
        }),
      );
      continue;
    }

    for (const method of HTTP_METHODS) {
      const baselineOp = baselinePathItem?.[method];
      const currentOp = currentPathItem?.[method];

      const hasBaselineOp = isPlainObject(baselineOp);
      const hasCurrentOp = isPlainObject(currentOp);

      if (hasBaselineOp && !hasCurrentOp) {
        changes.push(
          buildChange({
            severity: 'breaking',
            kind: 'method-removed',
            path,
            method,
            message: `Method ${method.toUpperCase()} removed from ${path}`,
          }),
        );
        continue;
      }

      if (!hasBaselineOp && hasCurrentOp) {
        changes.push(
          buildChange({
            severity: 'non-breaking',
            kind: 'method-added',
            path,
            method,
            message: `Method ${method.toUpperCase()} added to ${path}`,
          }),
        );
        continue;
      }

      if (hasBaselineOp && hasCurrentOp) {
        diffOperations(
          baseline,
          current,
          baselineOp as OperationObject,
          currentOp as OperationObject,
          path,
          method,
          changes,
        );
      }
    }
  }

  for (const path of Object.keys(currentPaths)) {
    if (path in baselinePaths) {
      continue;
    }
    changes.push(
      buildChange({
        severity: 'non-breaking',
        kind: 'path-added',
        path,
        message: `Path ${path} added`,
      }),
    );
  }

  return sortChanges(changes);
}

function sortChanges(changes: ApiChange[]): ApiChange[] {
  return changes.slice().sort((a, b) => {
    if (a.path !== b.path) {
      return a.path < b.path ? -1 : 1;
    }
    const aMethod = a.method ?? '';
    const bMethod = b.method ?? '';
    if (aMethod !== bMethod) {
      return aMethod < bMethod ? -1 : 1;
    }
    const aLocation = a.location ?? '';
    const bLocation = b.location ?? '';
    if (aLocation !== bLocation) {
      return aLocation < bLocation ? -1 : 1;
    }
    if (a.kind !== b.kind) {
      return a.kind < b.kind ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Options controlling how the compatibility service evaluates a diff.
 */
export interface ApiCompatibilityOptions {
  /**
   * Change identifiers that should be treated as acceptable. Any change whose
   * `id` appears here is moved into the `allowed` bucket and does not affect
   * the overall compatibility verdict.
   */
  allowlist?: string[];
  /**
   * Optional override map keyed by change `id` that can downgrade a breaking
   * change to non-breaking (or vice versa).
   */
  overrides?: Record<string, ChangeSeverity>;
}

/**
 * Loads the baseline and current OpenAPI documents, diffs them, and produces
 * a stable compatibility report.
 */
@Injectable()
export class ApiCompatibilityService {
  private readonly logger = new Logger(ApiCompatibilityService.name);

  constructor(private readonly documentHolder: OpenApiDocumentHolder) {}

  /**
   * Computes a compatibility report between the provided baseline document
   * and the currently held OpenAPI document.
   */
  public compare(
    baseline: OpenApiDocument | undefined,
    options: ApiCompatibilityOptions = {},
  ): ApiCompatibilityReport {
    const current = this.documentHolder.getDocument() as
      | OpenApiDocument
      | undefined;

    return this.buildReport(baseline, current, options);
  }

  /**
   * Computes a compatibility report using the document holder's baseline (if
   * available) and current document.
   */
  public compareWithBaseline(
    options: ApiCompatibilityOptions = {},
  ): ApiCompatibilityReport {
    const baseline = this.documentHolder.getBaseline() as
      | OpenApiDocument
      | undefined;
    const current = this.documentHolder.getDocument() as
      | OpenApiDocument
      | undefined;

    return this.buildReport(baseline, current, options);
  }

  /**
   * Builds a report from already-resolved documents. Exposed for testing and
   * for callers that manage their own document lifecycle.
   */
  public buildReport(
    baseline: OpenApiDocument | undefined,
    current: OpenApiDocument | undefined,
    options: ApiCompatibilityOptions = {},
  ): ApiCompatibilityReport {
    const allowlist = new Set(options.allowlist ?? []);
    const overrides = options.overrides ?? {};

    const rawChanges = diffOpenApiDocuments(baseline, current);

    const changes: ApiChange[] = [];
    const allowed: ApiChange[] = [];

    for (const change of rawChanges) {
      const override = overrides[change.id];
      const effective: ApiChange = override
        ? { ...change, severity: override }
        : change;

      if (allowlist.has(effective.id)) {
        allowed.push(effective);
      } else {
        changes.push(effective);
      }
    }

    const breaking = changes.filter((c) => c.severity === 'breaking');
    const nonBreaking = changes.filter((c) => c.severity === 'non-breaking');

    if (breaking.length > 0) {
      this.logger.warn(
        `Detected ${breaking.length} breaking API change(s) against baseline`,
      );
    }

    const errorCodeChanges = diffErrorCodes(baseline, current);
    if (errorCodeChanges.length > 0) {
      this.logger.warn(
        `Detected ${errorCodeChanges.length} public error code change(s); ` +
          'update the troubleshooting guide to match',
      );
    }

    return {
      changes: sortChanges(changes),
      allowed: sortChanges(allowed),
      breaking: sortChanges(breaking),
      nonBreaking: sortChanges(nonBreaking),
      compatible: breaking.length === 0,
      errorCodeChanges,
    };
  }
}
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>