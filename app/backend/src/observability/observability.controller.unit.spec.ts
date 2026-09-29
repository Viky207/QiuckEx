import { Test, TestingModule } from "@nestjs/testing";

import { ApiKeyGuard } from "../auth/guards/api-key.guard";
import { ApiKeysService } from "../api-keys/api-keys.service";
import { AppConfigService } from "../config/app-config.service";
import { AuditService } from "../audit/audit.service";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";
import { NetworkSafetyGuard } from "../feature-flags/network-safety.guard";
import { Reflector } from "@nestjs/core";
import { AlertingService } from "./alerting/alerting.service";
import { DependencyReadinessService } from "./readiness/dependency-readiness.service";
import { ObservabilityController } from "./observability.controller";
import { OperatorReplayService } from "./replay/operator-replay.service";
import { SloService } from "./slo/slo.service";
import { REQUIRED_SCOPES_KEY } from "../auth/decorators/require-scopes.decorator";
import { REQUIRES_FLAG_KEY } from "../feature-flags/requires-flag.decorator";

const PUBLIC_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

/**
 * The observability surface is admin-only. These tests pin the authorization
 * contract (issue #278 acceptance criteria: unauthorized callers are rejected
 * with stable errors) by exercising the real `ApiKeyGuard` against the real
 * controller metadata, rather than by asserting on decorators directly.
 */
/** The controller prototype, typed so handler names can be indexed safely. */
const handlersOf = (): Record<string, object> =>
  ObservabilityController.prototype as unknown as Record<string, object>;

