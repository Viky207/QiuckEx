/**
 * Crash report data structure
 *
 * Field-level privacy and retention annotations (see docs/privacy/field-inventory.md):
 * - `id`: identifier; retained with the crash report; deleted on report deletion.
 * - `userId`: identifier (personal data); retained with the crash report; deleted on report deletion.
 * - `error`: diagnostic data; retained with the crash report; deleted on report deletion.
 * - `context`: diagnostic data (may contain personal data); retained with the crash report; deleted on report deletion.
 * - `logLines`: diagnostic data (may contain personal data); retained with the crash report; deleted on report deletion.
 * - `timestamp`: diagnostic metadata; retained with the crash report; deleted on report deletion.
 * - `createdAt`: operational metadata; retained with the crash report; deleted on report deletion.
 */
export interface CrashReport {
  id: string;
  userId?: string;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
  context?: Record<string, unknown>;
  logLines: string[];
  timestamp: Date;
  createdAt: Date;
}

/**
 * User settings for crash reporting
 *
 * Field-level privacy and retention annotations (see docs/privacy/field-inventory.md):
 * - `userId`: identifier (personal data); retained while the setting exists; deleted on user deletion.
 * - `crashReportingEnabled`: preference; retained while the setting exists; deleted on user deletion.
 * - `updatedAt`: operational metadata; retained while the setting exists; deleted on user deletion.
 */
export interface CrashReportingSettings {
  userId: string;
  crashReportingEnabled: boolean;
  updatedAt: Date;
}

/**
 * Log export data structure
 *
 * Field-level privacy and retention annotations (see docs/privacy/field-inventory.md):
 * - `userId`: identifier (personal data); present only in the export payload; not persisted by the export itself.
 * - `exportedAt`: operational metadata; present only in the export payload; not persisted by the export itself.
 * - `currentLogs`: diagnostic data (may contain personal data); present only in the export payload; not persisted by the export itself.
 * - `crashReports`: diagnostic data; present only in the export payload; not persisted by the export itself.
 */
export interface LogExport {
  userId: string;
  exportedAt: Date;
  currentLogs: string[];
  crashReports: Array<{
    id: string;
    timestamp: Date;
    error: {
      name: string;
      message: string;
      stack?: string;
    };
    context?: Record<string, unknown>;
    logLines: string[];
  }>;
}

/**
 * Data category used by the field-level privacy and retention inventory.
 */
export type DataCategory =
  | 'identifier'
  | 'preference'
  | 'diagnostic'
  | 'operational-metadata'
  | 'unclassified';

/**
 * Retention/deletion behavior used by the field-level privacy and retention inventory.
 */
export type RetentionBehavior =
  | 'retained-with-record'
  | 'retained-while-setting-exists'
  | 'export-payload-only'
  | 'unknown';

/**
 * Inventory entry describing a single field's privacy and retention behavior.
 */
export interface FieldInventoryEntry {
  /** Dotted path to the field, e.g. `CrashReport.error.stack`. */
  field: string;
  category: DataCategory;
  retention: RetentionBehavior;
  /** Human-readable purpose for collecting/retaining the field. */
  purpose: string;
  /** Deletion behavior description. */
  deletion: string;
  /** True when the field has not been classified and needs review. */
  needsReview: boolean;
}

/**
 * Field inventory derived from the crash-reporting types.
 *
 * Unknown fields are flagged (`needsReview: true`, category `unclassified`) rather than
 * assumed absent, so the inventory can be validated against the code.
 */
