import { Logger, Inject } from "@nestjs/common";
import * as crypto from "crypto";

import { MetricsService } from "../../metrics/metrics.service";
import {
  buildWebhookEventEnvelope,
  normalizeApiVersion,
} from "../webhook-event-versions";
import {
  redactResponseBody,
  redactWebhookPayload,
} from "../webhook-payload-redaction";
import type {
  NotificationChannel,
  NotificationPreference,
  BaseNotificationPayload,
  WebhookPayload,
} from "../types/notification.types";

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface ProviderSendResult {
  messageId?: string;
  httpStatus?: number;
  responseBody?: string;
}

export interface INotificationProvider {
  readonly channel: NotificationChannel;
  send(
    preference: NotificationPreference,
    payload: BaseNotificationPayload,
  ): Promise<ProviderSendResult>;
}

// ---------------------------------------------------------------------------
// No-op provider for local / development transports
// ---------------------------------------------------------------------------
export class NoopNotificationProvider implements INotificationProvider {
  readonly channel: NotificationChannel;
  private readonly logger = new Logger(NoopNotificationProvider.name);

  constructor(channel: NotificationChannel) {
    this.channel = channel;
  }

  async send(
    preference: NotificationPreference,
    payload: BaseNotificationPayload,
  ): Promise<ProviderSendResult> {
    this.logger.debug(
      `[noop:${this.channel}] simulated notification for ${payload.eventType} to ${preference.publicKey}`,
    );
    return {
      messageId: `noop:${payload.eventId}`,
      httpStatus: 200,
      responseBody: "noop",
    };
  }
}

// ---------------------------------------------------------------------------
// SendGrid email provider
// ---------------------------------------------------------------------------

export class SendGridEmailProvider implements INotificationProvider {
  readonly channel: NotificationChannel = "email";
  private readonly logger = new Logger(SendGridEmailProvider.name);

  constructor(
    private readonly apiKey: string,
    private readonly fromEmail: string,
  ) {}

  async send(
    preference: NotificationPreference,
    payload: BaseNotificationPayload,
  ): Promise<ProviderSendResult> {
    if (!preference.email) {
      throw new Error("No email address configured for preference");
    }

    const body = {
      personalizations: [{ to: [{ email: preference.email }] }],
      from: { email: this.fromEmail },
      subject: payload.title,
      content: [
        {
          type: "text/plain",
          value: payload.body,
        },
        {
          type: "text/html",
          value: this.buildHtml(payload),
        },
      ],
    };

    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`SendGrid error ${response.status}: ${text}`);
    }

    const messageId = response.headers.get("X-Message-Id") ?? undefined;
    this.logger.debug(
      `Email sent to ${preference.email}: messageId=${messageId}`,
    );

    return { messageId };
  }

  private buildHtml(payload: BaseNotificationPayload): string {
    return `
      <h2>${payload.title}</h2>
      <p>${payload.body}</p>
      <hr/>
      <p style="color:#666;font-size:12px">QuickEx · ${payload.occurredAt}</p>
    `.trim();
  }
}

// ---------------------------------------------------------------------------
// Expo Push provider (React Native / mobile)
// ---------------------------------------------------------------------------

export class ExpoPushProvider implements INotificationProvider {
  readonly channel: NotificationChannel = "push";
  private readonly logger = new Logger(ExpoPushProvider.name);

  constructor(private readonly accessToken?: string) {}

