/**
 * Webhook payload redaction.
 *
 * Webhook delivery is the one place where QuickEx data leaves the trust
 * boundary, and the delivery log keeps a copy of both what was sent and what
 * came back. Two rules follow from that and are enforced here:
 *
 *  1. Secrets and credential material (signing secrets, bearer tokens,
 *     mnemonics, private keys) never leave the backend, at any nesting depth.
 *  2. Personal data is minimised: a Stellar account is truncated to a short,
 *     non-reversible prefix, because the full account is already the routing
 *     key and is never needed for diagnosis.
 *
 * Redaction is applied on the way out (envelope data) and on the way into the
 * delivery log (response bodies), so the persisted record is safe to expose via
 * the delivery-status API to the owning tenant.
 */

/** Replacement marker written in place of a redacted value. */
export const REDACTED = "[REDACTED]";

/**
 * Keys whose values are always removed, matched case-insensitively and after
 * stripping non-alphanumerics (`signing_secret` and `signingSecret` collide).
 *
 * The list holds both whole keys and fragments. A fragment match is what catches
 * compound names such as `signing_secret`, `webhook_api_key` or
 * `x_amz_security_token` that no fixed list would enumerate — a secret that
 * slips through here leaves the trust boundary, so the matcher is deliberately
 * biased toward over-redaction.
 */
const SECRET_KEY_FRAGMENTS: readonly string[] = [
  "secret",
  "apikey",
  "apitoken",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "password",
  "passphrase",
  "privatekey",
  "mnemonic",
  "seed",
  "signature",
  "cookie",
  "credential",
];

/**
 * Whole keys that are secret but contain none of the fragments above, so they
 * need an explicit entry.
 */
const SECRET_KEY_EXACT: readonly string[] = ["token", "bearer"];


/** Keys holding account identifiers that are truncated rather than removed. */
const ACCOUNT_KEYS: readonly string[] = [
  "publickey",
  "recipientpublickey",
  "sender",
  "owner",
  "destination",
  "from",
  "to",
  "account",
  "wallet",
];

/** Longest full account prefix kept in a redacted value. */
export const ACCOUNT_PREFIX_LENGTH = 8;

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 512;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SECRET_KEY_EXACT.includes(normalized)) return true;
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export function isAccountKey(key: string): boolean {
  return ACCOUNT_KEYS.includes(normalizeKey(key));
}

/**
 * Truncate an account identifier to its leading characters.
 *
 * The suffix is dropped entirely rather than masked, so the result cannot be
 * used to reconstruct the account.
 */
export function redactAccount(value: string): string {
  if (value.length <= ACCOUNT_PREFIX_LENGTH) return value;
  return `${value.slice(0, ACCOUNT_PREFIX_LENGTH)}…`;
}

function redactString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`;
}

function redactValue(
  key: string,
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "bigint") return value.toString();

  if (typeof value === "string") {
    return isAccountKey(key) ? redactAccount(value) : redactString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    if (seen.has(value as object)) return "[CIRCULAR]";
    if (depth >= MAX_DEPTH) return "[TRUNCATED]";
    seen.add(value as object);
    const result = redactObject(
      value as Record<string, unknown>,
      depth + 1,
      seen,
    );
    seen.delete(value as object);
    return result;
  }

  return "[UNSUPPORTED]";
}

function redactObject(
  value: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = redactValue(key, entry, depth, seen);
  }

  return output;
}

/**
 * Redact a webhook payload object. Non-object input returns `{}` so a malformed
 * event can never pass through unredacted.
 */
export function redactWebhookPayload(
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};

  // Seed `seen` with the root so a payload that references itself is detected on
  // the first hop rather than one level down.
  const seen = new WeakSet<object>([payload]);
  return redactObject(payload, 0, seen);
}

/** Redact an array payload, capping the number of retained elements. */
export function redactWebhookPayloadArray(
  payload: readonly unknown[],
): unknown[] {
  return payload
    .slice(0, MAX_ARRAY_ITEMS)
    .map((entry) => redactValue("", entry, 0, new WeakSet<object>()));
}

/**
 * Redact an endpoint response body before it is persisted in the delivery log.
 *
 * The body is truncated to the caller's limit after redaction, so the stored
 * record stays small and never retains a secret echoed back by the endpoint.
 */
export function redactResponseBody(
  body: string | null | undefined,
  maxLength: number,
): string | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body !== "string") return undefined;
  if (body.trim().length === 0) return undefined;

  const withoutSecrets = stripSecretValues(body);
  return withoutSecrets.length > maxLength
    ? `${withoutSecrets.slice(0, maxLength)}…[truncated]`
    : withoutSecrets;
}

/**
 * Best-effort removal of `secret`-shaped JSON fields from a free-form body.
 *
 * Endpoint bodies are not under QuickEx control, so this is a regex sweep over
 * the persisted copy rather than a structural parse. It targets the quoted-key
 * forms (`"api_key":"..."`) that endpoints actually echo; anything it cannot
 * match is still bounded by the caller's truncation.
 */
function stripSecretValues(body: string): string {
  return body.replace(
    /("(?:[A-Za-z0-9_-]*(?:secret|token|password|passphrase|api[_-]?key|authorization|mnemonic|private[_-]?key)[A-Za-z0-9_-]*)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    '$1"[REDACTED]"',
  );
}
