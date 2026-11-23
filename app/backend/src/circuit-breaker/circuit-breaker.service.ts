import { Injectable, Logger } from "@nestjs/common";
import { CircuitBreaker, CircuitBreakerOptions, CircuitState } from "./circuit-breaker";
import { MetricsService } from "../metrics/metrics.service";

/**
 * Stable error code emitted when an external dependency does not respond
 * within its configured timeout budget.
 */
export const DEPENDENCY_TIMEOUT = "DEPENDENCY_TIMEOUT";

/**
 * Stable error code emitted when the caller cancelled the request before the
 * dependency finished.
 */
export const DEPENDENCY_CANCELLED = "DEPENDENCY_CANCELLED";

/**
 * Error thrown when an external dependency call exceeds its timeout budget or
 * is cancelled by the caller. Carries a stable `code` so callers can map it to
 * an API response without inspecting messages.
 */
export class DependencyError extends Error {
  constructor(
    public readonly code: typeof DEPENDENCY_TIMEOUT | typeof DEPENDENCY_CANCELLED,
    public readonly dependency: string,
    message?: string,
    public readonly cause?: unknown,
  ) {
    super(message ?? `${dependency} call failed: ${code}`);
    this.name = "DependencyError";
  }
}

export interface DependencyCallOptions {
  /** Timeout budget in milliseconds for this dependency call. */
  timeoutMs: number;
  /** Optional caller cancellation signal (e.g. from an HTTP request). */
  signal?: AbortSignal;
}

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly metricsService: MetricsService) {}

  /**
   * Executes an external dependency call under a timeout budget and optional
   * caller cancellation signal.
   *
   * - If the caller's signal is already aborted, the call is never started and
   *   a `DEPENDENCY_CANCELLED` error is thrown.
   * - If the timeout elapses first, the underlying operation is aborted (when
   *   it accepts a signal) and a `DEPENDENCY_TIMEOUT` error is thrown.
   * - If the caller aborts mid-flight, the operation is aborted and a
   *   `DEPENDENCY_CANCELLED` error is thrown.
   *
   * The returned promise always settles exactly once; no work continues after
   * cancellation or timeout.
   */
  async withTimeout<T>(
    dependency: string,
    operation: (signal: AbortSignal) => Promise<T>,
    options: DependencyCallOptions,
  ): Promise<T> {
    const { timeoutMs, signal: callerSignal } = options;

    if (callerSignal?.aborted) {
      throw new DependencyError(
        DEPENDENCY_CANCELLED,
        dependency,
        `${dependency} call cancelled before start`,
      );
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onCallerAbort: (() => void) | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (callerSignal && onCallerAbort) {
        callerSignal.removeEventListener("abort", onCallerAbort);
        onCallerAbort = undefined;
      }
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new DependencyError(
            DEPENDENCY_TIMEOUT,
            dependency,
            `${dependency} call timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      // Do not keep the process alive solely for this timer.
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    });

    const cancellationPromise = new Promise<never>((_, reject) => {
      if (!callerSignal) return;
      onCallerAbort = () => {
        controller.abort();
        reject(
          new DependencyError(
            DEPENDENCY_CANCELLED,
            dependency,
            `${dependency} call cancelled by caller`,
          ),
        );
      };
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    });

    try {
      const operationPromise = operation(controller.signal);
      return await Promise.race([
        operationPromise,
        timeoutPromise,
        cancellationPromise,
      ]);
    } catch (error) {
      if (error instanceof DependencyError) {
        throw error;
      }
      throw error;
    } finally {
      cleanup();
    }
  }

  /**
   * Get (or lazily create) a named circuit breaker.
   */
  getOrCreate(name: string, options: CircuitBreakerOptions = {}): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(options);
      this.breakers.set(name, breaker);
      this.logger.log(`Circuit breaker '${name}' created (${breaker.getState()})`);
    }
    return breaker;
  }

  /**
   * Convenience accessor for the Horizon API circuit.
   */
  get horizon(): CircuitBreaker {
    return this.getOrCreate("horizon", {
      failureThreshold: 5,
      windowMs: 60_000,
      openTimeoutMs: 30_000,
      probeIntervalMs: 30_000,
      successThreshold: 1,
    });
  }

  /**
   * Per-dependency timeout budgets (ms), aligned with endpoint response
   * budgets. Callers should pass these to `withTimeout`.
   */
  static readonly TIMEOUT_BUDGETS: Readonly<Record<string, number>> = {
    horizon: 5_000,
    soroban: 8_000,
    default: 5_000,
  };

  /**
   * Resolve the timeout budget for a named dependency, falling back to the
   * default budget.
   */
  getTimeoutBudget(dependency: string): number {
    return (
      CircuitBreakerService.TIMEOUT_BUDGETS[dependency] ??
      CircuitBreakerService.TIMEOUT_BUDGETS.default
    );
  }

  /**
   * Records the current state of every known breaker as a metric so it is
   * observable in Prometheus and reports.
   */
  snapshotMetrics(): void {
    for (const [name, breaker] of this.breakers.entries()) {
      const state = breaker.getState();
      this.metricsService.setCircuitBreakerState(name, state);
      // Increment a transition counter every time states change.
      const stats = breaker.getStats();
      this.metricsService.setCircuitBreakerTransitions(
        name,
        stats.transitionCount,
      );
    }
  }

  /**
   * Human-readable report for admin health endpoints.
   */
  getReport(): Array<{
    name: string;
    state: CircuitState;
    failuresInWindow: number;
    failureThreshold: number;
  }> {
    return [...this.breakers.entries()].map(([name, breaker]) => {
      const stats = breaker.getStats();
      return {
        name,
        state: stats.state,
        failuresInWindow: stats.failuresInWindow,
        failureThreshold: stats.failureThreshold,
      };
    });
  }
}
