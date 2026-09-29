import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * W3C Trace Context propagation for the QuickEx backend.
 *
 * The backend is a single deployable unit today, so "distributed tracing" here
 * means the part that matters for operating it: a trace id that is
 *  - accepted from an upstream caller (or minted when absent),
 *  - carried across every await inside a request, including outbound Horizon,
 *    Soroban RPC and Supabase calls,
 *  - returned to the caller and attached to outbound requests, so a slow
 *    dependency can be attributed without log archaeology.
 *
 * A module-level (non-injected) store is used for the same reason
 * `correlation.context.ts` uses one: the external-client services are
 * constructed before any request runs, so they must be able to read the current
 * trace without a constructor dependency.
 *
 * Custody: nothing here touches key material. A trace id is a random opaque
 * identifier, and `sanitizeBaggage` drops everything that could carry personal
 * data before it is forwarded.
 */

export const TRACEPARENT_HEADER = "traceparent";
export const TRACEPARENT_RESPONSE_HEADER = "x-trace-id";

/** W3C trace-context limits: 32 hex trace id, 16 hex parent id. */
const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const INVALID_TRACE_ID = "0".repeat(TRACE_ID_BYTES * 2);

export interface TraceContext {
  traceId: string;
  /** Parent span id from the inbound `traceparent`, when it was valid. */
  parentSpanId: string | null;
  sampled: boolean;
}

interface StoredTrace extends TraceContext {
  spanId: string;
}

/** Process-wide async storage scoping a trace to a single request. */
const traceStore = new AsyncLocalStorage<StoredTrace>();

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Parse a W3C `traceparent` header.
 *
 * Returns `null` for anything malformed or all-zero. Inbound trace context is
 * untrusted input: a caller must not be able to inject an arbitrary trace id
 * that pollutes another tenant's traces, so parsing is strict and anything
 * unexpected is replaced with a freshly minted trace rather than rejected.
 */
export function parseTraceparent(
  header: string | undefined | null,
): TraceContext | null {
  if (!header) return null;

  const parts = header.trim().split("-");
  if (parts.length < 4) return null;

  const [version, traceId, parentSpanId, flags] = parts;
  if (!/^0[0-9a-f]{1,2}$/.test(version ?? "")) return null;
  if (!TRACE_ID_PATTERN.test(traceId ?? "")) return null;
  if (traceId === INVALID_TRACE_ID) return null;
  if (!SPAN_ID_PATTERN.test(parentSpanId ?? "")) return null;
  if (!/^[0-9a-f]{2}$/.test(flags ?? "")) return null;

  return {
    traceId,
    parentSpanId,
    sampled: (Number.parseInt(flags, 16) & 0x01) === 0x01,
  };
}

/** Build a `traceparent` value for an outbound request from this context. */
export function formatTraceparent(
  context: TraceContext,
  spanId: string,
): string {
  const flags = context.sampled ? "01" : "00";
  return `00-${context.traceId}-${spanId}-${flags}`;
}

export function getCurrentTrace(): TraceContext | undefined {
  const stored = traceStore.getStore();
  if (!stored) return undefined;

  return {
    traceId: stored.traceId,
    parentSpanId: stored.parentSpanId,
    sampled: stored.sampled,
  };
}

/** Convenience accessor used by log formatters. */
export function getCurrentTraceId(): string | undefined {
  return traceStore.getStore()?.traceId;
}

/**
 * Headers to attach to an outbound dependency call so the dependency's own logs
 * and traces join this trace. Returns an empty object outside a request scope so
 * background jobs and tests are unaffected.
 */
export function tracePropagationHeaders(): Record<string, string> {
  const stored = traceStore.getStore();
  if (!stored) return {};

  return {
    [TRACEPARENT_HEADER]: formatTraceparent(stored, stored.spanId),
    [TRACEPARENT_RESPONSE_HEADER]: stored.traceId,
  };
}

export interface StartedTrace {
  context: TraceContext;
  /** Header value to echo back to the caller. */
  responseHeader: string;
  /** Injected `traceparent` for the downstream request scope. */
  traceparent: string;
}

/**
 * Start (or continue) a trace for the current request scope.
 *
 * `runWithTrace` is the form used by the middleware; `startTrace` is exposed
 * separately so unit tests can assert on the context without entering a
 * request scope.
 */
export function startTrace(inboundTraceparent?: string | null): StartedTrace {
  const parsed = parseTraceparent(inboundTraceparent);
  const context: TraceContext = parsed ?? {
    traceId: randomHex(TRACE_ID_BYTES),
    parentSpanId: null,
    sampled: true,
  };

  return {
    context,
    responseHeader: context.traceId,
    traceparent: formatTraceparent(context, randomHex(SPAN_ID_BYTES)),
  };
}

/** Run `fn` with a trace bound to the async scope. */
export function runWithTrace<T>(trace: StartedTrace, fn: () => T): T {
  return traceStore.run(
    {
      traceId: trace.context.traceId,
      parentSpanId: trace.context.parentSpanId,
      sampled: trace.context.sampled,
      spanId: randomHex(SPAN_ID_BYTES),
    },
    fn,
  );
}


/**
 * Strip anything that is not a short opaque token from an inbound baggage
 * value. Trace propagation must never become a channel for personal data, so
 * the default is to forward nothing and only re-emit keys we recognise.
 */
export function sanitizeBaggage(
  baggage: string | undefined | null,
): Record<string, string> {
  if (!baggage) return {};

  const allowed = new Set(["tenant", "deployment"]);
  const result: Record<string, string> = {};

  for (const entry of baggage.split(",")) {
    const [key, ...rest] = entry.trim().split("=");
    if (!key || !allowed.has(key)) continue;

    const value = rest.join("=").trim();
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) continue;

    result[key] = value;
  }

  return result;
}