  async send(
    preference: NotificationPreference,
    payload: BaseNotificationPayload,
  ): Promise<ProviderSendResult> {
    if (!preference.pushToken) {
      throw new Error("No push token configured for preference");
    }

    const message = {
      to: preference.pushToken,
      title: payload.title,
      body: payload.body,
      data: {
        eventType: payload.eventType,
        eventId: payload.eventId,
        ...(payload.metadata ?? {}),
      },
      sound: "default",
      priority: "high",
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Expo Push error ${response.status}: ${text}`);
    }

    const json = (await response.json()) as { data?: { id?: string } };
    const messageId = json.data?.id;
    this.logger.debug(
      `Push sent to ${preference.pushToken}: messageId=${messageId}`,
    );

    return { messageId };
  }
}

// ---------------------------------------------------------------------------
// Webhook provider
// ---------------------------------------------------------------------------

export class WebhookProvider implements INotificationProvider {
  readonly channel: NotificationChannel = "webhook";
  private readonly logger = new Logger(WebhookProvider.name);
  private readonly maxResponseBodyLength = 1000;

  constructor(
    @Inject(MetricsService) private readonly metrics?: MetricsService,
  ) {}

  async send(
    preference: NotificationPreference,
    payload: BaseNotificationPayload,
  ): Promise<ProviderSendResult> {
    if (!preference.webhookUrl) {
      throw new Error("No webhook URL configured for preference");
    }

    const startTime = Date.now();
    const webhookPayload = this.buildWebhookPayload(payload, preference);
    const body = JSON.stringify(webhookPayload);
    const signature = this.signPayload(body, webhookPayload.sentAt, preference.webhookSecret);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-QuickEx-Signature": signature,
      "X-QuickEx-Delivery-ID": webhookPayload.id,
      "X-QuickEx-Event": payload.eventType,
      "X-QuickEx-Timestamp": webhookPayload.sentAt,
      // Version negotiation headers (issue #275). Subscribers can branch on
      // these without parsing the body, and the sunset header tells a pinned
      // subscriber how long its version keeps working.
      "X-QuickEx-Api-Version": webhookPayload.apiVersion,
      "X-QuickEx-Event-Version": webhookPayload.version,
    };

    if (webhookPayload.migration?.sunsetAt) {
      headers["X-QuickEx-Event-Sunset-At"] = webhookPayload.migration.sunsetAt;
    }

    try {
      const response = await fetch(preference.webhookUrl, {
        method: "POST",
        headers,
        body,
      });

      const duration = (Date.now() - startTime) / 1000;

      let responseBody: string | undefined;
      try {
        const text = await response.text();
        // Redacted before it reaches the delivery log (issue #277): the body
        // originates outside QuickEx and is later readable by the owning tenant.
        responseBody = redactResponseBody(text, this.maxResponseBodyLength);
      } catch {
        // Ignore response body read errors
      }

      if (!response.ok) {
        const error = new Error(
          `Webhook returned HTTP ${response.status} for ${preference.webhookUrl}: ${responseBody ?? "no response body"}`,
        );
        if (this.metrics) {
          this.metrics.recordWebhookDeliveryDuration(payload.eventType, "failed", duration);
          this.metrics.recordError("webhook", "http_error");
        }
        throw error;
      }

      this.logger.debug(
        `Webhook delivered to ${preference.webhookUrl}: status=${response.status}`,
      );

      // A 202 (Accepted) is treated as an explicit receiver ack — the receiver
      // has taken ownership of the event, so retries stop for this delivery.
      if (response.status === 202) {
        this.logger.debug(
          `Webhook receiver acknowledged delivery ${webhookPayload.id} with 202 (retries stopped)`,
        );
      }

      if (this.metrics) {
        this.metrics.recordWebhookDeliveryDuration(payload.eventType, "success", duration);
      }

      return {
        httpStatus: response.status,
        responseBody,
      };
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      const errorType = error instanceof Error ? error.constructor.name : "UnknownError";
      if (this.metrics) {
        this.metrics.recordWebhookDeliveryDuration(payload.eventType, "error", duration);
        this.metrics.recordError("webhook", errorType);
      }
      throw error;
    }
  }

  /**
   * Build the outgoing webhook body.
   *
   * The body is a versioned envelope: the event schema version travels with the
   * payload (issue #275) and the event data is redacted before it leaves the
   * trust boundary (issue #277). Redaction happens here, once, so every caller
   * of the provider gets the same guarantee.
   */
  private buildWebhookPayload(
    payload: BaseNotificationPayload,
    preference: NotificationPreference,
  ): WebhookPayload {
    const apiVersion = normalizeApiVersion(preference.apiVersion);
    const envelope = buildWebhookEventEnvelope({
      eventType: payload.eventType,
      eventId: payload.eventId,
      occurredAt: payload.occurredAt,
      apiVersion,
      data: redactWebhookPayload(payload.metadata ?? {}),
    });

    // Stable delivery ID derived from the event and the pinned API version —
    // retries (and any accidental duplicate pushes) reuse the same ID so
    // receivers can deduplicate via the X-QuickEx-Delivery-ID header, while two
    // subscribers on different versions never collide with each other.
    const deliveryId = `wh_${crypto
      .createHash("sha256")
      .update(`${envelope.apiVersion}.${payload.eventType}.${payload.eventId}.${payload.recipientPublicKey}`)
      .digest("hex")
      .slice(0, 16)}`;

    const webhookPayload: WebhookPayload = {
      id: deliveryId,
      eventType: payload.eventType,
      eventId: payload.eventId,
      apiVersion: envelope.apiVersion,
      version: envelope.version,
      timestamp: payload.occurredAt,
      sentAt: new Date().toISOString(),
      recipientPublicKey: payload.recipientPublicKey,
      title: payload.title,
      body: payload.body,
      data: envelope.data,
    };

    if (envelope.migration) {
      webhookPayload.migration = envelope.migration;
      this.logger.debug(
        `Webhook ${envelope.id} rendered at version ${envelope.version} with migration notice for ${preference.publicKey.slice(0, 8)}...`,
      );
    }

    return webhookPayload;
  }

  private signPayload(body: string, timestamp: string, secret?: string): string {
    if (!secret) {
      this.logger.warn(
        "Webhook secret not configured - payload will not be signed",
      );
      return "";
    }

    // Sign timestamp + "." + body to prevent replay attacks
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(`${timestamp}.${body}`);
    const digest = hmac.digest("hex");
    return `sha256=${digest}`;
  }

  /**
   * Verify an incoming webhook signature.
   * @param body Raw request body string
   * @param signature Value of X-QuickEx-Signature header
   * @param timestamp Value of X-QuickEx-Timestamp header
   * @param secret Shared webhook secret
   * @param toleranceMs Replay window in ms (default 5 minutes)
   */
  static verifySignature(
    body: string,
    signature: string,
    timestamp: string,
    secret: string,
    toleranceMs = 5 * 60 * 1000,
  ): boolean {
    if (!signature.startsWith("sha256=")) {
      return false;
    }

    // Reject stale timestamps to prevent replay attacks
    const ts = new Date(timestamp).getTime();
    if (isNaN(ts) || Math.abs(Date.now() - ts) > toleranceMs) {
      return false;
    }

    const expectedDigest = signature.slice(7);
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(`${timestamp}.${body}`);
    const actualDigest = hmac.digest("hex");

    try {
      return crypto.timingSafeEqual(
        Buffer.from(expectedDigest, "hex"),
        Buffer.from(actualDigest, "hex"),
      );
    } catch {
      return false;
    }
  }

  /**
   * Verify an incoming webhook signature and return a stable reason code,
   * using the exact canonicalization logic as verifySignature/signPayload
   * (sha256=HMAC(secret, "{timestamp}.{body}")).
   */
  static verifySignatureDetailed(
    body: string,
    signature: string,
    timestamp: string,
    secret: string,
    toleranceMs = 5 * 60 * 1000,
  ): WebhookVerificationResult {
    if (!body || !signature || !timestamp || !secret) {
      return { valid: false, reason: "MISSING_FIELDS" };
    }

    if (!signature.startsWith("sha256=")) {
      return { valid: false, reason: "INVALID_SIGNATURE_FORMAT" };
    }

    const ts = new Date(timestamp).getTime();
    if (isNaN(ts)) {
      return { valid: false, reason: "INVALID_TIMESTAMP" };
    }
    if (Math.abs(Date.now() - ts) > toleranceMs) {
      return { valid: false, reason: "TIMESTAMP_OUT_OF_TOLERANCE" };
    }

    const expectedDigest = signature.slice(7);
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(`${timestamp}.${body}`);
    const actualDigest = hmac.digest("hex");

    let matches: boolean;
    try {
      matches = crypto.timingSafeEqual(
        Buffer.from(expectedDigest, "hex"),
        Buffer.from(actualDigest, "hex"),
      );
    } catch {
      matches = false;
    }

    return matches
      ? { valid: true, reason: "VALID" }
      : { valid: false, reason: "SIGNATURE_MISMATCH" };
  }

  /**
   * Verify a signature against a subscriber's current secret, falling back to
   * the retained previous secret while a rotation overlap window is open
   * (issue #277).
   *
   * Rotation is signing-only-on-new: QuickEx always signs with the current
   * secret. The previous secret is accepted for verification for
   * `WEBHOOK_SECRET_ROTATION_GRACE_MS` so a consumer that has not yet
   * redeployed does not reject in-flight deliveries. Once the window closes the
   * previous secret is discarded and verification fails closed.
   */
  static verifySignatureWithRotation(
    body: string,
    signature: string,
    timestamp: string,
    secret: string,
    options: {
      previousSecret?: string;
      previousSecretExpiresAt?: string | null;
      toleranceMs?: number;
      now?: Date;
    } = {},
  ): WebhookVerificationResult {
    const current = WebhookProvider.verifySignatureDetailed(
      body,
      signature,
      timestamp,
      secret,
      options.toleranceMs,
    );
    if (current.valid) return current;

    const { previousSecret, previousSecretExpiresAt } = options;
    if (!previousSecret) return current;

    if (previousSecret === secret) return current;

    const now = options.now ?? new Date();
    if (
      previousSecretExpiresAt &&
      new Date(previousSecretExpiresAt).getTime() <= now.getTime()
    ) {
      return current;
    }

    return WebhookProvider.verifySignatureDetailed(
      body,
      signature,
      timestamp,
      previousSecret,
      options.toleranceMs,
    );
  }
}

export type WebhookVerificationReason =
  | "VALID"
  | "MISSING_FIELDS"
  | "INVALID_SIGNATURE_FORMAT"
  | "INVALID_TIMESTAMP"
  | "TIMESTAMP_OUT_OF_TOLERANCE"
  | "SIGNATURE_MISMATCH";

export interface WebhookVerificationResult {
  valid: boolean;
  reason: WebhookVerificationReason;
}

// ---------------------------------------------------------------------------
// Token for DI
// ---------------------------------------------------------------------------

export const NOTIFICATION_PROVIDERS = Symbol("NOTIFICATION_PROVIDERS");
