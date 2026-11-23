export interface AuditLog {
  id: string;
  actor: string;
  action: string;
  target?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
  createdAt: Date;
}

export interface QueryAuditLogsDto {
  action?: string;
  actor?: string;
  startTime?: string;
  endTime?: string;
  page?: number;
  limit?: number;
}

/**
 * Enriched audit entry recorded for feature-flag changes (issue #26).
 * Stored in `metadata` of the parent AuditLog under key `flagAuditEntry`.
 */
export interface FlagAuditEntry {
  /** Feature flag key that was changed. */
  flagKey: string;
  /** Full flag record before the change. */
  previousValue: unknown;
  /** Full flag record after the change. */
  newValue: unknown;
  /** Identity of the actor who made the change (API key id, fallback to X-Admin-Actor header). */
  actor: string;
  /** Client IP address. */
  ip: string | undefined;
  /** User-Agent header. */
  userAgent: string | undefined;
}

/**
 * Structured audit metadata recorded for idempotent background-job enqueue
 * decisions (issue #639).
 *
 * Stored in `metadata` of the parent AuditLog under key `jobEnqueueDecision`.
 * Captures both the dedupe inputs (operation, resource, parameter hash) and the
 * outcome (which job run was used and whether an existing run was reused), so
 * that dedupe decisions are auditable and different parameters are never
 * silently conflated.
 */
export interface JobEnqueueDecisionAuditEntry {
  /** Background-job operation that was requested (e.g. `reconcile`, `cleanup`). */
  operation: string;
  /** Resource the operation targets (e.g. a tenant, account, or entity id). */
  resource: string;
  /**
   * Stable hash of the normalized request parameters. Two requests with the
   * same operation/resource but different parameters produce different hashes
   * and are therefore not conflated.
   */
  parameterHash: string;
  /** Identifier of the background-job run associated with the decision. */
  jobId: string;
  /**
   * `true` when an existing active run was returned instead of starting a new
   * one; `false` when a new run was enqueued.
   */
  reused: boolean;
}