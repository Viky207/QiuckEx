import { Test, TestingModule } from "@nestjs/testing";
import * as client from "prom-client";

import { AppConfigService } from "../../config/app-config.service";
import { MetricsService } from "../../metrics/metrics.service";
import { AlertingService } from "./alerting.service";
import { SloService } from "../slo/slo.service";
import type { SloReport } from "../slo/slo.service";
import type { AlertStatus } from "./alerting.service";

describe("AlertingService", () => {
  let service: AlertingService;
  let registry: client.Registry;
  let sloReport: SloReport;

  const setGauge = (name: string, value: number) => {
    const existing = registry.getSingleMetric(name) as
      | client.Gauge<string>
      | undefined;
    if (existing) {
      existing.set(value);
      return;
    }
    new client.Gauge({ name, help: name, registers: [registry] }).set(value);
  };

  const addError = (errorType: string, value: number) => {
    const existing = registry.getSingleMetric("error_total") as
      | client.Counter<string>
      | undefined;
    if (existing) {
      existing.labels("reconciliation", errorType).inc(value);
      return;
    }
    const counter = new client.Counter({
      name: "error_total",
      help: "e",
      labelNames: ["service", "error_type"],
      registers: [registry],
    });
    counter.labels("reconciliation", errorType).inc(value);
  };

  const alertById = (
    report: Awaited<ReturnType<AlertingService["evaluate"]>>,
    id: string,
  ): AlertStatus => report.alerts.find((alert) => alert.id === id)!;

  beforeEach(async () => {
    registry = new client.Registry();
    sloReport = {
      generatedAt: new Date().toISOString(),
      metricsAvailable: true,
      burnRateWindowSeconds: 2_592_000,
      overallStatus: "ok",
      objectives: [],
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlertingService,
        { provide: MetricsService, useValue: { getRegistry: () => registry } },
        { provide: SloService, useValue: { getReport: async () => sloReport } },
        {
          provide: AppConfigService,
          useValue: { indexerLagThresholdLedgers: 10 },
        },
      ],
    }).compile();

    service = module.get<AlertingService>(AlertingService);
  });

  it("reports no_data for every rule when the registry has no observations", async () => {
    const report = await service.evaluate();

    expect(report.metricsAvailable).toBe(true);
    expect(report.alerts.every((alert) => alert.state === "no_data")).toBe(true);
    expect(report.firing).toBe(0);
  });

  it("reports metricsAvailable=false and does not fire when the registry is missing", async () => {
    const degraded = new AlertingService(
      { getRegistry: () => undefined } as never,
      { getReport: async () => sloReport } as never,
      { indexerLagThresholdLedgers: 10 } as never,
    );

    const report = await degraded.evaluate();

    expect(report.metricsAvailable).toBe(false);
    expect(report.firing).toBe(0);
  });

  it("stays pending until the `for` clause is satisfied, then fires", async () => {
    setGauge("indexer_lag_ledgers", 50);

    // forSamples = 2 for this rule, so the first evaluation is only pending.
    const first = await service.evaluate();
    expect(alertById(first, "indexer_lag_over_threshold").state).toBe("pending");
    expect(first.pending).toBeGreaterThan(0);

    const second = await service.evaluate();
    const alert = alertById(second, "indexer_lag_over_threshold");
    expect(alert.state).toBe("firing");
    expect(alert.firingSince).not.toBeNull();
    expect(second.firing).toBeGreaterThan(0);
  });

  it("recovers to ok and clears the firing timestamp", async () => {
    setGauge("indexer_lag_ledgers", 50);
    await service.evaluate();
    await service.evaluate();
    expect(alertById(await service.evaluate(), "indexer_lag_over_threshold").state).toBe(
      "firing",
    );

    setGauge("indexer_lag_ledgers", 1);
    const recovered = await service.evaluate();
    const alert = alertById(recovered, "indexer_lag_over_threshold");

    expect(alert.state).toBe("ok");
    expect(alert.firingSince).toBeNull();
    expect(alert.consecutiveHits).toBe(0);
  });

  it("does not fire when lag is under the configured threshold", async () => {
    setGauge("indexer_lag_ledgers", 5);

    await service.evaluate();
    const report = await service.evaluate();

    expect(alertById(report, "indexer_lag_over_threshold").state).toBe("ok");
  });

  it("fires the reconciliation alert on a single discrepancy", async () => {
    addError("critical_discrepancy", 1);

    // forSamples = 1: a discrepancy is a blocking signal, so it fires at once.
    const report = await service.evaluate();
    const alert = alertById(report, "reconciliation_discrepancies");

    expect(alert.state).toBe("firing");
    expect(alert.measurement?.detail).toContain("1 critical");
  });

  it("fires when an enforced SLO is critical, and names the breaching objective", async () => {
    sloReport = {
      ...sloReport,
      objectives: [
        {
          id: "link_availability",
          path: "link",
          kind: "availability",
          description: "",
          enforced: true,
          target: 0.995,
          windowSeconds: 100,
          errorBudgetRatio: 0.005,
          observedRatio: 0.5,
          burnRate: 100,
          remainingBudgetRatio: -99,
          status: "critical",
          observationSeconds: 10,
          evidence: { total: 10, good: 5, bad: 5, source: "test" },
        },
      ],
    };

    await service.evaluate();
    const report = await service.evaluate();
    const alert = alertById(report, "error_budget_burn_rate_critical");

    expect(alert.state).toBe("firing");
    expect(alert.measurement?.detail).toContain("link_availability");
  });

  it("does not fire the burn-rate alert for an advisory objective", async () => {
    sloReport = {
      ...sloReport,
      objectives: [
        {
          id: "settlement_latency",
          path: "payment",
          kind: "latency",
          description: "",
          enforced: false,
          target: 0.99,
          windowSeconds: 100,
          errorBudgetRatio: 0.01,
          observedRatio: 0,
          burnRate: 100,
          remainingBudgetRatio: -99,
          status: "critical",
          observationSeconds: 10,
          evidence: { total: 1, good: 0, bad: 1, source: "test" },
        },
      ],
    };

    await service.evaluate();
    const report = await service.evaluate();

    // No enforced objective is breaching, so the rule has nothing to measure
    // and reports no_data rather than silently reporting ok.
    expect(alertById(report, "error_budget_burn_rate_critical").state).toBe(
      "no_data",
    );
  });

  it("isolates a rule that throws instead of failing the whole evaluation", async () => {
    const loggerError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    setGauge("indexer_lag_ledgers", 50);

    // Corrupt the SLO report the burn-rate rule reads, so its `reduce` throws.
    (sloReport as { objectives: unknown }).objectives = null;

    const report = await service.evaluate();

    expect(alertById(report, "error_budget_burn_rate_critical").state).toBe(
      "no_data",
    );
    // A broken rule must not stop the others from being evaluated.
    expect(alertById(report, "indexer_lag_over_threshold").measurement).not.toBeNull();

    loggerError.mockRestore();
  });

  it("exposes the rule catalog with runbooks", () => {
    const rules = service.listRules();

    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((rule) => rule.runbook.length > 0)).toBe(true);
    expect(rules.every((rule) => rule.forSamples >= 1)).toBe(true);
  });
});
