import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { FeatureFlagsModule } from "../feature-flags/feature-flags.module";
import { HealthModule } from "../health/health.module";
import { IndexerLagModule } from "../indexer-lag";
import { MetricsModule } from "../metrics/metrics.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ObservabilityController } from "./observability.controller";
import { ObservabilityScheduler } from "./observability.scheduler";
import { AlertingService } from "./alerting/alerting.service";
import { DependencyReadinessService } from "./readiness/dependency-readiness.service";
import { OperatorReplayService } from "./replay/operator-replay.service";
import { SloService } from "./slo/slo.service";
import { TracingMiddleware } from "./tracing/tracing.middleware";

/**
 * SLOs, error budgets, alerts, dependency probes, request tracing and operator
 * replay tooling (issues #278-#281).
 *
 * The module owns no new persistence and no new external dependency: every
 * series it reads or writes already belongs to `MetricsModule`, and every
 * delivery it replays belongs to `NotificationsModule`.
 */
@Module({
  imports: [
    MetricsModule,
    AuditModule,
    HealthModule,
    IndexerLagModule,
    NotificationsModule,
    FeatureFlagsModule,
  ],
  controllers: [ObservabilityController],
  providers: [
    SloService,
    AlertingService,
    DependencyReadinessService,
    OperatorReplayService,
    ObservabilityScheduler,
    TracingMiddleware,
  ],
  exports: [SloService, AlertingService, DependencyReadinessService],
})
export class ObservabilityModule {}
