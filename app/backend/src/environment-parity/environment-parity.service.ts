import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service";
import { MetricsService } from "../metrics/metrics.service";
import { HealthService } from "../health/health.service";

export interface ParityCheckResult {
  check: string;
  status: "pass" | "fail" | "warning";
  details?: string;
}

export type TrafficSlot = "blue" | "green";

export interface TrafficSwitchResult {
  status: "switched" | "already_active" | "refused" | "failed";
  activeSlot: TrafficSlot | null;
  targetSlot: TrafficSlot | null;
  attempts: number;
  reason?: string;
}

/**
 * Error raised when a promotion is attempted while a deploy freeze is active.
 */
export class DeployFreezeError extends Error {
  constructor(public readonly reason: string) {
    super(`Deploy freeze active: ${reason}`);
    this.name = "DeployFreezeError";
  }
}

/**
 * Error raised when the traffic controller returns an unusable response.
 */
export class TrafficControllerError extends Error {
  constructor(
    message: string,
    public readonly kind: "timeout" | "malformed" | "uncertain" | "unready",
  ) {
    super(message);
    this.name = "TrafficControllerError";
  }
}
=======

/**
 * EnvironmentParityService validates that staging environment configuration
 * matches production expectations to catch deployment issues early.
 *
 * This service performs checks on:
 * - Configuration parity (endpoints, versions, feature flags)
 * - Network connectivity
 * - Service dependencies
 *
 * All checks are non-blocking and logged for monitoring.
 */
@Injectable()
export class EnvironmentParityService implements OnModuleInit {
  private readonly logger = new Logger(EnvironmentParityService.name);
  private parityResults: ParityCheckResult[] = [];

  constructor(
    private readonly config: AppConfigService,
    private readonly metricsService: MetricsService,
    private readonly healthService: HealthService,
  ) {}

  async onModuleInit() {
    if (this.config.envParityCheckEnabled) {
      await this.runParityChecks();
    }
  }

  /**
   * Run all environment parity checks
   */
  async runParityChecks(): Promise<ParityCheckResult[]> {
    this.logger.log("Running environment parity checks...");
    this.parityResults = [];

    // Run checks in parallel where possible
    await Promise.allSettled([
      this.checkEnvironmentName(),
      this.checkNetworkConfiguration(),
      this.checkProductionBaseUrl(),
      this.checkStellarConfiguration(),
      this.checkSupabaseConfiguration(),
      this.checkFeatureFlags(),
      this.checkVersionCompatibility(),
    ]);

    // Log results
    const passed = this.parityResults.filter((r) => r.status === "pass").length;
    const failed = this.parityResults.filter((r) => r.status === "fail").length;
    const warnings = this.parityResults.filter(
      (r) => r.status === "warning",
    ).length;

    this.logger.log(
      `Environment parity checks complete: ${passed} passed, ${failed} failed, ${warnings} warnings`,
    );

    // Log failures and warnings
    this.parityResults
      .filter((r) => r.status !== "pass")
      .forEach((result) => {
        this.logger.warn(
          `[${result.status.toUpperCase()}] ${result.check}: ${result.details}`,
        );
      });

    // Record metrics
    this.metricsService.recordParityCheckResult(
      "total",
      passed,
      failed,
      warnings,
    );

    return this.parityResults;
  }

  /**
   * Get current parity check results
   */
  getResults(): ParityCheckResult[] {
    return this.parityResults;
  }

  /**
   * Whether automatic production promotion is currently held by a deploy freeze.
   */
  isFrozen(): boolean {
    return this.config.deployFreezeEnabled;
  }

  /**
   * Gate a promotion on the deploy-freeze state.
   *
   * Validation workflows remain enabled while frozen; only traffic-changing
   * promotion is refused. An authorized override must be recorded by the
   * caller (with actor and reason) before invoking this method with
   * `override: true`.
   */
  assertPromotionAllowed(override = false): void {
    if (!this.isFrozen() || override) {
      return;
    }

    const reason = this.config.deployFreezeReason || "unspecified";
    this.metricsService.recordParityCheckResult("deploy_freeze", 0, 1, 0);
    this.logger.warn(`Promotion refused: deploy freeze active (${reason})`);
    throw new DeployFreezeError(reason);
  }

