import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Canonical header used to carry the correlation ID on inbound and outbound
 * requests. Kept in sync with the middleware and the webhook payloads.
 */
export const CORRELATION_ID_HEADER = 'X-Correlation-ID';

/**
 * Process-wide async storage that scopes a correlation ID to a single request.
 *
 * The {@link CorrelationIdMiddleware} runs the downstream middleware/guards/
 * interceptors/controllers within this store, so any outbound call made while
 * handling a request (Horizon, Soroban RPC, Supabase, …) can retrieve the
 * current correlation ID and propagate it as a header.
 *
 * A module-level (non-injected) singleton is used deliberately so that the
 * external-client services (which are constructed before a request ever runs)
 * can read the current value without needing a constructor dependency.
 */
export const correlationStore = new AsyncLocalStorage<string>();

/**
 * Generate a fresh correlation ID (RFC 4122 v4 UUID) when the caller did not
 * supply one via the request headers.
 */
export function generateCorrelationId(): string {
  return randomUUID();
}

/**
 * Return the correlation ID for the currently executing request, or undefined
 * when invoked outside of a request scope (e.g. background workers).
 */
export function getCurrentCorrelationId(): string | undefined {
  return correlationStore.getStore();
}

/**
 * Run `fn` with `correlationId` bound to the current async scope. All
 * synchronous and asynchronous work created inside `fn` inherits this value.
 */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return correlationStore.run(correlationId, fn);
}