describe("ObservabilityController authorization", () => {
  let controller: ObservabilityController;
  let apiKeys: { validateKey: jest.Mock; isOverQuota: jest.Mock };
  let guard: ApiKeyGuard;
  let reflector: Reflector;

  const sloService = { getReport: jest.fn(), getObjective: jest.fn(), listObjectives: jest.fn() };
  const alertingService = { evaluate: jest.fn(), listRules: jest.fn() };
  const readinessService = { check: jest.fn() };
  const replayService = { getDeliveryStatus: jest.fn(), replay: jest.fn() };

  const adminKey = {
    id: "key-1",
    name: "ops",
    scopes: ["admin"],
    rateLimit: 100,
    organization_id: null,
  };

  const readOnlyKey = {
    id: "key-2",
    name: "reader",
    scopes: ["links:read"],
    rateLimit: 100,
    organization_id: null,
  };

  const contextFor = (apiKey?: string) => {
    const handler = () => undefined;
    jest
      .spyOn(reflector, "getAllAndOverride")
      .mockReturnValue(["admin"] as never);

    return {
      getHandler: () => handler,
      getClass: () => ObservabilityController,
      switchToHttp: () => ({
        getRequest: () => ({
          headers: apiKey ? { "x-api-key": apiKey } : {},
          organizationContext: undefined,
        }),
      }),
    } as never;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    apiKeys = {
      validateKey: jest.fn(),
      isOverQuota: jest.fn().mockReturnValue(false),
    };
    reflector = new Reflector();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ObservabilityController],
      providers: [
        { provide: SloService, useValue: sloService },
        { provide: AlertingService, useValue: alertingService },
        { provide: DependencyReadinessService, useValue: readinessService },
        { provide: OperatorReplayService, useValue: replayService },
        { provide: ApiKeysService, useValue: apiKeys },
        { provide: Reflector, useValue: reflector },
        { provide: AppConfigService, useValue: { isTestnet: true, network: "testnet" } },
        { provide: FeatureFlagsService, useValue: { evaluateFlag: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        ApiKeyGuard,
        NetworkSafetyGuard,
      ],
    }).compile();

    controller = module.get<ObservabilityController>(ObservabilityController);
    guard = module.get<ApiKeyGuard>(ApiKeyGuard);
  });

  it("declares the admin scope on every observability route", () => {
    const handlers = handlersOf();

    for (const name of Object.getOwnPropertyNames(handlers)) {
      if (name === "constructor") continue;
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handlers[name])).toEqual([
        "admin",
      ]);
    }
  });

  it("rejects a request with no API key", async () => {
    await expect(guard.canActivate(contextFor())).rejects.toMatchObject({
      response: { error: "API_KEY_REQUIRED" },
      status: 401,
    });
  });

  it("rejects a key that lacks the admin scope", async () => {
    apiKeys.validateKey.mockResolvedValue({
      record: readOnlyKey,
      hasScope: (scope: string) => readOnlyKey.scopes.includes(scope),
    });

    await expect(guard.canActivate(contextFor("k"))).rejects.toMatchObject({
      response: { error: "INSUFFICIENT_SCOPE" },
      status: 403,
    });
  });

  it("rejects an unknown key", async () => {
    apiKeys.validateKey.mockResolvedValue(null);

    await expect(guard.canActivate(contextFor("k"))).rejects.toMatchObject({
      response: { error: "INVALID_API_KEY" },
      status: 401,
    });
  });

  it("rejects a key whose monthly quota is exhausted", async () => {
    apiKeys.validateKey.mockResolvedValue({
      record: adminKey,
      hasScope: (scope: string) => adminKey.scopes.includes(scope),
    });
    apiKeys.isOverQuota.mockReturnValue(true);

    await expect(guard.canActivate(contextFor("k"))).rejects.toMatchObject({
      response: { error: "QUOTA_EXCEEDED" },
      status: 403,
    });
  });

  it("admits an admin key", async () => {
    apiKeys.validateKey.mockResolvedValue({
      record: adminKey,
      hasScope: (scope: string) => adminKey.scopes.includes(scope),
    });

    await expect(guard.canActivate(contextFor("k"))).resolves.toBe(true);
  });

  it("routes a replay through the operator service with the request actor", async () => {
    replayService.replay.mockResolvedValue({ delivered: true });

    await controller.replayDelivery(
      PUBLIC_KEY,
      "email",
      "payment.received",
      "tx-1",
      "op-42",
    );

    expect(replayService.replay).toHaveBeenCalledWith(
      PUBLIC_KEY,
      "email",
      "payment.received",
      "tx-1",
      "op-42",
    );
  });

  it("falls back to a generic actor when none is supplied", async () => {
    replayService.replay.mockResolvedValue({ delivered: true });

    await controller.replayDelivery(
      PUBLIC_KEY,
      "email",
      "payment.received",
      "tx-1",
      undefined,
    );

    expect(replayService.replay).toHaveBeenCalledWith(
      PUBLIC_KEY,
      "email",
      "payment.received",
      "tx-1",
      "admin-api-key",
    );
  });

  it("gates the mainnet replay route behind the operator replay flag", () => {
    // Replay re-sends a customer notification, so on mainnet it must be
    // enabled deliberately rather than being available by default.
    const flag = Reflect.getMetadata(
      REQUIRES_FLAG_KEY,
      handlersOf().replayDelivery,
    );
    expect(flag).toBe("mainnet.operator_replay");
  });

  it("does not gate the read-only SLO, alert or dependency routes", () => {
    const handlers = handlersOf();
    for (const name of [
      "getSlo",
      "getSloObjective",
      "getAlerts",
      "getAlertRules",
      "getDependencies",
      "getReplayTarget",
    ]) {
      expect(Reflect.getMetadata(REQUIRES_FLAG_KEY, handlers[name])).toBeUndefined();
    }
  });

  it("reports the available objective ids for an unknown SLO id", async () => {
    sloService.getObjective.mockResolvedValue(undefined);
    sloService.listObjectives.mockReturnValue([{ id: "payment_availability" }]);

    const result = await controller.getSloObjective("nope");

    expect(result).toEqual({
      found: false,
      available: ["payment_availability"],
    });
  });
});