  /**
   * Switch blue-green traffic to the given slot idempotently.
   *
   * The active slot is always queried from the controller before any switch
   * attempt so that retries after an uncertain result never re-send traffic to
   * an already-active or unready target. Timeouts, malformed responses and
   * uncertain results are retried a bounded number of times and surfaced in
   * metrics with an explicit error state.
   */
  async switchTraffic(
    targetSlot: TrafficSlot,
    options: { maxAttempts?: number } = {},
  ): Promise<TrafficSwitchResult> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    let attempts = 0;
    let lastError: TrafficControllerError | undefined;

    while (attempts < maxAttempts) {
      attempts += 1;

      let activeSlot: TrafficSlot | null;
      try {
        activeSlot = await this.queryActiveSlot();
      } catch (error) {
        lastError = this.toControllerError(error, "uncertain");
        this.recordTrafficSwitch("query_failed", targetSlot, attempts);
        continue;
      }

      if (activeSlot === targetSlot) {
        this.recordTrafficSwitch("already_active", targetSlot, attempts);
        return {
          status: "already_active",
          activeSlot,
          targetSlot,
          attempts,
        };
      }

      const ready = await this.isTargetReady(targetSlot);
      if (!ready) {
        this.recordTrafficSwitch("unready_target", targetSlot, attempts);
        return {
          status: "refused",
          activeSlot,
          targetSlot,
          attempts,
          reason: `Target slot ${targetSlot} is not ready`,
        };
      }

      try {
        await this.sendSwitch(targetSlot);
        this.recordTrafficSwitch("switched", targetSlot, attempts);
        return { status: "switched", activeSlot, targetSlot, attempts };
      } catch (error) {
        lastError = this.toControllerError(error, "uncertain");
        this.recordTrafficSwitch(lastError.kind, targetSlot, attempts);
        // Loop re-queries the active slot before retrying so an uncertain
        // result is resolved rather than blindly re-sent.
      }
    }

