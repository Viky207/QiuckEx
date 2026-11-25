export const API_KEY_SCOPES = [
  'links:read',
  'links:write',
  'transactions:read',
  'usernames:read',
  'refunds:write',
  'support:read',
  'support:write',
  'admin', // Admin scope for job queue management and other admin operations
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ApiKeyRecord {
  id: string;
  name: string;
  key_hash: string;
  key_hash_old: string | null;
  key_prefix: string;
  scopes: ApiKeyScope[];
  owner_id: string | null;
  organization_id: string | null;
  is_active: boolean;
  request_count: number;
  monthly_quota: number;
  last_used_at: string | null;
  rotated_at: string | null;
  last_reset_at: string;
  created_at: string;
  updated_at: string;
}

export interface ApiKeyPublic {
  id: string;
  name: string;
  key_prefix: string;
  scopes: ApiKeyScope[];
  is_active: boolean;
  request_count: number;
  monthly_quota: number;
  last_used_at: string | null;
  created_at: string;
}

/** Returned once at creation / rotation — contains the raw key. */
export interface ApiKeyCreated extends ApiKeyPublic {
  key: string;
}

/**
 * Outcome of an attempted API-key scope mutation, as recorded in audit metadata.
 * `denied` / `failed` outcomes make unsuccessful attempts distinguishable from
 * successful ones without exposing any secret material.
 */
export type ScopeChangeOutcome = 'success' | 'denied' | 'failed';

/**
 * Secret-free audit metadata for API-key scope changes.
 *
 * Identifies the actor and the affected key record (by id, never by secret or
 * hash) and captures the before/after scope state so scope mutations are
 * auditable. Must not contain raw keys, key hashes, or signing material.
 */
export interface ScopeChangeAuditMetadata {
  /** Identifier of the actor performing (or attempting) the change. */
  actorId: string;
  /** Identifier of the API-key record whose scopes are being changed. */
  keyId: string;
  /** Scopes present on the key before the attempted change. */
  beforeScopes: ApiKeyScope[];
  /** Scopes requested/present after the attempted change. */
  afterScopes: ApiKeyScope[];
  /** Whether the mutation succeeded, was denied, or otherwise failed. */
  outcome: ScopeChangeOutcome;
}
</｜｜DSML｜｜ parameter>