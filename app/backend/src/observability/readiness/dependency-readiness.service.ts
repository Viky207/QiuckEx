import { Injectable, Logger } from "@nestjs/common";

import { HealthService } from "../../health/health.service";
import { IndexerLagService } from "../../indexer-lag/indexer-lag.service";
import { MetricsService } from "../../metrics/metrics.service";

/** Per-dependency probe verdict, reusing the health module's vocabulary. */
export type ProbeStatus = "healthy" | "degraded" | "unhealthy";

/**
 * Whether a failing dependency should stop the instance receiving traffic.
 *
 * `critical` dependencies gate readiness. `optional` ones degrade the report
 * but must not take the service out of rotation: Redis, for example, has an
 * in-process fallback, and removing every instance because a cache is down
 * would turn a degradation into an outage.
 */
export type ProbeCriticality = "critical" | "optional";

export interface DependencyProbe {
  id: string;
  criticality: ProbeCriticality;
  status: ProbeStatus;
  latencyMs: number | null;
  /** Sanitized failure reason. Never contains connection strings or secrets. */
  detail: string | null;
  lastCheckedAt: string;
}

export interface ReadinessReport {
  checkedAt: string;
  ready: boolean;
  status: ProbeStatus;
  checks: DependencyProbe[];
  /** Compact `id=status` list for the log line. */
  summary: string;
}

interface ProbeDefinition {
  id: string;
  criticality: ProbeCriticality;
  run: () => Promise<{ status: ProbeStatus; latencyMs: number | null; detail: string | null }>;
}

/** Results are cached briefly so a scrape storm cannot fan out into probes. */
const PROBE_CACHE_TTL_MS = 5_000;

/**
 * Dependency readiness probes for the core services.
 *
 * This complements the existing `/health` and `/ready` endpoints rather than
 * replacing them: `/health` and `/ready` answer "is this process serving?", and
 * this answers "which dependency is the reason it is not?". The distinction
 * matters operationally, because a not-ready instance with three healthy
 * dependencies and one unhealthy optional cache is a very different page from
 * one that cannot reach the database.
 */
@Injectable()
export class DependencyReadinessService {
  private readonly logger = new Logger(DependencyReadinessService.name);
  private cache: { expiresAt: number; value: ReadinessReport } | null = null;

  constructor(
    private readonly health: HealthService,
    private readonly indexerLag: IndexerLagService,
    private readonly metrics: MetricsService,
  ) {}

  /** Probe every dependency and classify overall readiness. */
  async check(): Promise<ReadinessReport> {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.value;
    }

    const definitions = this.probeDefinitions();
    const checkedAt = new Date().toISOString();

    const checks = await Promise.all(
      definitions.map(async (definition) => {
        const startedAt = Date.now();

        try {
          const result = await definition.run();
          this.metrics.recordDependencyProbe(
            definition.id,
            result.status,
            Date.now() - startedAt,
          );

          return {
            id: definition.id,
            criticality: definition.criticality,
            status: result.status,
            latencyMs: result.latencyMs,
            detail: result.detail,
            lastCheckedAt: checkedAt,
          } satisfies DependencyProbe;
        } catch (error) {
          // A probe that throws is an unhealthy probe, not a failed report.
          this.metrics.recordDependencyProbe(
            definition.id,
            "unhealthy",
            Date.now() - startedAt,
          );

          return {
            id: definition.id,
            criticality: definition.criticality,
            status: "unhealthy",
            latencyMs: null,
            detail: "probe threw an unexpected error",
            lastCheckedAt: checkedAt,
          } satisfies DependencyProbe;
        }
      }),
    );

    const critical = checks.filter((check) => check.criticality === "critical");
    const optional = checks.filter((check) => check.criticality === "optional");

    const report: ReadinessReport = {
      checkedAt,
      ready: critical.every((check) => check.status === "healthy"),
      status: overallStatus(critical, optional),
      checks,
      summary: checks.map((check) => `${check.id}=${check.status}`).join(" "),
    };

