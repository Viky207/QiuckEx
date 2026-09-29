import { Test, TestingModule } from "@nestjs/testing";

import { HealthService } from "../../health/health.service";
import { IndexerLagService } from "../../indexer-lag/indexer-lag.service";
import { MetricsService } from "../../metrics/metrics.service";
import { DependencyReadinessService } from "./dependency-readiness.service";

describe("DependencyReadinessService", () => {
  let service: DependencyReadinessService;
  let health: {
    checkSupabase: jest.Mock;
    checkHorizon: jest.Mock;
    checkSorobanRpc: jest.Mock;
    checkQueue: jest.Mock;
    checkRedis: jest.Mock;
  };
  let indexerLag: { getStatus: jest.Mock };
  let metrics: { recordDependencyProbe: jest.Mock };

  const up = (latency = 5) => ({ status: "up", latency });
  const down = (details = "unreachable") => ({ status: "down", details });

  const build = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DependencyReadinessService,
        { provide: HealthService, useValue: health },
        { provide: IndexerLagService, useValue: indexerLag },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();

    return module.get<DependencyReadinessService>(DependencyReadinessService);
  };

  beforeEach(async () => {
    health = {
      checkSupabase: jest.fn().mockResolvedValue(up()),
      checkHorizon: jest.fn().mockResolvedValue(up()),
      checkSorobanRpc: jest.fn().mockResolvedValue(up()),
      checkQueue: jest.fn().mockResolvedValue(up()),
      checkRedis: jest.fn().mockResolvedValue(up()),
    };
    indexerLag = {
      getStatus: jest.fn().mockReturnValue({
        lagLedgers: 1,
        isLagging: false,
        thresholdLedgers: 10,
      }),
    };
    metrics = { recordDependencyProbe: jest.fn() };

    service = await build();
  });

  it("reports ready and healthy when every dependency is up", async () => {
    const report = await service.check();

    expect(report.ready).toBe(true);
    expect(report.status).toBe("healthy");
    expect(report.checks).toHaveLength(6);
    expect(report.checks.every((check) => check.status === "healthy")).toBe(true);
  });

  it("probes each dependency and records a metric for it", async () => {
    await service.check();

    const probed = metrics.recordDependencyProbe.mock.calls.map(
      (call) => call[0],
    );
    expect(probed).toEqual(
      expect.arrayContaining([
        "supabase",
        "horizon",
        "soroban_rpc",
        "job_queue",
        "redis",
        "indexer",
      ]),
    );
  });

  it("is not ready when a critical dependency is down", async () => {
    health.checkSupabase.mockResolvedValue(down());

    const report = await service.check();

    expect(report.ready).toBe(false);
    expect(report.status).toBe("unhealthy");
    const supabase = report.checks.find((c) => c.id === "supabase");
    expect(supabase?.status).toBe("unhealthy");
    expect(supabase?.detail).toBe("unreachable");
  });

  it("stays ready when only an optional dependency is down", async () => {
    // Redis is optional: the service falls back to in-process stores, so an
    // outage there must not pull every instance out of rotation.
    health.checkRedis.mockResolvedValue(down());

    const report = await service.check();

    expect(report.ready).toBe(true);
    expect(report.status).toBe("degraded");
    expect(
      report.checks.find((c) => c.id === "redis")?.criticality,
    ).toBe("optional");
  });

  it("degrades when redis is not configured rather than reporting a failure", async () => {
    health.checkRedis.mockResolvedValue({
      status: "not_configured",
      details: "Redis not configured",
    });

    const report = await service.check();

    expect(report.ready).toBe(true);
    expect(report.status).toBe("degraded");
  });

  it("degrades when the indexer has not reported a reading yet", async () => {
    indexerLag.getStatus.mockReturnValue({
      lagLedgers: null,
      isLagging: false,
      thresholdLedgers: 10,
    });

    const report = await service.check();

    expect(report.ready).toBe(true);
    expect(report.status).toBe("degraded");
    expect(report.checks.find((c) => c.id === "indexer")?.detail).toBe(
      "no indexer reading yet",
    );
  });

  it("degrades and explains when the indexer is lagging", async () => {
    indexerLag.getStatus.mockReturnValue({
      lagLedgers: 42,
      isLagging: true,
      thresholdLedgers: 10,
    });

    const report = await service.check();

    expect(report.checks.find((c) => c.id === "indexer")?.detail).toContain("42");
    expect(report.checks.find((c) => c.id === "indexer")?.detail).toContain("10");
  });

  it("turns a throwing probe into an unhealthy probe, not a failed report", async () => {
    health.checkHorizon.mockRejectedValue(new Error("socket hang up"));

    const report = await service.check();

    expect(report.ready).toBe(false);
    const horizon = report.checks.find((c) => c.id === "horizon");
    expect(horizon?.status).toBe("unhealthy");
    // The raw error message must not leak into the report.
    expect(horizon?.detail).toBe("probe threw an unexpected error");
  });

  it("caches the report so a scrape storm cannot fan out into probes", async () => {
    await service.check();
    await service.check();

    expect(health.checkSupabase).toHaveBeenCalledTimes(1);
  });

  it("re-probes after the cache is cleared", async () => {
    await service.check();
    service.clearCache();
    await service.check();

    expect(health.checkSupabase).toHaveBeenCalledTimes(2);
  });

  it("includes a compact summary for the log line", async () => {
    const report = await service.check();

    expect(report.summary).toContain("supabase=healthy");
    expect(report.summary.split(" ")).toHaveLength(6);
  });
});
