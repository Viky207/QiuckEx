/**
 * Lightweight Sentry wrapper.
 * Uses @sentry/nextjs when installed/configured; falls back to console
 * logging so error reporting never throws if Sentry isn't set up yet.
 */

export interface CaptureContext {
  componentStack?: string | null;
  url?: string;
  user?: {
    id?: string;
    email?: string;
    username?: string;
  } | null;
  extra?: Record<string, unknown>;
}

export function captureException(error: unknown, context: CaptureContext = {}): void {
  const payload = {
    url: context.url ?? (typeof window !== "undefined" ? window.location.href : undefined),
    componentStack: context.componentStack ?? undefined,
    user: context.user ?? undefined,
    extra: context.extra ?? undefined,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require("@sentry/nextjs");
    Sentry.withScope((scope: any) => {
      if (payload.user) scope.setUser(payload.user);
      if (payload.url) scope.setTag("url", payload.url);
      if (payload.componentStack) scope.setExtra("componentStack", payload.componentStack);
      if (payload.extra) {
        Object.entries(payload.extra).forEach(([key, value]) => scope.setExtra(key, value));
      }
      Sentry.captureException(error);
    });
  } catch {
    console.error("[sentry:captureException]", error, payload);
  }
}
