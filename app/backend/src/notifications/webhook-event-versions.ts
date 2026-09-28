/**
 * Versioned webhook event envelope.
 *
 * Every webhook delivery carries an explicit schema version so subscribers can
 * migrate deterministically instead of inferring shape from the payload. The
 * registry below is the single source of truth for:
 *
 *  - the current (and legacy) schema versions of each event type,
 *  - the deprecation/sunset timeline for a version, and
 *  - the migration guidance returned to subscribers still on a legacy version.
 *
 * The envelope is additive: legacy fields keep their names, and later versions
 * only add fields, so a `v1` subscriber never sees a silently dropped field.
 */
import type { NotificationEventType } from "./types/notification.types";

/** Webhook API version negotiated per subscriber (stored on the preference). */
export type WebhookApiVersion = "v1" | "v2";

/** Default version for subscribers that never pinned one. */
export const DEFAULT_WEBHOOK_API_VERSION: WebhookApiVersion = "v1";

/** Newest version QuickEx emits. */
export const LATEST_WEBHOOK_API_VERSION: WebhookApiVersion = "v2";

export const SUPPORTED_WEBHOOK_API_VERSIONS: readonly WebhookApiVersion[] = [
  "v1",
  "v2",
] as const;

export interface WebhookEventVersionDescriptor {
  eventType: NotificationEventType | string;
  /** Current schema version for this event. */
  currentVersion: string;
  /** Schema versions still accepted for this event, oldest first. */
  supportedVersions: string[];
  /** Versions that still work but are scheduled for removal. */
  deprecatedVersions: string[];
  /** ISO-8601 date after which a deprecated version is no longer emitted. */
  sunsetAt?: string;
  /** Human-readable migration steps for a subscriber on a deprecated version. */
  migration?: string;
}


/**
 * Per-event schema versions. Keyed by event type so a new event can ship at a
 * different version from an existing one without a flag day for subscribers.
 */
const EVENT_VERSIONS: Record<string, WebhookEventVersionDescriptor> = {
  "payment.received": {
    eventType: "payment.received",
    currentVersion: "2",
    supportedVersions: ["1", "2"],
    deprecatedVersions: ["1"],
    sunsetAt: "2026-12-31T00:00:00.000Z",
    migration:
      "v2 nests the amount under data.amount.stroops and adds data.assetCode. " +
      "Read data.amount?.stroops ?? data.amountStroops while migrating.",
  },
  EscrowDeposited: {
    eventType: "EscrowDeposited",
    currentVersion: "1",
    supportedVersions: ["1"],
    deprecatedVersions: [],
  },
  EscrowWithdrawn: {
    eventType: "EscrowWithdrawn",
    currentVersion: "1",
    supportedVersions: ["1"],
    deprecatedVersions: [],
  },
  EscrowRefunded: {
    eventType: "EscrowRefunded",
    currentVersion: "1",
    supportedVersions: ["1"],
    deprecatedVersions: [],
  },
  "username.claimed": {
    eventType: "username.claimed",
    currentVersion: "1",
    supportedVersions: ["1"],
    deprecatedVersions: [],
  },
  "payment.link.expired": {
    eventType: "payment.link.expired",
    currentVersion: "1",
    supportedVersions: ["1"],
    deprecatedVersions: [],
  },
};

const FALLBACK_DESCRIPTOR: WebhookEventVersionDescriptor = {
  eventType: "unknown",
  currentVersion: "1",
  supportedVersions: ["1"],
  deprecatedVersions: [],
};

/** Version descriptor for an event type; unknown events fall back to v1. */
export function getEventVersionDescriptor(
  eventType: string,
): WebhookEventVersionDescriptor {
  const descriptor = EVENT_VERSIONS[eventType];
  if (!descriptor) return { ...FALLBACK_DESCRIPTOR, eventType };
  return descriptor;
}

/** True when `version` is a version this event type is allowed to emit. */
export function isSupportedEventVersion(
  eventType: string,
  version: string,
): boolean {
  return getEventVersionDescriptor(eventType).supportedVersions.includes(version);
}

/** True when the version still works but is scheduled for removal. */
export function isDeprecatedEventVersion(
  eventType: string,
  version: string,
): boolean {
  return getEventVersionDescriptor(eventType).deprecatedVersions.includes(version);
}

