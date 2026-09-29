import {
  buildMigrationNotice,
  buildVersionHeaders,
  buildWebhookEventEnvelope,
  getEventVersionDescriptor,
  isDeprecatedEventVersion,
  isSupportedEventVersion,
  normalizeApiVersion,
  DEFAULT_WEBHOOK_API_VERSION,
  LATEST_WEBHOOK_API_VERSION,
  SUPPORTED_WEBHOOK_API_VERSIONS,
} from "../webhook-event-versions";

/**
 * Issue #275: webhook events are versioned and carry migration metadata, so a
 * subscriber can move deliberately instead of guessing at the payload shape.
 */
describe("webhook event versions", () => {
  const baseInput = {
    eventType: "payment.received",
    eventId: "tx-abc",
    occurredAt: "2026-01-01T00:00:00.000Z",
    data: { amountStroops: "1000" },
  };

  describe("normalizeApiVersion", () => {
    it("accepts a supported version", () => {
      expect(normalizeApiVersion("v2")).toBe("v2");
      expect(normalizeApiVersion("v1")).toBe("v1");
    });

    it("falls back to the default for an unknown version", () => {
      expect(normalizeApiVersion("v99")).toBe(DEFAULT_WEBHOOK_API_VERSION);
      expect(normalizeApiVersion("")).toBe(DEFAULT_WEBHOOK_API_VERSION);
    });

    it("falls back to the default for null or undefined", () => {
      expect(normalizeApiVersion(null)).toBe(DEFAULT_WEBHOOK_API_VERSION);
      expect(normalizeApiVersion(undefined)).toBe(DEFAULT_WEBHOOK_API_VERSION);
    });

    it("exposes a default that is itself supported", () => {
      expect(SUPPORTED_WEBHOOK_API_VERSIONS).toContain(
        DEFAULT_WEBHOOK_API_VERSION,
      );
      expect(SUPPORTED_WEBHOOK_API_VERSIONS).toContain(
        LATEST_WEBHOOK_API_VERSION,
      );
    });
  });

  describe("getEventVersionDescriptor", () => {
    it("describes a registered event", () => {
      const descriptor = getEventVersionDescriptor("payment.received");

      expect(descriptor.currentVersion).toBe("2");
      expect(descriptor.supportedVersions).toContain("1");
    });

    it("falls back to v1 for an unregistered event rather than throwing", () => {
      const descriptor = getEventVersionDescriptor("not.a.real.event");

      expect(descriptor.currentVersion).toBe("1");
      expect(descriptor.eventType).toBe("not.a.real.event");
    });
  });

  describe("isSupportedEventVersion / isDeprecatedEventVersion", () => {
    it("recognises a supported legacy version", () => {
      expect(isSupportedEventVersion("payment.received", "1")).toBe(true);
      expect(isDeprecatedEventVersion("payment.received", "1")).toBe(true);
    });

    it("does not mark the current version as deprecated", () => {
      expect(isDeprecatedEventVersion("payment.received", "2")).toBe(false);
    });

    it("rejects a version outside the supported set", () => {
      expect(isSupportedEventVersion("payment.received", "99")).toBe(false);
    });
  });

  describe("buildMigrationNotice", () => {
    it("returns undefined when the subscriber is on the current version", () => {
      expect(buildMigrationNotice("payment.received", "2")).toBeUndefined();
    });

    it("describes the gap for a subscriber behind the current version", () => {
      const notice = buildMigrationNotice("payment.received", "1");

      expect(notice).toMatchObject({
        eventType: "payment.received",
        deliveredVersion: "1",
        currentVersion: "2",
        deprecated: true,
      });
      expect(notice?.sunsetAt).toBeDefined();
      expect(notice?.migration).toContain("migrating");
    });

    it("returns undefined for an event with a single version", () => {
      expect(buildMigrationNotice("EscrowDeposited", "1")).toBeUndefined();
    });
  });


  describe("buildWebhookEventEnvelope", () => {
    it("stamps the pinned API version and the event schema version", () => {
      const envelope = buildWebhookEventEnvelope({
        ...baseInput,
        apiVersion: "v2",
      });

      expect(envelope.apiVersion).toBe("v2");
      expect(envelope.version).toBe("2");
      expect(envelope.eventType).toBe("payment.received");
      expect(envelope.eventId).toBe("tx-abc");
      expect(envelope.occurredAt).toBe(baseInput.occurredAt);
    });

    it("produces a deterministic delivery id, so a replay is recognisable", () => {
      const first = buildWebhookEventEnvelope({
        ...baseInput,
        apiVersion: "v1",
      });
      const replay = buildWebhookEventEnvelope({
        ...baseInput,
        apiVersion: "v1",
      });

      expect(first.id).toBe(replay.id);
      expect(first.id).toBe("v1:payment.received:tx-abc");
    });

    it("scopes the delivery id to the API version so pins do not collide", () => {
      const v1 = buildWebhookEventEnvelope({ ...baseInput, apiVersion: "v1" });
      const v2 = buildWebhookEventEnvelope({ ...baseInput, apiVersion: "v2" });

      expect(v1.id).not.toBe(v2.id);
    });

    it("preserves the event data across versions (projection is additive)", () => {
      const envelope = buildWebhookEventEnvelope({
        ...baseInput,
        apiVersion: "v1",
      });

      expect(envelope.data).toEqual({ amountStroops: "1000" });
    });

    it("does not mutate the caller's data object", () => {
      const data = { amountStroops: "1000" };
      buildWebhookEventEnvelope({ ...baseInput, data, apiVersion: "v1" });

      expect(data).toEqual({ amountStroops: "1000" });
    });

    it("omits the migration field for an event at its current version", () => {
      const envelope = buildWebhookEventEnvelope({
        eventType: "EscrowDeposited",
        eventId: "1-1",
        occurredAt: baseInput.occurredAt,
        apiVersion: "v1",
        data: {},
      });

      expect(envelope.version).toBe("1");
      expect(envelope.migration).toBeUndefined();
    });

    it("handles an unregistered event type without throwing", () => {
      const envelope = buildWebhookEventEnvelope({
        eventType: "brand.new.event",
        eventId: "1",
        occurredAt: baseInput.occurredAt,
        apiVersion: "v1",
        data: {},
      });

      expect(envelope.version).toBe("1");
    });
  });

  describe("buildVersionHeaders", () => {
    it("exposes the version on headers so subscribers need not parse the body", () => {
      const envelope = buildWebhookEventEnvelope({
        ...baseInput,
        apiVersion: "v2",
      });
      const headers = buildVersionHeaders(envelope);

      expect(headers["X-QuickEx-Api-Version"]).toBe("v2");
      expect(headers["X-QuickEx-Event-Version"]).toBe("2");
      expect(headers["X-QuickEx-Event"]).toBe("payment.received");
      expect(headers["X-QuickEx-Event-Id"]).toBe("tx-abc");
      expect(headers["X-QuickEx-Delivery-Id"]).toBe(envelope.id);
    });

    it("omits the sunset header when the subscriber is current", () => {
      const envelope = buildWebhookEventEnvelope({
        eventType: "EscrowDeposited",
        eventId: "1-1",
        occurredAt: baseInput.occurredAt,
        apiVersion: "v1",
        data: {},
      });

      expect(
        buildVersionHeaders(envelope)["X-QuickEx-Event-Sunset-At"],
      ).toBeUndefined();
    });
  });
});
