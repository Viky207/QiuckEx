import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";

import { RequireScopes } from "../auth/decorators/require-scopes.decorator";
import { ApiKeyGuard } from "../auth/guards/api-key.guard";
import { MAINNET_OPERATOR_REPLAY_FLAG } from "../feature-flags/contract-write-kill-switch.constants";
import { NetworkSafetyGuard } from "../feature-flags/network-safety.guard";
import { RequiresFlag } from "../feature-flags/requires-flag.decorator";
import { AlertingService } from "./alerting/alerting.service";
import { DependencyReadinessService } from "./readiness/dependency-readiness.service";
import { OperatorReplayService } from "./replay/operator-replay.service";
import { SloService } from "./slo/slo.service";
import type { NotificationChannel } from "../notifications/types/notification.types";

/**
 * Operator-facing observability surface.
 *
 * Every route is behind `ApiKeyGuard` with the `admin` scope, matching the
 * existing `admin/operations` surface: an API key is required (401 without
 * one), and a key lacking the `admin` scope is rejected with
 * `INSUFFICIENT_SCOPE` (403). Nothing here is public, and nothing here
 * returns secrets, key material, webhook signing secrets, or notification
 * bodies.
 */
@ApiTags("observability")
@Controller("admin/observability")
@UseGuards(ApiKeyGuard)
export class ObservabilityController {
  constructor(
    private readonly sloService: SloService,
    private readonly alertingService: AlertingService,
    private readonly readinessService: DependencyReadinessService,
    private readonly replayService: OperatorReplayService,
  ) {}

  @Get("slo")
  @RequireScopes("admin")
  @ApiOperation({
    summary: "Evaluate the service level objectives and error budgets",
    description:
      "Returns every objective in the SLO catalog with its observed " +
      "compliance ratio, error-budget burn rate and remaining budget, plus the " +
      "raw counters the ratio was derived from. Objectives with no traffic " +
      "report `insufficient_data` rather than being reported as healthy.",
  })
  getSlo() {
    return this.sloService.getReport();
  }

  @Get("slo/:id")
  @RequireScopes("admin")
  @ApiOperation({ summary: "Evaluate a single service level objective" })
  @ApiParam({
    name: "id",
    description: "SLO identifier, e.g. payment_availability",
  })
  async getSloObjective(@Param("id") id: string) {
    const objective = await this.sloService.getObjective(id);

    if (!objective) {
      return {
        found: false,
        available: this.sloService
          .listObjectives()
          .map((definition) => definition.id),
      };
    }

    return { found: true, objective };
  }

  @Get("alerts")
  @RequireScopes("admin")
  @ApiOperation({
    summary: "Evaluate the alert rules and return their current state",
    description:
      "Returns each alert rule with its state (ok, pending, firing, no_data), " +
      "the measurement it was judged on, and the runbook step to take. This " +
      "evaluates on read, so the response reflects the current registry rather " +
      "than a cached evaluation.",
  })
  getAlerts() {
    return this.alertingService.evaluate();
  }

  @Get("alerts/rules")
  @RequireScopes("admin")
  @ApiOperation({ summary: "List the alert rules and their thresholds" })
  getAlertRules() {
    return { rules: this.alertingService.listRules() };
  }

  @Get("dependencies")
  @RequireScopes("admin")
  @ApiOperation({
    summary: "Probe every core dependency and report readiness",
    description:
      "Returns a per-dependency probe result with criticality, status and " +
      "latency. `ready` reflects only critical dependencies, so an optional " +
      "cache being down degrades the report without pulling the instance out " +
      "of rotation.",
  })
  async getDependencies() {
    return this.readinessService.check();
  }

  @Get("replay/:publicKey/:channel/:eventType/:eventId")
  @RequireScopes("admin")
  @ApiOperation({
    summary: "Inspect a notification delivery before replaying it",
    description:
      "Returns the delivery row for one (public key, channel, event) tuple " +
      "without changing anything. Use this to confirm the delivery is in a " +
      "replayable state before calling the replay route.",
  })
  @ApiParam({
    name: "publicKey",
    description: "Stellar account the delivery belongs to",
  })
  @ApiParam({ name: "channel", description: "Notification channel" })
  getReplayTarget(
    @Param("publicKey") publicKey: string,
    @Param("channel") channel: string,
    @Param("eventType") eventType: string,
    @Param("eventId") eventId: string,
  ) {
    return this.replayService.getDeliveryStatus(
      publicKey,
      channel as NotificationChannel,
      eventType,
      eventId,
    );
  }

  @Post("replay/:publicKey/:channel/:eventType/:eventId")
  @RequireScopes("admin")
  @UseGuards(NetworkSafetyGuard)
  @RequiresFlag(MAINNET_OPERATOR_REPLAY_FLAG)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Replay a failed notification or webhook delivery",
    description:
      "Re-sends one delivery that previously failed or exhausted its retries. " +
      "A delivery that already succeeded is refused with " +
      "`OPERATOR_REPLAY_ALREADY_DELIVERED` so an operator cannot cause a " +
      "duplicate notification. Replays are recorded in the audit log and " +
      "counted in `quickex_operator_replay_total`.",
  })
  @ApiParam({
    name: "publicKey",
    description: "Stellar account the delivery belongs to",
  })
  @ApiParam({ name: "channel", description: "Notification channel to replay" })
  @ApiResponse({ status: 404, description: "No delivery record for this event" })
  @ApiResponse({ status: 409, description: "Already delivered or in progress" })
  @ApiResponse({ status: 429, description: "Replay cooldown or quota exceeded" })
  @ApiResponse({ status: 503, description: "Dependency failure or blocked by the mainnet replay gate" })
  replayDelivery(
    @Param("publicKey") publicKey: string,
    @Param("channel") channel: string,
    @Param("eventType") eventType: string,
    @Param("eventId") eventId: string,
    @Query("actor") actor?: string,
  ) {
    return this.replayService.replay(
      publicKey,
      channel as NotificationChannel,
      eventType,
      eventId,
      actor ?? "admin-api-key",
    );
  }
}