/** Normalize a subscriber-pinned API version, rejecting unknown values. */
export function normalizeApiVersion(
  requested: string | null | undefined,
): WebhookApiVersion {
  return SUPPORTED_WEBHOOK_API_VERSIONS.includes(requested as WebhookApiVersion)
    ? (requested as WebhookApiVersion)
    : DEFAULT_WEBHOOK_API_VERSION;
}


/** Subscriber-facing migration metadata, safe to log and return over the API. */
export interface WebhookEventMigrationNotice {
  eventType: string;
  deliveredVersion: string;
  currentVersion: string;
  deprecated: boolean;
  sunsetAt?: string;
  migration?: string;
}

/**
 * Build the notice that tells a subscriber their pinned version is behind the
 * current schema. Returns `undefined` when the subscriber is current, so the
 * field is absent from the delivery instead of carrying a no-op object.
 */
export function buildMigrationNotice(
  eventType: string,
  deliveredVersion: string,
): WebhookEventMigrationNotice | undefined {
  const descriptor = getEventVersionDescriptor(eventType);
  if (deliveredVersion === descriptor.currentVersion) return undefined;

  return {
    eventType,
    deliveredVersion,
    currentVersion: descriptor.currentVersion,
    deprecated: isDeprecatedEventVersion(eventType, deliveredVersion),
    sunsetAt: descriptor.sunsetAt,
    migration: descriptor.migration,
  };
}

/** Minimal event shape the envelope is built from. */
export interface WebhookEventEnvelopeInput {
  eventType: string;
  eventId: string;
  occurredAt: string;
  apiVersion: WebhookApiVersion;
  /** Already-rendered, already-redacted event data. */
  data: Record<string, unknown>;
}

export interface WebhookEventEnvelope {
  /** Stable delivery identifier; also used for subscriber-side deduplication. */
  id: string;
  /** Webhook API version this envelope was rendered for. */
  apiVersion: WebhookApiVersion;
  /** Schema version of this specific event type. */
  version: string;
  eventType: string;
  eventId: string;
  occurredAt: string;
  data: Record<string, unknown>;
  /** Present only when the subscriber is behind the current schema. */
  migration?: WebhookEventMigrationNotice;
}

/**
 * Render a versioned event envelope.
 *
 * `id` is deterministic (`{apiVersion}:{eventType}:{eventId}`) so a redelivery
 * or replay of the same event is recognizable as a duplicate by subscribers.
 */
export function buildWebhookEventEnvelope(
  input: WebhookEventEnvelopeInput,
): WebhookEventEnvelope {
  const descriptor = getEventVersionDescriptor(input.eventType);
  const version = descriptor.currentVersion;
  const notice = buildMigrationNotice(input.eventType, version);

  const envelope: WebhookEventEnvelope = {
    id: `${input.apiVersion}:${input.eventType}:${input.eventId}`,
    apiVersion: input.apiVersion,
    version,
    eventType: input.eventType,
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    data: applyVersionProjection(input.data, input.apiVersion, version),
  };

  if (notice) envelope.migration = notice;
  return envelope;
}

/**
 * Project event data onto a schema version.
 *
 * The projection is identity today: versions differ by additive fields and by
 * the migration notice, never by removal, so a subscriber's field access keeps
 * working across versions. Centralising the switch here means a future breaking
 * change has exactly one place to be introduced, covered by this module's tests.
 */
function applyVersionProjection(
  data: Record<string, unknown>,
  _apiVersion: WebhookApiVersion,
  _schemaVersion: string,
): Record<string, unknown> {
  return { ...data };
}

/** Headers a subscriber can rely on for routing and version negotiation. */
export function buildVersionHeaders(
  envelope: WebhookEventEnvelope,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-QuickEx-Event": envelope.eventType,
    "X-QuickEx-Event-Id": envelope.eventId,
    "X-QuickEx-Event-Version": envelope.version,
    "X-QuickEx-Api-Version": envelope.apiVersion,
    "X-QuickEx-Delivery-Id": envelope.id,
    "X-QuickEx-Timestamp": envelope.occurredAt,
  };

  if (envelope.migration?.sunsetAt) {
    headers["X-QuickEx-Event-Sunset-At"] = envelope.migration.sunsetAt;
  }

  return headers;
}
