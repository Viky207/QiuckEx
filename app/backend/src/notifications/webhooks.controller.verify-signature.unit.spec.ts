import * as crypto from "crypto";

import { WebhooksController } from "./webhooks.controller";
import { WebhookService } from "./webhook.service";
import { WebhookProvider } from "./providers/notification-provider.interface";

function sign(body: string, timestamp: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(`${timestamp}.${body}`);
  return `sha256=${hmac.digest("hex")}`;
}

/**
 * Issue #277: secret rotation must not break in-flight deliveries, and the
 * overlap window must close on schedule.
 */
describe("WebhookProvider#verifySignatureWithRotation", () => {
  const body = JSON.stringify({ eventType: "payment.received" });
  const currentSecret = "whsec_current";
  const previousSecret = "whsec_previous";

  it("accepts a signature made with the current secret", () => {
    const timestamp = new Date().toISOString();

    const result = WebhookProvider.verifySignatureWithRotation(
      body,
      sign(body, timestamp, currentSecret),
      timestamp,
      currentSecret,
      { previousSecret },
    );

    expect(result).toEqual({ valid: true, reason: "VALID" });
  });

  it("accepts the previous secret during the overlap window", () => {
    const timestamp = new Date().toISOString();

    const result = WebhookProvider.verifySignatureWithRotation(
      body,
      sign(body, timestamp, previousSecret),
      timestamp,
      currentSecret,
      {
        previousSecret,
        previousSecretExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    );

    expect(result).toEqual({ valid: true, reason: "VALID" });
  });

  it("rejects the previous secret once the window has closed", () => {
    const timestamp = new Date().toISOString();

    const result = WebhookProvider.verifySignatureWithRotation(
      body,
      sign(body, timestamp, previousSecret),
      timestamp,
      currentSecret,
      {
        previousSecret,
        previousSecretExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
    );

    expect(result).toEqual({
      valid: false,
      reason: "SIGNATURE_MISMATCH",
    });
  });

  it("rejects the previous secret when no overlap was granted", () => {
    const timestamp = new Date().toISOString();

    const result = WebhookProvider.verifySignatureWithRotation(
      body,
      sign(body, timestamp, previousSecret),
      timestamp,
      currentSecret,
    );

    expect(result.valid).toBe(false);
  });

  it("rejects an unrelated secret even inside the overlap window", () => {
    const timestamp = new Date().toISOString();

    const result = WebhookProvider.verifySignatureWithRotation(
      body,
      sign(body, timestamp, "whsec_attacker"),
      timestamp,
      currentSecret,
      {
        previousSecret,
        previousSecretExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    );

    expect(result.valid).toBe(false);
  });

  it("still enforces the replay tolerance on the previous secret", () => {
    const staleTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const result = WebhookProvider.verifySignatureWithRotation(
      body,
      sign(body, staleTimestamp, previousSecret),
      staleTimestamp,
      currentSecret,
      {
        previousSecret,
        previousSecretExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    );

    expect(result).toEqual({
      valid: false,
      reason: "TIMESTAMP_OUT_OF_TOLERANCE",
    });
  });

  it("ignores a previous secret identical to the current one", () => {
    const timestamp = new Date().toISOString();

    const result = WebhookProvider.verifySignatureWithRotation(
      body,
      sign(body, timestamp, "whsec_third_party"),
      timestamp,
      currentSecret,
      { previousSecret: currentSecret },
    );

    expect(result.valid).toBe(false);
  });
});

describe("WebhooksController#verifySignature", () => {
  const controller = new WebhooksController({} as WebhookService);

  it("returns valid: true for a correctly signed payload", () => {
    const payload = JSON.stringify({ eventType: "payment.received" });
    const timestamp = new Date().toISOString();
    const secret = "whsec_test";
    const signature = sign(payload, timestamp, secret);

    const result = controller.verifySignature({ payload, signature, timestamp, secret });

    expect(result).toEqual({ valid: true, reason: "VALID" });
  });

  it("returns a SIGNATURE_MISMATCH reason code for the wrong secret", () => {
    const payload = JSON.stringify({ eventType: "payment.received" });
    const timestamp = new Date().toISOString();
    const signature = sign(payload, timestamp, "wrong-secret");

    const result = controller.verifySignature({
      payload,
      signature,
      timestamp,
      secret: "whsec_test",
    });

    expect(result).toEqual({ valid: false, reason: "SIGNATURE_MISMATCH" });
  });

  it("returns a TIMESTAMP_OUT_OF_TOLERANCE reason code for a stale timestamp", () => {
    const payload = JSON.stringify({ eventType: "payment.received" });
    const secret = "whsec_test";
    const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const signature = sign(payload, staleTimestamp, secret);

    const result = controller.verifySignature({
      payload,
      signature,
      timestamp: staleTimestamp,
      secret,
    });

    expect(result).toEqual({ valid: false, reason: "TIMESTAMP_OUT_OF_TOLERANCE" });
  });
});
