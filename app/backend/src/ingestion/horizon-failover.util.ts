export interface HorizonEndpoint {
  url: string;
  healthy: boolean;
  failureCount: number;
}

const FAILURE_THRESHOLD = 3;

/**
 * Header names that upstream Horizon (or its proxies) may use to expose a
 * request identifier. Only these approved headers are ever captured.
 */
export const APPROVED_REQUEST_ID_HEADERS = [
  'x-request-id',
  'x-amzn-requestid',
  'x-correlation-id',
] as const;

export type ApprovedRequestIdHeader = (typeof APPROVED_REQUEST_ID_HEADERS)[number];

/**
 * Structured, privacy-safe metadata describing an upstream dependency error.
 * `requestId` is only present when the upstream supplied an approved header.
 */
export interface HorizonDependencyErrorMetadata {
  dependency: 'horizon';
  requestId?: string;
  requestIdHeader?: ApprovedRequestIdHeader;
}

/**
 * Minimal shape of the headers we accept. Compatible with the Fetch API
 * `Headers` object as well as plain record objects.
 */
export type HeaderSource =
  | { get(name: string): string | null | undefined }
  | Record<string, string | string[] | undefined>;

function readHeader(source: HeaderSource, name: string): string | undefined {
  if (typeof (source as { get?: unknown }).get === 'function') {
    const value = (source as { get(name: string): string | null | undefined }).get(name);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  const record = source as Record<string, string | string[] | undefined>;
  const direct = record[name] ?? record[name.toLowerCase()];
  if (Array.isArray(direct)) {
    return direct.length > 0 && direct[0] ? direct[0] : undefined;
  }
  return typeof direct === 'string' && direct.length > 0 ? direct : undefined;
}

/**
 * Extract an approved upstream request identifier from response headers.
 * Returns `undefined` when no approved header is supplied, so identifiers
 * appear only when the upstream actually provided one.
 */
export function extractUpstreamRequestId(
  headers: HeaderSource | null | undefined,
): { requestId: string; header: ApprovedRequestIdHeader } | undefined {
  if (!headers) return undefined;
  for (const header of APPROVED_REQUEST_ID_HEADERS) {
    const value = readHeader(headers, header);
    if (value) {
      return { requestId: value, header };
    }
  }
  return undefined;
}

/**
 * Build structured dependency error metadata for a Horizon failure. The
 * request id is included only when an approved header was present.
 */
export function buildHorizonDependencyErrorMetadata(
  headers: HeaderSource | null | undefined,
): HorizonDependencyErrorMetadata {
  const extracted = extractUpstreamRequestId(headers);
  if (!extracted) {
    return { dependency: 'horizon' };
  }
  return {
    dependency: 'horizon',
    requestId: extracted.requestId,
    requestIdHeader: extracted.header,
  };
}

const STELLAR_ADDRESS_PATTERN = /G[A-Z2-7]{55}/g;
const STELLAR_MUXED_ADDRESS_PATTERN = /M[A-Z2-7]{68}/g;
const STELLAR_SECRET_PATTERN = /S[A-Z2-7]{55}/g;

/**
 * Redact Stellar addresses (public, muxed, and secret keys) from a string.
 */
export function redactStellarAddresses(input: string): string {
  return input
    .replace(STELLAR_SECRET_PATTERN, '[REDACTED_SECRET]')
    .replace(STELLAR_MUXED_ADDRESS_PATTERN, '[REDACTED_ADDRESS]')
    .replace(STELLAR_ADDRESS_PATTERN, '[REDACTED_ADDRESS]');
}

/**
 * Produce a privacy-safe log line for a Horizon failure. Addresses are
 * redacted and payloads are never included; only the safe correlation
 * metadata (dependency + optional request id) is emitted.
 */
export function formatHorizonFailureLog(
  metadata: HorizonDependencyErrorMetadata,
  context?: string,
): string {
  const parts: string[] = ['horizon_failure'];
  if (context) {
    parts.push(`context=${redactStellarAddresses(context)}`);
  }
  parts.push(`dependency=${metadata.dependency}`);
  if (metadata.requestId) {
    parts.push(`request_id=${redactStellarAddresses(metadata.requestId)}`);
  }
  if (metadata.requestIdHeader) {
    parts.push(`request_id_header=${metadata.requestIdHeader}`);
  }
  return parts.join(' ');
}

export function buildEndpoints(urls: string[]): HorizonEndpoint[] {
  return urls.map(url => ({ url, healthy: true, failureCount: 0 }));
}

export function getActiveEndpoint(
  endpoints: HorizonEndpoint[],
): HorizonEndpoint | null {
  return endpoints.find(e => e.healthy) ?? null;
}

export function recordFailure(
  endpoints: HorizonEndpoint[],
  url: string,
): void {
  const ep = endpoints.find(e => e.url === url);
  if (!ep) return;
  ep.failureCount++;
  if (ep.failureCount >= FAILURE_THRESHOLD) ep.healthy = false;
}

export function resetEndpoint(
  endpoints: HorizonEndpoint[],
  url: string,
): void {
  const ep = endpoints.find(e => e.url === url);
  if (!ep) return;
  ep.healthy = true;
  ep.failureCount = 0;
}