"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { captureException } from "@/lib/sentry";

interface RouteErrorBoundaryProps {
  children: ReactNode;
  /** Route/section label used for Sentry tagging (e.g. "dashboard", "pay"). */
  section?: string;
  /** Optional current user context forwarded to Sentry. */
  user?: { id?: string; email?: string; username?: string } | null;
}

interface RouteErrorBoundaryState {
  hasError: boolean;
}

/**
 * Route-level error boundary with a retry-capable fallback UI.
 * Reports to Sentry (component stack, URL, user context) independently of
 * the app-wide error reporting shell, and does not intercept Next.js
 * route-level `error.tsx` files (React error boundaries only catch render
 * errors in their own subtree; `error.tsx` remains Next's outer safety net).
 */
export class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): RouteErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    captureException(error, {
      componentStack: errorInfo.componentStack,
      url: typeof window !== "undefined" ? window.location.href : undefined,
      user: this.props.user ?? undefined,
      extra: { section: this.props.section },
    });
  }

  handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 p-8 text-center">
          <h2 className="text-lg font-semibold text-red-500">Something went wrong</h2>
          <p className="text-sm text-muted-foreground">
            {this.props.section
              ? `An unexpected error occurred in ${this.props.section}.`
              : "An unexpected error occurred."}
          </p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default RouteErrorBoundary;
