import { Test, TestingModule } from "@nestjs/testing";

import { MetricsService } from "../metrics/metrics.service";
import { AlertingService } from "./alerting/alerting.service";
import { ObservabilityScheduler } from "./observability.scheduler";
import { SloService } from "./slo/slo.service";

describe("ObservabilityScheduler", () => {
  let scheduler: ObservabilityScheduler;
  let sloService: { getReport: jest.Mock };
  let alertingService: { evaluate: jest.Mock };
  let metrics: { recordSloEvaluation: jest.Mock; recordAlertState: jest.Mock };

  const objective = (id: string) => ({
    id,
    path: "payment",
    kind: "availability",
    enforced: true,
    observedRatio: 1,
    burnRate: 0,
    remainingBudgetRatio: 1,
    status: "ok",
  });

  beforeEach(async () => {
    sloService = {
      getReport: jest.fn().mockResolvedValue({
        generatedAt: new Date().toISOString(),
        metricsAvailable: true,
        burnRateWindowSeconds: 2_592_000,
        overallStatus: "ok",
        objectives: [objective("payment_availability")],
      }),
    };
    alertingService = {
      evaluate: jest.fn().mockResolvedValue({
        evaluatedAt: new Date().toISOString(),
        metricsAvailable: true,
        firing: 1,
        pending: 0,
        alerts: [
          { id: "indexer_lag_over_threshold", severity: "critical", state: "firing" },
          { id: "webhook_dead_letter_queue_backlog", severity: "warning", state: "ok" },
        ],
      }),
    };
    metrics = {
      recordSloEvaluation: jest.fn(),
      recordAlertState: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ObservabilityScheduler,
        { provide: SloService, useValue: sloService },
        { provide: AlertingService, useValue: alertingService },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();

    scheduler = module.get<ObservabilityScheduler>(ObservabilityScheduler);
  });

  it("publishes every objective and alert state as a metric", async () => {
    await scheduler.publishSloAndAlertState();

    expect(metrics.recordSloEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "payment_availability" }),
    );
    expect(metrics.recordAlertState).toHaveBeenCalledWith(
      "indexer_lag_over_threshold",
      "critical",
      true,
    );
    expect(metrics.recordAlertState).toHaveBeenCalledWith(
      "webhook_dead_letter_queue_backlog",
      "warning",
      false,
    );
  });

  it("swallows an evaluation failure so other cron jobs keep running", async () => {
    sloService.getReport.mockRejectedValue(new Error("registry unavailable"));

    await expect(scheduler.publishSloAndAlertState()).resolves.toBeUndefined();
    expect(metrics.recordSloEvaluation).not.toHaveBeenCalled();
  });

  it("swallows an alert evaluation failure", async () => {
    alertingService.evaluate.mockRejectedValue(new Error("rule blew up"));

    await expect(scheduler.publishSloAndAlertState()).resolves.toBeUndefined();
    // The SLO publication that already succeeded is not rolled back.
    expect(metrics.recordSloEvaluation).toHaveBeenCalled();
  });
});
