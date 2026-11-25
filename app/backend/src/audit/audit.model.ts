/**
 * Field-level privacy and retention classification (issue #579).
 *
 * Every persisted or logged field must carry a classification so the field
 * inventory can link data categories to purpose, retention policy, and
 * deletion behavior. Fields that cannot yet be classified must be marked
 * `reviewStatus: 'needs-review'` rather than assumed absent.
 */
export interface FieldClassification {
  /** Data category (e.g. `identity`, `operational`, `technical`). */
  dataCategory: string;
  /** Why the field is collected/stored. */
  purpose: string;
  /** Retention policy applied to the field. */
  retention: string;
  /** How the field is removed or anonymized on deletion. */
  deletionBehavior: string;
  /**
   * `classified` when the entry has been reviewed; `needs-review` when the
   * field is unknown/unclassified and must be flagged for review.
   */
  reviewStatus: 'classified' | 'needs-review';
}

/**
 * Field inventory for audit records (issue #579).
 *
 * Keys mirror the persisted/logged fields of `AuditLog` and its nested
 * metadata entries. Unknown fields are flagged `needs-review` instead of
 * being assumed absent.
 */
export const AUDIT_FIELD_INVENTORY: Record<string, FieldClassification> = {
  id: {
    dataCategory: 'operational',
    purpose: 'Uniquely identify an audit record for retrieval and correlation.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
  actor: {
    dataCategory: 'identity',
    purpose: 'Attribute an audited action to the responsible principal.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Pseudonymized on subject deletion; record retained for accountability.',
    reviewStatus: 'classified',
  },
  action: {
    dataCategory: 'operational',
    purpose: 'Describe what operation was performed.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
  target: {
    dataCategory: 'operational',
    purpose: 'Identify the resource affected by the action.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
  metadata: {
    dataCategory: 'operational',
    purpose: 'Structured context for the audited action (see nested entries).',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record; nested entries follow their own classification.',
    reviewStatus: 'classified',
  },
  requestId: {
    dataCategory: 'technical',
    purpose: 'Correlate the audit record with request traces for debugging.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
  createdAt: {
    dataCategory: 'operational',
    purpose: 'Record when the audited action occurred.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
  flagAuditEntry: {
    dataCategory: 'operational',
    purpose: 'Audit feature-flag changes including before/after values and actor.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
  jobEnqueueDecision: {
    dataCategory: 'operational',
    purpose: 'Audit idempotent background-job enqueue decisions and dedupe inputs.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
};

/**
 * Returns the classification for a field, flagging unknown fields for review
 * instead of assuming they are absent.
 */
export function classifyAuditField(field: string): FieldClassification {
  return (
    AUDIT_FIELD_INVENTORY[field] ?? {
      dataCategory: 'unknown',
      purpose: 'Unclassified field; flagged for review.',
      retention: 'Unknown; flagged for review.',
      deletionBehavior: 'Unknown; flagged for review.',
      reviewStatus: 'needs-review',
    }
  );
}

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
 * Field inventory for `FlagAuditEntry` (issue #579).
 */
export const FLAG_AUDIT_FIELD_INVENTORY: Record<string, FieldClassification> = {
  flagKey: {
    dataCategory: 'operational',
    purpose: 'Identify which feature flag changed.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
  previousValue: {
    dataCategory: 'operational',
    purpose: 'Preserve the flag state before the change for accountability.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
  newValue: {
    dataCategory: 'operational',
    purpose: 'Preserve the flag state after the change for accountability.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
  actor: {
    dataCategory: 'identity',
    purpose: 'Attribute the flag change to the responsible principal.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Pseudonymized on subject deletion; record retained for accountability.',
    reviewStatus: 'classified',
  },
  ip: {
    dataCategory: 'technical',
    purpose: 'Record the client IP for security auditing of admin actions.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
  userAgent: {
    dataCategory: 'technical',
    purpose: 'Record the client user-agent for security auditing of admin actions.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
};

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

/**
 * Field inventory for `JobEnqueueDecisionAuditEntry` (issue #579).
 */
export const JOB_ENQUEUE_DECISION_FIELD_INVENTORY: Record<string, FieldClassification> = {
  operation: {
    dataCategory: 'operational',
    purpose: 'Identify the requested background-job operation.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
  resource: {
    dataCategory: 'operational',
    purpose: 'Identify the resource targeted by the operation.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
  parameterHash: {
    dataCategory: 'technical',
    purpose: 'Dedupe requests by normalized parameters without storing raw parameters.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
  jobId: {
    dataCategory: 'operational',
    purpose: 'Correlate the decision with the background-job run.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
  reused: {
    dataCategory: 'operational',
    purpose: 'Record whether an existing run was reused or a new one enqueued.',
    retention: 'Retained for the audit log retention window.',
    deletionBehavior: 'Deleted with the parent audit record.',
    reviewStatus: 'classified',
  },
};