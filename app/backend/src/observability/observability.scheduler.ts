import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";

import { MetricsService } from "../metrics/metrics.service";
import { AlertingService } from "./alerting/alerting.service";
import { SloService } from "./slo/slo.service";

/**
 * Publishes the evaluated SLO report and alert states as Prometheus series.
 *
 * Without this, the SLO and alert state would only exist inside an admin
 * response: a dashboard or an Alertmanager rule could not read them. The
 * scheduler makes both scrapeable, which is what turns "an operator can ask"
 * into "the system tells you".
 *
 * Failures are logged and swallowed: a broken SLO evaluation must not take the
 * scheduler down and stop every other cron job in the process.
 */
@Injectable()
export class ObservabilityScheduler {
  private readonly logger = new Logger(ObservabilityScheduler.name);

  constructor(
    private readonly sloService: SloService,
    private readonly alertingService: AlertingService,
    private readonly metrics: MetricsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async publishSloAndAlertState(): Promise<void> {
    try {
      const report = await this.sloService.getReport();

      for (const objective of report.objectives) {
        this.metrics.recordSloEvaluation(objective);
      }

      const alerts = await this.alertingService.evaluate();
      for (const alert of alerts.alerts) {
        this.metrics.recordAlertState(
          alert.id,
          alert.severity,
          alert.state === "firing",
        );
      }

      this.logger.debug(
        `Published SLO status ${report.overallStatus} and ` +
          `${alerts.firing} firing alert(s)`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to publish observability state: ${(error as Error).message}`,
      );
    }
  }
}
