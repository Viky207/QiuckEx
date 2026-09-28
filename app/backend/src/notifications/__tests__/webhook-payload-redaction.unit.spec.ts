import {
  REDACTED,
  isAccountKey,
  isSecretKey,
  redactAccount,
  redactResponseBody,
  redactWebhookPayload,
  redactWebhookPayloadArray,
} from "../webhook-payload-redaction";

/**
 * Issue #277: webhook delivery is the trust boundary. Nothing secret may cross
 * it, and personal data must be minimised in both the outbound payload and the
 * persisted response body.
 */
describe("webhook payload redaction", () => {
  describe("key classification", () => {
    it.each([
      "secret",
      "webhookSecret",
      "signing_secret",
      "apiKey",
      "api_key",
      "authorization",
      "Authorization",
      "accessToken",
      "refresh_token",
      "password",
      "privateKey",
      "mnemonic",
      "seed",
      "signature",
      "cookie",
    ])("treats %s as a secret key", (key) => {
      expect(isSecretKey(key)).toBe(true);
    });

    it.each([
      "amountStroops",
      "eventType",
      "txHash",
      "tokenCode",
      "username",
    ])("does not treat %s as a secret key", (key) => {
      expect(isSecretKey(key)).toBe(false);
    });

    it.each([
      "publicKey",
      "recipientPublicKey",
      "sender",
      "destination",
      "wallet",
    ])("treats %s as an account key", (key) => {
      expect(isAccountKey(key)).toBe(true);
    });
  });

  describe("redactWebhookPayload", () => {
    it("removes secret values at the top level", () => {
      const result = redactWebhookPayload({
        amountStroops: "1000",
        secret: "whsec_super_secret",
        apiKey: "sk-live-123",
      });

      expect(result.secret).toBe(REDACTED);
      expect(result.apiKey).toBe(REDACTED);
      expect(result.amountStroops).toBe("1000");
    });

    it("removes secrets nested inside objects", () => {
      const result = redactWebhookPayload({
        outer: { inner: { password: "hunter2", keep: "visible" } },
      }) as { outer: { inner: Record<string, unknown> } };

      expect(result.outer.inner.password).toBe(REDACTED);
      expect(result.outer.inner.keep).toBe("visible");
    });

    it("removes secrets inside arrays", () => {
      const result = redactWebhookPayload({
        items: [{ token: "abc" }, { token: "def" }],
      }) as { items: Array<Record<string, unknown>> };

      expect(result.items[0].token).toBe(REDACTED);
      expect(result.items[1].token).toBe(REDACTED);
    });

    it("truncates account identifiers to a non-reversible prefix", () => {
      const full =
        "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
      const result = redactWebhookPayload({ sender: full });

      expect(result.sender).toBe("GAAZI4TC…");
      expect(String(result.sender)).not.toContain(full.slice(8));
    });

    it("leaves short account identifiers untouched", () => {
      expect(redactWebhookPayload({ wallet: "short" }).wallet).toBe("short");
    });

    it("does not truncate non-account string values", () => {
      const result = redactWebhookPayload({ txHash: "a".repeat(80) });

      expect(result.txHash).toBe("a".repeat(80));
    });

    it("serialises bigint amounts rather than throwing", () => {
      const result = redactWebhookPayload({ amountStroops: 100n });

      expect(result.amountStroops).toBe("100");
    });

    it("normalises dates to ISO strings", () => {
      const result = redactWebhookPayload({
        occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      expect(result.occurredAt).toBe("2026-01-01T00:00:00.000Z");
    });

    it("bounds runaway strings", () => {
      const result = redactWebhookPayload({ note: "x".repeat(5000) });

      expect(String(result.note).length).toBeLessThan(600);
      expect(String(result.note)).toContain("[truncated]");
    });

    it("survives a circular reference instead of recursing forever", () => {
      const circular: Record<string, unknown> = { name: "loop" };
      circular.self = circular;

      const result = redactWebhookPayload(circular);

      expect(result.name).toBe("loop");
      expect(result.self).toBe("[CIRCULAR]");
    });

    it("returns an empty object for null, undefined, or non-object input", () => {
      expect(redactWebhookPayload(null)).toEqual({});
      expect(redactWebhookPayload(undefined)).toEqual({});
    });

    it("does not mutate the caller's payload", () => {
      const original = { secret: "keep-in-caller", amount: 1 };
      redactWebhookPayload(original);

      expect(original.secret).toBe("keep-in-caller");
    });
  });

  describe("redactWebhookPayloadArray", () => {
    it("redacts secrets in each element", () => {
      const result = redactWebhookPayloadArray([
        { password: "a" },
        { password: "b" },
      ]) as Array<Record<string, unknown>>;

      expect(result[0].password).toBe(REDACTED);
      expect(result[1].password).toBe(REDACTED);
    });

    it("caps the number of retained elements", () => {
      const result = redactWebhookPayloadArray(
        Array.from({ length: 200 }, (_, i) => ({ i })),
      );

      expect(result.length).toBeLessThanOrEqual(50);
    });
  });

  describe("redactResponseBody", () => {
    it("returns undefined for absent or blank bodies", () => {
      expect(redactResponseBody(undefined, 100)).toBeUndefined();
      expect(redactResponseBody(null, 100)).toBeUndefined();
      expect(redactResponseBody("", 100)).toBeUndefined();
      expect(redactResponseBody("   ", 100)).toBeUndefined();
    });

    it("strips a secret echoed back by the endpoint", () => {
      const body = '{"ok":true,"api_key":"sk-live-leak"}';

      const result = redactResponseBody(body, 1000);

      expect(result).not.toContain("sk-live-leak");
      expect(result).toContain(REDACTED);
    });

    it.each([
      '{"access_token":"abc123"}',
      '{"refresh_token":"abc123"}',
      '{"password":"abc123"}',
      '{"client_secret":"abc123"}',
      '{"private_key":"abc123"}',
      '{"Authorization":"Bearer abc123"}',
    ])("strips secret shapes in %s", (body) => {
      expect(redactResponseBody(body, 1000)).not.toContain("abc123");
    });

    it("leaves a non-secret body intact", () => {
      expect(redactResponseBody('{"status":"accepted"}', 1000)).toBe(
        '{"status":"accepted"}',
      );
    });

    it("truncates a long body after redaction", () => {
      const body = "x".repeat(5000);

      const result = redactResponseBody(body, 100);

      expect(result?.length).toBeLessThan(200);
      expect(result).toContain("[truncated]");
    });
  });

  describe("redactAccount", () => {
    it("keeps only the leading characters", () => {
      const full =
        "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

      expect(redactAccount(full)).toBe("GAAZI4TC…");
    });

    it("is a no-op for a short value", () => {
      expect(redactAccount("abc")).toBe("abc");
    });
  });
});

