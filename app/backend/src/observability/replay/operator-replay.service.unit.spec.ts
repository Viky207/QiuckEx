import {
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";

import { AuditService } from "../../audit/audit.service";
import { MetricsService } from "../../metrics/metrics.service";
import { NotificationLogRepository } from "../../notifications/notification-log.repository";
import { NotificationPreferencesRepository } from "../../notifications/notification-preferences.repository";
import { NotificationService } from "../../notifications/notification.service";
import { WebhookReplayService } from "../../notifications/webhook-replay.service";
import { OperatorReplayService } from "./operator-replay.service";

const PUBLIC_KEY = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

describe("OperatorReplayService", () => {
  let service: OperatorReplayService;
  let logRepo: {
    getDelivery: jest.Mock;
    resetNotificationForManualReplay: jest.Mock;
  };
  let prefsRepo: { getWebhooksByPublicKey: jest.Mock; getPreferences: jest.Mock };
  let notificationService: { redeliverToChannel: jest.Mock };
  let webhookReplayService: { replayDelivery: jest.Mock };
  let audit: { log: jest.Mock };
  let metrics: { recordOperatorReplay: jest.Mock };

  const delivery = (overrides: Record<string, unknown> = {}) => ({
    id: "log-1",
    channel: "email",
    eventType: "payment.received",
    eventId: "tx-1",
    status: "failed",
    attempts: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    ...overrides,
  });

  const replay = (channel = "email", eventId = "tx-1") =>
    service.replay(PUBLIC_KEY, channel as never, "payment.received", eventId, "op-1");

  beforeEach(async () => {
    logRepo = {
      getDelivery: jest.fn().mockResolvedValue(delivery()),
      resetNotificationForManualReplay: jest.fn().mockResolvedValue(undefined),
    };
    prefsRepo = {
      getWebhooksByPublicKey: jest
        .fn()
        .mockResolvedValue([{ id: "wh-1", enabled: true, webhookUrl: "https://x" }]),
      getPreferences: jest
        .fn()
        .mockResolvedValue([{ publicKey: PUBLIC_KEY, channel: "email" }]),
    };
    notificationService = { redeliverToChannel: jest.fn().mockResolvedValue(undefined) };
    webhookReplayService = {
      replayDelivery: jest
        .fn()
        .mockResolvedValue({ queued: true, deliverySuccess: true }),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    metrics = { recordOperatorReplay: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OperatorReplayService,
        { provide: NotificationLogRepository, useValue: logRepo },
        { provide: NotificationPreferencesRepository, useValue: prefsRepo },
        { provide: NotificationService, useValue: notificationService },
        { provide: WebhookReplayService, useValue: webhookReplayService },
        { provide: AuditService, useValue: audit },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();

    service = module.get<OperatorReplayService>(OperatorReplayService);
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  it("replays a failed notification and records the attempt", async () => {
    logRepo.getDelivery
      .mockResolvedValueOnce(delivery())
      .mockResolvedValueOnce(delivery({ status: "sent" }));

    const result = await replay();

    expect(result).toMatchObject({
      accepted: true,
      target: "notification",
      delivered: true,
    });
    expect(notificationService.redeliverToChannel).toHaveBeenCalledTimes(1);
    expect(metrics.recordOperatorReplay).toHaveBeenCalledWith(
      "notification",
      "succeeded",
    );
    expect(audit.log).toHaveBeenCalledWith(
      "op-1",
      "operator.replay",
      expect.any(String),
      expect.objectContaining({ delivered: true, previousStatus: "failed" }),
    );
  });

  it("delegates webhook replays to the existing guarded replay service", async () => {
    const result = await replay("webhook");

    expect(webhookReplayService.replayDelivery).toHaveBeenCalledWith(
      PUBLIC_KEY,
      "wh-1",
      "tx-1",
      "payment.received",
      "operator",
    );
    // The operator surface must not bypass the cooldown/quota limiter.
    expect(notificationService.redeliverToChannel).not.toHaveBeenCalled();
    expect(result.target).toBe("webhook");
  });

  it("reports a completed-but-unsuccessful replay without throwing", async () => {
    notificationService.redeliverToChannel.mockResolvedValue(undefined);
    logRepo.getDelivery
      .mockResolvedValueOnce(delivery())
      .mockResolvedValueOnce(delivery({ status: "failed" }));

    const result = await replay();

    expect(result.delivered).toBe(false);
    expect(metrics.recordOperatorReplay).toHaveBeenCalledWith(
      "notification",
      "failed",
    );
  });

  // ── Duplicate / already-delivered suppression ────────────────────────────

  it("refuses to send a duplicate when the delivery already succeeded", async () => {
    logRepo.getDelivery.mockResolvedValue(delivery({ status: "sent" }));

    await expect(replay()).rejects.toMatchObject({
      response: {
        code: "OPERATOR_REPLAY_ALREADY_DELIVERED",
      },
      status: HttpStatus.CONFLICT,
    });

    expect(notificationService.redeliverToChannel).not.toHaveBeenCalled();
    expect(metrics.recordOperatorReplay).toHaveBeenCalledWith(
      "notification",
      "rejected",
    );
  });

  it("refuses to replay a delivery that is already in progress", async () => {
    logRepo.getDelivery.mockResolvedValue(delivery({ status: "pending" }));

    await expect(replay()).rejects.toMatchObject({
      response: { code: "OPERATOR_REPLAY_COOLDOWN" },
      status: HttpStatus.CONFLICT,
    });

    expect(notificationService.redeliverToChannel).not.toHaveBeenCalled();
  });

  // ── Not found / malformed / unsupported ──────────────────────────────────

  it("returns a stable 404 when no delivery exists", async () => {
    logRepo.getDelivery.mockResolvedValue(null);

    await expect(replay()).rejects.toMatchObject({
      response: { code: "OPERATOR_REPLAY_NOT_FOUND" },
      status: HttpStatus.NOT_FOUND,
    });
  });

  it("rejects an unsupported channel before touching the database", async () => {
    // in_app is deliberately not replayable: duplicating an inbox row would
    // show a user the same event twice.
    await expect(replay("in_app")).rejects.toBeInstanceOf(BadRequestException);
    expect(logRepo.getDelivery).not.toHaveBeenCalled();
    expect(metrics.recordOperatorReplay).toHaveBeenCalledWith(
      "notification",
      "rejected",
    );
  });

  it.each([
    ["blank event type", "   ", "tx-1"],
    ["blank event id", "payment.received", "  "],
  ])("rejects a %s as malformed", async (_label, eventType, eventId) => {
    await expect(
      service.replay(PUBLIC_KEY, "email" as never, eventType, eventId, "op-1"),
    ).rejects.toMatchObject({
      response: { code: "OPERATOR_REPLAY_MALFORMED" },
    });

    expect(logRepo.getDelivery).not.toHaveBeenCalled();
  });

  // ── Dependency failure ───────────────────────────────────────────────────

  it("maps a repository failure to a retryable 503", async () => {
    logRepo.getDelivery.mockRejectedValue(new Error("supabase timeout"));

    await expect(replay()).rejects.toMatchObject({
      response: { code: "OPERATOR_REPLAY_DEPENDENCY_FAILURE" },
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });

    expect(metrics.recordOperatorReplay).toHaveBeenCalledWith(
      "notification",
      "failed",
    );
  });

  it("maps a missing webhook registration to a 503", async () => {
    prefsRepo.getWebhooksByPublicKey.mockResolvedValue([
      { id: "wh-1", enabled: false, webhookUrl: null },
    ]);
    logRepo.getDelivery.mockResolvedValue(delivery({ channel: "webhook" }));

    await expect(replay("webhook")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("maps a missing channel preference to a 503", async () => {
    prefsRepo.getPreferences.mockResolvedValue([
      { publicKey: PUBLIC_KEY, channel: "push" },
    ]);

    await expect(replay()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("still audits an accepted replay whose delivery did not land", async () => {
    logRepo.getDelivery
      .mockResolvedValueOnce(delivery())
      .mockResolvedValueOnce(delivery({ status: "dlq" }));

    await replay();

    expect(audit.log).toHaveBeenCalledWith(
      "op-1",
      "operator.replay",
      expect.any(String),
      expect.objectContaining({ delivered: false }),
    );
  });

  // ── Inspection ───────────────────────────────────────────────────────────

  it("inspects a delivery without changing anything", async () => {
    const status = await service.getDeliveryStatus(
      PUBLIC_KEY,
      "email",
      "payment.received",
      "tx-1",
    );

    expect(status.status).toBe("failed");
    expect(notificationService.redeliverToChannel).not.toHaveBeenCalled();
    expect(logRepo.resetNotificationForManualReplay).not.toHaveBeenCalled();
  });

  it("returns a stable 404 when inspecting a missing delivery", async () => {
    logRepo.getDelivery.mockResolvedValue(null);

    await expect(
      service.getDeliveryStatus(PUBLIC_KEY, "email", "payment.received", "tx-1"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("resets the delivery row before re-sending so attempts are re-counted", async () => {
    logRepo.getDelivery
      .mockResolvedValueOnce(delivery())
      .mockResolvedValueOnce(delivery({ status: "sent" }));

    await replay();

    expect(logRepo.resetNotificationForManualReplay).toHaveBeenCalledWith(
      PUBLIC_KEY,
      "email",
      "payment.received",
      "tx-1",
    );
  });

  it("surfaces a stable error type for every rejection", async () => {
    logRepo.getDelivery.mockResolvedValue(null);

    await expect(replay()).rejects.toBeInstanceOf(HttpException);
  });
});
