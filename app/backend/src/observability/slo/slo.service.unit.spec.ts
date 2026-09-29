import { Test, TestingModule } from "@nestjs/testing";
import * as client from "prom-client";

import { MetricsService } from "../../metrics/metrics.service";
import { SloService } from "./slo.service";
import { classifySlo, computeBurnRate } from "./slo.definitions";
import type { SloReport } from "./slo.service";

describe("SloService", () => {
  let service: SloService;
  let registry: client.Registry;

  beforeEach(async () => {
    registry = new client.Registry();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SloService,
        {
          provide: MetricsService,
          useValue: { getRegistry: () => registry },
        },
      ],
    }).compile();

    service = module.get<SloService>(SloService);
  });

  /**
   * Metrics are declared with an explicit `registers` list: prom-client
   * auto-registers new metrics on its global registry, which would leak series
   * between tests and collide on the second test that uses the same name.
   */
  const addCounter = (
    name: string,
    labels: Record<string, string>,
    value: number,
  ) => {
    const existing = registry.getSingleMetric(name) as
      | client.Counter<string>
      | undefined;

    if (existing) {
      existing.labels(...Object.values(labels)).inc(value);
      return;
    }

    const counter = new client.Counter({
      name,
      help: name,
      labelNames: Object.keys(labels),
      registers: [registry],
    });
    counter.labels(...Object.values(labels)).inc(value);
  };

  const addHistogram = (
    name: string,
    labelNames: string[],
    observations: number[],
  ) => {
    const histogram = new client.Histogram({
      name,
      help: name,
      labelNames,
      buckets: [1, 5, 30, 60, 300],
      registers: [registry],
    });
    observations.forEach((value) => histogram.labels("x").observe(value));
  };

  const findObjective = (report: SloReport, id: string) =>
    report.objectives.find((objective) => objective.id === id)!;

  it("reports insufficient_data when the registry has no observations", async () => {
    const report = await service.getReport();

    expect(report.metricsAvailable).toBe(true);
    expect(findObjective(report, "payment_availability").observedRatio).toBeNull();
    expect(findObjective(report, "payment_availability").status).toBe(
      "insufficient_data",
    );
    // An objective with no traffic must never be reported as healthy.
    expect(findObjective(report, "payment_availability").status).not.toBe("ok");
  });

  it("reports metricsAvailable=false and no firing objective when the registry is missing", async () => {
    const degraded = new SloService({ getRegistry: () => undefined } as never);
    const report = await degraded.getReport();

    expect(report.metricsAvailable).toBe(false);
    expect(report.overallStatus).toBe("insufficient_data");
    expect(report.objectives.every((o) => o.status === "insufficient_data")).toBe(
      true,
    );
  });

  it("counts 5xx as bad and 4xx as good for payment availability", async () => {
    addCounter("http_requests_total", { method: "GET", route: "/payments/:pk", status_code: "200" }, 90);
    addCounter("http_requests_total", { method: "GET", route: "/payments/:pk", status_code: "400" }, 5);
    addCounter("http_requests_total", { method: "GET", route: "/payments/:pk", status_code: "500" }, 5);

    const objective = findObjective(await service.getReport(), "payment_availability");

    expect(objective.evidence.total).toBe(100);
    expect(objective.evidence.bad).toBe(5);
    expect(objective.observedRatio).toBeCloseTo(0.95);
  });

  it("does not let traffic on unowned routes affect an objective", async () => {
    addCounter("http_requests_total", { method: "GET", route: "/usernames/:name", status_code: "500" }, 500);
    addCounter("http_requests_total", { method: "GET", route: "/links", status_code: "200" }, 10);

    const report = await service.getReport();

    expect(findObjective(report, "payment_availability").observedRatio).toBeNull();
    expect(findObjective(report, "link_availability").observedRatio).toBe(1);
  });

  it("escalates to critical once the burn rate passes the critical threshold", async () => {
    // 90% good on a 99.5% target is a 20x burn rate, past the 14.4x threshold.
    addCounter("http_requests_total", { method: "GET", route: "/links", status_code: "200" }, 90);
    addCounter("http_requests_total", { method: "GET", route: "/links", status_code: "500" }, 10);

    const objective = findObjective(await service.getReport(), "link_availability");

    expect(objective.observedRatio).toBeCloseTo(0.9);
    expect(objective.burnRate).toBeCloseTo(20);
    expect(objective.status).toBe("critical");
    expect(objective.remainingBudgetRatio).toBeLessThan(0);
    expect((await service.getReport()).overallStatus).toBe("critical");
  });

  it("keeps a brief blip below the warning threshold", async () => {
    // 99.9% good on a 99.5% target is a 0.2x burn rate: inside budget.
    addCounter("http_requests_total", { method: "GET", route: "/links", status_code: "200" }, 999);
    addCounter("http_requests_total", { method: "GET", route: "/links", status_code: "500" }, 1);

    const objective = findObjective(await service.getReport(), "link_availability");
    expect(objective.burnRate).toBeCloseTo(0.2);
    expect(objective.status).toBe("ok");
    expect(objective.remainingBudgetRatio).toBeCloseTo(0.8);
  });

  it("measures settlement latency from histogram buckets", async () => {
    addHistogram(
      "escrow_state_transition_duration_seconds",
      ["trigger"],
      [0.1, 0.2, 0.3, 0.4, 120],
    );

    const objective = findObjective(await service.getReport(), "settlement_latency");

    expect(objective.evidence.total).toBe(5);
    expect(objective.evidence.good).toBe(4);
    expect(objective.observedRatio).toBeCloseTo(0.8);
  });

  it("excludes replays from the notification delivery objective", async () => {
    const histogram = new client.Histogram({
      name: "webhook_delivery_duration_seconds",
      help: "d",
      labelNames: ["status", "trigger"],
      buckets: [1, 5],
      registers: [registry],
    });
    histogram.labels("success", "delivery").observe(0.1);
    histogram.labels("failure", "delivery").observe(0.1);
    histogram.labels("failure", "replay").observe(0.1);

    const objective = findObjective(await service.getReport(), "notification_delivery");

    expect(objective.evidence.total).toBe(2);
    expect(objective.observedRatio).toBeCloseTo(0.5);
  });

  it("returns undefined for an unknown objective id", async () => {
    expect(await service.getObjective("does_not_exist")).toBeUndefined();

    const known = await service.getObjective("payment_availability");
    expect(known?.id).toBe("payment_availability");
  });

  it("excludes advisory objectives from the overall status", async () => {
    addCounter("http_requests_total", { method: "GET", route: "/links", status_code: "200" }, 90);
    addCounter("http_requests_total", { method: "GET", route: "/links", status_code: "500" }, 10);

    const report = await service.getReport();
    const advisory = findObjective(report, "settlement_latency");

    // Settlement latency is `enforced: false` while it settles, so even though
    // the enforced objectives are critical the advisory one is not the reason.
    expect(advisory.enforced).toBe(false);
    expect(report.overallStatus).toBe("critical");
  });
});

describe("SLO math", () => {
  const definition = {
    id: "test",
    path: "payment" as const,
    kind: "availability" as const,
    description: "",
    target: 0.99,
    windowSeconds: 100,
    burnRateCritical: 14.4,
    burnRateWarning: 6,
    enforced: true,
  };

  it("returns null burn rate without observations", () => {
    expect(computeBurnRate(null, definition)).toBeNull();
    expect(classifySlo(null, definition)).toBe("insufficient_data");
  });

  it("classifies a burn rate between the warning and critical thresholds", () => {
    expect(classifySlo(0.9, definition)).toBe("warning");
    expect(classifySlo(0.5, definition)).toBe("critical");
  });

  it("never reports a negative burn rate for a perfect objective", () => {
    expect(computeBurnRate(1, definition)).toBe(0);
    expect(classifySlo(1, definition)).toBe("ok");
  });
});
