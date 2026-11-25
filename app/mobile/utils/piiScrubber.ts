/**
 * PII scrubber for mobile telemetry and log payloads.
 *
 * Redaction categories are aligned with the published field-level privacy and
 * retention reference (see docs/privacy/field-inventory.md). The inventory is
 * the source of truth for which fields are retained, why, and for how long.
 *
 * Categories scrubbed here (all are treated as "not retained server-side" once
 * scrubbed — the placeholder token is what leaves the device):
 *   - email        -> [EMAIL]
 *   - phone        -> [PHONE]
 *   - ssn          -> [SSN]
 *   - card         -> [CARD]
 *
 * Device-local fields (never sent to the server, so never scrubbed here):
 *   - contact list / address book entries
 *   - device identifiers used only for local keychain scoping
 *   - draft profile edits that have not been submitted
 * These are documented in the inventory as "device-local, not retained
 * server-side" and must not be added to telemetry payloads.
 *
 * Unknown or newly added fields are NOT assumed absent: callers should route
 * any field not listed in the inventory through `scrubPii` and flag it for
 * review (see `flagUnknownField`).
 */

export type PiiCategory = 'email' | 'phone' | 'ssn' | 'card';

export interface FieldInventoryEntry {
  /** Field name as it appears in storage or logs. */
  field: string;
  /** Data category from the privacy inventory. */
  category: PiiCategory | 'device-local' | 'unknown';
  /** Whether the field is retained server-side after scrubbing. */
  retainedServerSide: boolean;
}

/**
 * Minimal in-code mirror of the published inventory for the fields this
 * scrubber is expected to encounter. Keep in sync with
 * docs/privacy/field-inventory.md.
 */
export const FIELD_INVENTORY: ReadonlyArray<FieldInventoryEntry> = [
  { field: 'profile.email', category: 'email', retainedServerSide: false },
  { field: 'profile.phone', category: 'phone', retainedServerSide: false },
  { field: 'payment.cardNumber', category: 'card', retainedServerSide: false },
  { field: 'identity.ssn', category: 'ssn', retainedServerSide: false },
  { field: 'contacts.addressBook', category: 'device-local', retainedServerSide: false },
  { field: 'device.localKeychainScope', category: 'device-local', retainedServerSide: false },
  { field: 'profile.draftEdits', category: 'device-local', retainedServerSide: false },
];

const INVENTORY_BY_FIELD = new Map<string, FieldInventoryEntry>(
  FIELD_INVENTORY.map((entry) => [entry.field, entry]),
);

/**
 * Look up a field in the inventory. Unknown fields are returned with
 * category 'unknown' and retainedServerSide true so callers treat them as
 * needing review rather than assuming they are absent.
 */
export function lookupField(field: string): FieldInventoryEntry {
  const known = INVENTORY_BY_FIELD.get(field);
  if (known) return known;
  return { field, category: 'unknown', retainedServerSide: true };
}

/**
 * Returns true when a field is not covered by the inventory and should be
 * flagged for review before being added to storage or logs.
 */
export function flagUnknownField(field: string): boolean {
  return lookupField(field).category === 'unknown';
}

export function scrubPii(text: string): string {
  if (!text) return text;

  // Basic email redaction
  let scrubbed = text.replace(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi, '[EMAIL]');

  // Basic phone redaction (e.g., +1-555-555-5555 or (555) 555-5555)
  scrubbed = scrubbed.replace(/(\+\d{1,3}[\s-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '[PHONE]');

  // Basic SSN redaction
  scrubbed = scrubbed.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]');

  // Credit Card redaction
  scrubbed = scrubbed.replace(/\b(?:\d{4}[ -]?){3}\d{4}\b/g, '[CARD]');

  return scrubbed;
}