export const CRASH_REPORTING_FIELD_INVENTORY: readonly FieldInventoryEntry[] = [
  {
    field: 'CrashReport.id',
    category: 'identifier',
    retention: 'retained-with-record',
    purpose: 'Identify a crash report for support and deletion requests.',
    deletion: 'Deleted when the crash report is deleted.',
    needsReview: false,
  },
  {
    field: 'CrashReport.userId',
    category: 'identifier',
    retention: 'retained-with-record',
    purpose: 'Associate a crash report with the reporting user.',
    deletion: 'Deleted when the crash report is deleted.',
    needsReview: false,
  },
  {
    field: 'CrashReport.error',
    category: 'diagnostic',
    retention: 'retained-with-record',
    purpose: 'Diagnose the reported failure.',
    deletion: 'Deleted when the crash report is deleted.',
    needsReview: false,
  },
  {
    field: 'CrashReport.context',
    category: 'diagnostic',
    retention: 'retained-with-record',
    purpose: 'Provide diagnostic context for the failure.',
    deletion: 'Deleted when the crash report is deleted.',
    needsReview: false,
  },
  {
    field: 'CrashReport.logLines',
    category: 'diagnostic',
    retention: 'retained-with-record',
    purpose: 'Provide log context for the failure.',
    deletion: 'Deleted when the crash report is deleted.',
    needsReview: false,
  },
  {
    field: 'CrashReport.timestamp',
    category: 'diagnostic',
    retention: 'retained-with-record',
    purpose: 'Record when the failure occurred.',
    deletion: 'Deleted when the crash report is deleted.',
    needsReview: false,
  },
  {
    field: 'CrashReport.createdAt',
    category: 'operational-metadata',
    retention: 'retained-with-record',
    purpose: 'Record when the crash report was stored.',
    deletion: 'Deleted when the crash report is deleted.',
    needsReview: false,
  },
  {
    field: 'CrashReportingSettings.userId',
    category: 'identifier',
    retention: 'retained-while-setting-exists',
    purpose: 'Associate settings with the user.',
    deletion: 'Deleted on user deletion.',
    needsReview: false,
  },
  {
    field: 'CrashReportingSettings.crashReportingEnabled',
    category: 'preference',
    retention: 'retained-while-setting-exists',
    purpose: 'Honor the user crash-reporting preference.',
    deletion: 'Deleted on user deletion.',
    needsReview: false,
  },
  {
    field: 'CrashReportingSettings.updatedAt',
    category: 'operational-metadata',
    retention: 'retained-while-setting-exists',
    purpose: 'Record when the preference last changed.',
    deletion: 'Deleted on user deletion.',
    needsReview: false,
  },
  {
    field: 'LogExport.userId',
    category: 'identifier',
    retention: 'export-payload-only',
    purpose: 'Identify the user the export belongs to.',
    deletion: 'Not persisted by the export; present only in the returned payload.',
    needsReview: false,
  },
  {
    field: 'LogExport.exportedAt',
    category: 'operational-metadata',
    retention: 'export-payload-only',
    purpose: 'Record when the export was generated.',
    deletion: 'Not persisted by the export; present only in the returned payload.',
    needsReview: false,
  },
  {
    field: 'LogExport.currentLogs',
    category: 'diagnostic',
    retention: 'export-payload-only',
    purpose: 'Provide current logs to the user.',
    deletion: 'Not persisted by the export; present only in the returned payload.',
    needsReview: false,
  },
  {
    field: 'LogExport.crashReports',
    category: 'diagnostic',
    retention: 'export-payload-only',
    purpose: 'Provide crash reports to the user.',
    deletion: 'Not persisted by the export; present only in the returned payload.',
    needsReview: false,
  },
];

/**
 * Build an inventory entry for a field that is not yet classified.
 *
 * Unknown fields are flagged for review rather than assumed absent.
 */
export function unclassifiedField(field: string): FieldInventoryEntry {
  return {
    field,
    category: 'unclassified',
    retention: 'unknown',
    purpose: 'Unclassified field; requires review.',
    deletion: 'Unknown; requires review.',
    needsReview: true,
  };
}

/**
 * Return inventory entries that still need review.
 */
export function fieldsNeedingReview(
  inventory: readonly FieldInventoryEntry[] = CRASH_REPORTING_FIELD_INVENTORY,
): FieldInventoryEntry[] {
  return inventory.filter((entry) => entry.needsReview || entry.category === 'unclassified');
}
</｜｜DSML｜｜ parameter>