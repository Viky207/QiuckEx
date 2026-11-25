import { BranchPreviewEnvironment } from './branch-preview.model';
import { PreviewExpiryThresholds } from './branch-preview-expiry.config';

export type PreviewAutoExpiryReason = 'ttl_expired' | 'inactivity' | 'max_age';

export interface PreviewExpiryEvaluation {
  shouldExpire: boolean;
  reason?: PreviewAutoExpiryReason;
}

function effectiveLastActivity(preview: BranchPreviewEnvironment): Date {
  return preview.lastActivityAt ?? preview.updatedAt;
}

/**
 * Determines whether an active preview should be auto-expired.
 * Shared and explicitly exempt environments are never expired by the worker.
 */
export function evaluatePreviewAutoExpiry(
  preview: BranchPreviewEnvironment,
  thresholds: PreviewExpiryThresholds,
  now: Date,
): PreviewExpiryEvaluation {
  if (!preview.isActive) {
    return { shouldExpire: false };
  }

  if (preview.expiryExempt || preview.isShared) {
    return { shouldExpire: false };
  }

  const nowMs = now.getTime();

  if (preview.expiresAt && nowMs >= preview.expiresAt.getTime()) {
    return { shouldExpire: true, reason: 'ttl_expired' };
  }

  const inactiveForMs = nowMs - effectiveLastActivity(preview).getTime();
  if (inactiveForMs >= thresholds.inactivityMs) {
    return { shouldExpire: true, reason: 'inactivity' };
  }

  const ageMs = nowMs - preview.createdAt.getTime();
  if (ageMs >= thresholds.maxAgeMs) {
    return { shouldExpire: true, reason: 'max_age' };
  }

  return { shouldExpire: false };
}

/**
 * Ownership metadata expected on every preview resource. Used by the scheduled
 * cleanup job to ensure it only deletes resources it actually owns.
 */
export interface PreviewOwnershipMetadata {
  previewId: string;
  pullRequestNumber: number;
  environmentTag: string;
}

export type PreviewCleanupSkipReason =
  | 'not_active'
  | 'expiry_exempt'
  | 'shared'
  | 'not_expired'
  | 'missing_ownership_metadata';

export interface PreviewCleanupEligibility {
  eligible: boolean;
  /** Reason the preview was expired, when eligible. */
  reason?: PreviewAutoExpiryReason;
  /** Reason the preview was skipped, when not eligible. */
  skipReason?: PreviewCleanupSkipReason;
  /** Ownership metadata used for deletion, when eligible. */
  metadata?: PreviewOwnershipMetadata;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Extracts the expected ownership metadata from a preview, or returns null if
 * any required field is missing/invalid. Never includes secrets.
 */
export function extractPreviewOwnershipMetadata(
  preview: BranchPreviewEnvironment,
): PreviewOwnershipMetadata | null {
  const previewId = (preview as { id?: unknown }).id;
  const pullRequestNumber = (preview as { pullRequestNumber?: unknown }).pullRequestNumber;
  const environmentTag = (preview as { environmentTag?: unknown }).environmentTag;

  if (!isNonEmptyString(previewId)) {
    return null;
  }
  if (
    typeof pullRequestNumber !== 'number' ||
    !Number.isFinite(pullRequestNumber) ||
    !Number.isInteger(pullRequestNumber) ||
    pullRequestNumber <= 0
  ) {
    return null;
  }
  if (!isNonEmptyString(environmentTag)) {
    return null;
  }

  return {
    previewId,
    pullRequestNumber,
    environmentTag,
  };
}

/**
 * Decides whether a preview is eligible for scheduled cleanup.
 *
 * A preview is eligible only when it is expired per the existing auto-expiry
 * policy AND it carries the expected ownership metadata. This keeps the
 * scheduled job idempotent and prevents deleting resources that do not belong
 * to a preview (or that are missing ownership markers).
 */
export function evaluatePreviewCleanupEligibility(
  preview: BranchPreviewEnvironment,
  thresholds: PreviewExpiryThresholds,
  now: Date,
): PreviewCleanupEligibility {
  if (!preview.isActive) {
    return { eligible: false, skipReason: 'not_active' };
  }

  if (preview.expiryExempt) {
    return { eligible: false, skipReason: 'expiry_exempt' };
  }

  if (preview.isShared) {
    return { eligible: false, skipReason: 'shared' };
  }

  const expiry = evaluatePreviewAutoExpiry(preview, thresholds, now);
  if (!expiry.shouldExpire || !expiry.reason) {
    return { eligible: false, skipReason: 'not_expired' };
  }

  const metadata = extractPreviewOwnershipMetadata(preview);
  if (!metadata) {
    return { eligible: false, skipReason: 'missing_ownership_metadata' };
  }

  return {
    eligible: true,
    reason: expiry.reason,
    metadata,
  };
}