    this.recordTrafficSwitch("failed", targetSlot, attempts);
    return {
      status: "failed",
      activeSlot: null,
      targetSlot,
      attempts,
      reason: lastError?.message ?? "Traffic switch failed",
    };
  }

  private async queryActiveSlot(): Promise<TrafficSlot> {
    const response = await this.callController("GET", "/active");
    const slot = (response as { activeSlot?: unknown })?.activeSlot;
    if (slot !== "blue" && slot !== "green") {
      throw new TrafficControllerError(
        "Malformed active-slot response",
        "malformed",
      );
    }
    return slot;
  }

  private async isTargetReady(targetSlot: TrafficSlot): Promise<boolean> {
    try {
      const health = await this.healthService.check();
      return Boolean(health) && health.status === "ok";
    } catch {
      return false;
    }
  }

  private async sendSwitch(targetSlot: TrafficSlot): Promise<void> {
    await this.callController("POST", "/switch", { targetSlot });
  }

  private async callController(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const baseUrl = this.config.trafficControllerUrl;
    if (!baseUrl) {
      throw new TrafficControllerError(
        "Traffic controller URL not configured",
        "uncertain",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.trafficControllerTimeoutMs,
    );

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new TrafficControllerError(
          `Traffic controller returned ${response.status}`,
          "uncertain",
        );
      }

      try {
        return await response.json();
      } catch {
        throw new TrafficControllerError(
          "Malformed traffic controller response",
          "malformed",
        );
      }
    } catch (error) {
      if (error instanceof TrafficControllerError) {
        throw error;
      }
      if ((error as Error)?.name === "AbortError") {
        throw new TrafficControllerError(
          "Traffic controller request timed out",
          "timeout",
        );
      }
      throw new TrafficControllerError(
        (error as Error)?.message ?? "Traffic controller request failed",
        "uncertain",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private toControllerError(
    error: unknown,
    fallback: TrafficControllerError["kind"],
  ): TrafficControllerError {
    if (error instanceof TrafficControllerError) {
      return error;
    }
    return new TrafficControllerError(
      (error as Error)?.message ?? "Traffic controller error",
      fallback,
    );
  }

  private recordTrafficSwitch(
    outcome: string,
    targetSlot: TrafficSlot,
    attempts: number,
  ): void {
    this.logger.log(
      `Blue-green traffic switch outcome=${outcome} target=${targetSlot} attempts=${attempts}`,
    );
    this.metricsService.recordParityCheckResult(
      `traffic_switch_${outcome}`,
      0,
      outcome === "switched" || outcome === "already_active" ? 0 : 1,
      0,
    );
  }

  /**
   * Check that environment name is properly set
   */
  private async checkEnvironmentName(): Promise<void> {
    const envName = this.config.environmentName;

    if (!envName) {
      this.parityResults.push({
        check: "environment_name",
        status: "warning",
        details: "ENVIRONMENT_NAME not set - using NODE_ENV fallback",
      });
    } else if (envName === "production" && this.config.isStaging) {
      this.parityResults.push({
        check: "environment_name",
        status: "fail",
        details:
          'ENVIRONMENT_NAME is "production" but running in staging context',
      });
    } else {
      this.parityResults.push({
        check: "environment_name",
        status: "pass",
        details: `Environment: ${envName}`,
      });
    }
  }

  /**
   * Check network configuration parity
   */
  private async checkNetworkConfiguration(): Promise<void> {
    const network = this.config.network;
    const stellarNetwork = this.config.isProduction ? "mainnet" : "testnet";

    if (network !== stellarNetwork) {
      this.parityResults.push({
        check: "network_configuration",
        status: "fail",
        details: `NETWORK (${network}) does not match expected for ${this.config.environmentName || this.config.nodeEnv}`,
      });
    } else {
      this.parityResults.push({
        check: "network_configuration",
        status: "pass",
        details: `Network: ${network}`,
      });
    }
  }

  /**
   * Check production base URL is configured for parity checks
   */
  private async checkProductionBaseUrl(): Promise<void> {
    if (!this.config.productionBaseUrl && this.config.isStaging) {
      this.parityResults.push({
        check: "production_base_url",
        status: "warning",
        details:
          "PRODUCTION_BASE_URL not set - cannot perform remote parity checks",
      });
    } else if (this.config.productionBaseUrl) {
      this.parityResults.push({
        check: "production_base_url",
        status: "pass",
        details: `Production URL configured: ${this.config.productionBaseUrl}`,
      });
    } else {
      this.parityResults.push({
        check: "production_base_url",
        status: "pass",
        details: "Not required for this environment",
      });
    }
  }

  /**
   * Check Stellar configuration
   */
  private async checkStellarConfiguration(): Promise<void> {
    const checks: string[] = [];
    let hasIssue = false;

    if (!this.config.network) {
      checks.push("NETWORK missing");
      hasIssue = true;
    }

    if (this.config.isProduction && !this.config.stellarSecretKey) {
      checks.push("STELLAR_SECRET_KEY missing in production");
      hasIssue = true;
    }

    if (hasIssue) {
      this.parityResults.push({
        check: "stellar_configuration",
        status: "fail",
        details: checks.join(", "),
      });
    } else {
      this.parityResults.push({
        check: "stellar_configuration",
        status: "pass",
        details: "Stellar configuration valid",
      });
    }
  }

  /**
   * Check Supabase configuration
   */
  private async checkSupabaseConfiguration(): Promise<void> {
    if (!this.config.supabaseUrl || !this.config.supabaseAnonKey) {
      this.parityResults.push({
        check: "supabase_configuration",
        status: "fail",
        details: "Supabase configuration incomplete",
      });
    } else {
      this.parityResults.push({
        check: "supabase_configuration",
        status: "pass",
        details: "Supabase configuration valid",
      });
    }
  }

  /**
   * Check feature flags parity
   */
  private async checkFeatureFlags(): Promise<void> {
    const bootstrapFlags = this.config.featureFlagsBootstrapJson;

    if (this.config.isStaging && !bootstrapFlags) {
      this.parityResults.push({
        check: "feature_flags",
        status: "warning",
        details: "No bootstrap feature flags configured for staging",
      });
    } else {
      this.parityResults.push({
        check: "feature_flags",
        status: "pass",
        details: "Feature flags configured",
      });
    }
  }

  /**
   * Check version compatibility
   */
  private async checkVersionCompatibility(): Promise<void> {
    const packageVersion = process.env.npm_package_version || "unknown";

    this.parityResults.push({
      check: "version_compatibility",
      status: "pass",
      details: `Backend version: ${packageVersion}`,
    });
  }
}
