const DAY_MS = 24 * 60 * 60 * 1000;

/** Default inactivity window before a contributor preview is considered stale. */
export const DEFAULT_PREVIEW_INACTIVITY_THRESHOLD_MS = 3 * DAY_MS;

/** Default maximum lifetime for ephemeral contributor previews. */
export const DEFAULT_PREVIEW_MAX_AGE_MS = 14 * DAY_MS;

/** Default cron expression for the scheduled stale-preview cleanup (daily at 03:00 UTC). */
export const DEFAULT_PREVIEW_CLEANUP_CRON = '0 3 * * *';

/**
 * Metadata key/tag used to mark resources as owned by a branch preview.
 * Cleanup only deletes resources carrying this ownership metadata.
 */
export const PREVIEW_OWNERSHIP_METADATA_KEY = 'preview-ownership';

/** Expected value prefix for preview ownership metadata. */
export const PREVIEW_OWNERSHIP_METADATA_PREFIX = 'branch-preview:';

export interface PreviewExpiryThresholds {
  inactivityMs: number;
  maxAgeMs: number;
}

export interface PreviewCleanupConfig extends PreviewExpiryThresholds {
  cronExpression: string;
  ownershipMetadataKey: string;
}

export function resolvePreviewExpiryThresholds(
  env: NodeJS.ProcessEnv = process.env,
): PreviewExpiryThresholds {
  const inactivityRaw = env.PREVIEW_INACTIVITY_THRESHOLD_MS;
  const maxAgeRaw = env.PREVIEW_MAX_AGE_MS;

  const inactivityMs =
    inactivityRaw !== undefined && inactivityRaw !== ''
      ? Number(inactivityRaw)
      : DEFAULT_PREVIEW_INACTIVITY_THRESHOLD_MS;
  const maxAgeMs =
    maxAgeRaw !== undefined && maxAgeRaw !== ''
      ? Number(maxAgeRaw)
      : DEFAULT_PREVIEW_MAX_AGE_MS;

  if (!Number.isFinite(inactivityMs) || inactivityMs < 0) {
    throw new Error('PREVIEW_INACTIVITY_THRESHOLD_MS must be a non-negative number');
  }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new Error('PREVIEW_MAX_AGE_MS must be a non-negative number');
  }

  return { inactivityMs, maxAgeMs };
}

/**
 * Validates a cron expression. Supports the standard 5-field cron format
 * (minute hour day-of-month month day-of-week) with basic field validation.
 */
export function isValidCronExpression(expression: string): boolean {
  if (typeof expression !== 'string') {
    return false;
  }
  const trimmed = expression.trim();
  if (trimmed === '') {
    return false;
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return false;
  }
  const fieldPattern = /^[0-9*/,\-]+$/;
  return fields.every((field) => fieldPattern.test(field));
}

export function resolvePreviewCleanupConfig(
  env: NodeJS.ProcessEnv = process.env,
): PreviewCleanupConfig {
  const thresholds = resolvePreviewExpiryThresholds(env);

  const cronRaw = env.PREVIEW_CLEANUP_CRON;
  const cronExpression =
    cronRaw !== undefined && cronRaw.trim() !== ''
      ? cronRaw.trim()
      : DEFAULT_PREVIEW_CLEANUP_CRON;

  if (!isValidCronExpression(cronExpression)) {
    throw new Error('PREVIEW_CLEANUP_CRON must be a valid 5-field cron expression');
  }

  return {
    ...thresholds,
    cronExpression,
    ownershipMetadataKey: PREVIEW_OWNERSHIP_METADATA_KEY,
  };
}

export const PREVIEW_AUTO_EXPIRY_WORKER_ACTOR = 'system:preview-auto-expiry-worker';
export const BRANCH_PREVIEW_AUTO_EXPIRED_EVENT = 'branch.preview.auto_expired';