    if (report.status !== "healthy") {
      this.logger.warn(`Dependency readiness degraded: ${report.summary}`);
    }

    this.cache = { expiresAt: Date.now() + PROBE_CACHE_TTL_MS, value: report };
    return report;
  }


  /**
   * The probe set. `supabase` is critical (it is the system of record per
   * ADR 0003); `horizon` and `soroban_rpc` are critical because every read and
   * write path depends on them; `redis` and `indexer` are optional because the
   * service has defined fallbacks for both.
   */
  private probeDefinitions(): ProbeDefinition[] {
    return [
      {
        id: "supabase",
        criticality: "critical",
        run: async () => {
          const result = await this.health.checkSupabase();
          return {
            status: result.status === "up" ? "healthy" : "unhealthy",
            latencyMs: result.latency ?? null,
            detail:
              result.status === "up" ? null : (result.details ?? "unreachable"),
          };
        },
      },
      {
        id: "horizon",
        criticality: "critical",
        run: async () => {
          const result = await this.health.checkHorizon();
          return {
            status: result.status === "up" ? "healthy" : "unhealthy",
            latencyMs: result.latency ?? null,
            detail:
              result.status === "up" ? null : (result.details ?? "unreachable"),
          };
        },
      },
      {
        id: "soroban_rpc",
        criticality: "critical",
        run: async () => {
          const result = await this.health.checkSorobanRpc();
          return {
            status: result.status === "up" ? "healthy" : "unhealthy",
            latencyMs: result.latency ?? null,
            detail:
              result.status === "up" ? null : (result.details ?? "unreachable"),
          };
        },
      },
      {
        id: "job_queue",
        criticality: "critical",
        run: async () => {
          const result = await this.health.checkQueue();
          return {
            status: result.status === "up" ? "healthy" : "unhealthy",
            latencyMs: result.latency ?? null,
            detail:
              result.status === "up" ? null : (result.details ?? "unreachable"),
          };
        },
      },
      {
        id: "redis",
        criticality: "optional",
        run: async () => {
          const result = await this.health.checkRedis();
          const status: ProbeStatus =
            result.status === "up"
              ? "healthy"
              : result.status === "not_configured"
                ? "degraded"
                : "unhealthy";
          return {
            status,
            latencyMs: result.latency ?? null,
            detail: result.status === "up" ? null : (result.details ?? null),
          };
        },
      },
      {
        id: "indexer",
        criticality: "optional",
        run: async () => {
          const status = this.indexerLag.getStatus();

          if (status.lagLedgers === null) {
            // No reading yet is a degraded probe, not a failure: the indexer
            // only reports once it has polled Horizon at least once.
            return {
              status: "degraded",
              latencyMs: null,
              detail: "no indexer reading yet",
            };
          }

          const lagging = status.isLagging;
          return {
            status: lagging ? "degraded" : "healthy",
            latencyMs: null,
            detail: lagging
              ? `lag ${status.lagLedgers} exceeds threshold ${status.thresholdLedgers}`
              : null,
          };
        },
      },
    ];
  }

  /** Test seam: drop the cached report. */
  clearCache(): void {
    this.cache = null;
  }
}

/**
 * Overall status, weighted by criticality.
 *
 * An unhealthy *optional* dependency reports `degraded`, not `unhealthy`:
 * `unhealthy` means "this instance should not receive traffic", and taking
 * every instance out of rotation because an optional cache is down would turn
 * a degradation into a self-inflicted outage. Only a critical dependency can
 * make the report `unhealthy`.
 */
function overallStatus(
  critical: DependencyProbe[],
  optional: DependencyProbe[],
): ProbeStatus {
  if (critical.some((check) => check.status === "unhealthy")) return "unhealthy";
  if (critical.some((check) => check.status === "degraded")) return "degraded";
  if (optional.some((check) => check.status !== "healthy")) return "degraded";
  return "healthy";
}
