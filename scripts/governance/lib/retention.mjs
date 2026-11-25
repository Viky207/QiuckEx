/**
 * Retention schedule validation + sweep planning — issue #307.
 *
 * Canonical schedule: docs/policies/data/retention-schedule.json
 * Document of record: docs/policies/DATA-RETENTION-PRIVACY-POLICY.md
 * Runtime mirror: app/backend/src/privacy/retention/retention-schedule.ts
 */
import { PATHS, duplicates, missingMentions, missingSections, readJson, readText } from "./shared.mjs";

export const DELETION_METHODS = [
  "hard_delete",
  "pseudonymize",
  "redact",
  "aggregate_only",
  "not_deletable",
  "device_local",
];

export const RETENTION_DOC_SECTIONS = [
  "1. Principles",
  "2. Data inventory",
  "3. Deletion requests",
  "4. Legal holds",
  "5. Error codes",
  "6. Observability",
  "7. Configuration",
  "8. Operational procedures",
  "9. References",
];

export const FIELD_INVENTORY_DOC_SECTIONS = [
  "1. Purpose",
  "2. Field inventory",
  "3. Unknown fields",
  "4. Deletion behavior",
  "5. References",
];

export const FIELD_CATEGORIES = ["profile", "payment", "telemetry", "operational"];
export const FIELD_DELETION_BEHAVIORS = [
  "hard_delete",
  "pseudonymize",
  "redact",
  "aggregate_only",
  "not_deletable",
  "device_local",
];
export const UNKNOWN_FIELD_STATUSES = ["unknown", "under_review", "confirmed_absent"];
=======

export const DAY_MS = 24 * 60 * 60 * 1000;
export const INDEFINITE = -1;

export function holdIds(schedule) {
  return (schedule.holds ?? []).map((hold) => hold.id);
}

export function categoryIds(schedule) {
  return (schedule.categories ?? []).map((category) => category.id);
}

export function findCategory(schedule, id) {
  return (schedule.categories ?? []).find((category) => category.id === id) ?? null;
}

export function fieldIds(inventory) {
  return (inventory.fields ?? []).map((field) => field.id);
}

export function findField(inventory, id) {
  return (inventory.fields ?? []).find((field) => field.id === id) ?? null;
}

function validateShapeAndSla(schedule, errors) {
  if (schedule.schemaVersion !== 1) {
    errors.push(`retention-schedule.json: unsupported schemaVersion ${schedule.schemaVersion}`);
  }
  if (!schedule.policyId || !schedule.policyVersion) {
    errors.push("retention-schedule.json: policyId and policyVersion are required");
  }

  const sla = schedule.deletionServiceLevel ?? {};
  for (const key of [
    "acknowledgeBusinessDays",
    "executeDays",
    "executeDaysWithHold",
    "coolingOffDays",
    "challengeTtlSeconds",
  ]) {
    if (!Number.isInteger(sla[key]) || sla[key] <= 0) {
      errors.push(`retention-schedule.json: deletionServiceLevel.${key} must be a positive integer`);
    }
  }
  if (
    Number.isInteger(sla.executeDays) &&
    Number.isInteger(sla.executeDaysWithHold) &&
    sla.executeDaysWithHold < sla.executeDays
  ) {
    errors.push(
      "retention-schedule.json: deletionServiceLevel.executeDaysWithHold must be >= executeDays",
    );
  }
  if (!sla.proofPurpose) {
    errors.push("retention-schedule.json: deletionServiceLevel.proofPurpose is required (signed proof scope)");
  }

  for (const method of DELETION_METHODS) {
    if (!(schedule.methods ?? []).includes(method)) {
      errors.push(`retention-schedule.json: method "${method}" missing from methods`);
    }
  }

  const holds = schedule.holds ?? [];
  if (holds.length === 0) {
    errors.push("retention-schedule.json: holds must not be empty");
  }
  for (const dupe of duplicates(holds.map((hold) => hold.id))) {
    errors.push(`retention-schedule.json: duplicate hold id "${dupe}"`);
  }
  for (const hold of holds) {
    if (!hold.reason) {
      errors.push(`retention-schedule.json: hold "${hold.id}" needs a reason`);
    }
    if (!Number.isInteger(hold.maxDays) || (hold.maxDays <= 0 && hold.maxDays !== INDEFINITE)) {
      errors.push(
        `retention-schedule.json: hold "${hold.id}" maxDays must be positive or ${INDEFINITE} (indefinite)`,
      );
    }
  }

  if (Object.keys(schedule.errorCodes ?? {}).length === 0) {
    errors.push("retention-schedule.json: errorCodes must not be empty");
  }
  for (const [code, http] of Object.entries(schedule.errorCodes ?? {})) {
    if (!Number.isInteger(http) || http < 400 || http > 599) {
      errors.push(`retention-schedule.json: error code ${code} needs a 4xx/5xx status`);
    }
  }
  if ((schedule.metrics ?? []).length === 0) {
    errors.push("retention-schedule.json: metrics must not be empty");
  }
}

function validateCategories(schedule, errors, warnings) {
  const categories = schedule.categories ?? [];
  if (categories.length === 0) {
    errors.push("retention-schedule.json: categories must not be empty");
  }
  for (const dupe of duplicates(categories.map((category) => category.id))) {
    errors.push(`retention-schedule.json: duplicate category id "${dupe}"`);
  }
  for (const category of categories) {
    if (!category.storage) {
      errors.push(`retention-schedule.json: category "${category.id}" must name its storage`);
    }
    if (!category.windowFrom) {
      errors.push(`retention-schedule.json: category "${category.id}" must name windowFrom`);
    }
    if (
      !Number.isInteger(category.windowDays) ||
      (category.windowDays < 0 && category.windowDays !== INDEFINITE)
    ) {
      errors.push(
        `retention-schedule.json: category "${category.id}" windowDays must be >= 0 or ${INDEFINITE}`,
      );
    }
    if (!DELETION_METHODS.includes(category.method)) {
      errors.push(
        `retention-schedule.json: category "${category.id}" has invalid method "${category.method}"`,
      );
    }
    if (![true, false, "possible"].includes(category.containsPersonalData)) {
      errors.push(
        `retention-schedule.json: category "${category.id}" containsPersonalData must be true/false/"possible"`,
      );
    }
    if (category.method === "not_deletable" || category.method === "device_local") {
      if (!category.note) {
        errors.push(
          `retention-schedule.json: category "${category.id}" (${category.method}) must explain why in "note"`,
        );
      }
    }
  }
  if ((schedule.holds ?? []).length > 0 && !categories.some((category) => category.holdable)) {
    warnings.push("retention-schedule.json: holds declared but no category is holdable");
  }
}

function validateDocAndMirror(schedule, { docContent, mirrorContent = "" }, errors, warnings) {
  if (!docContent) {
    errors.push(`${PATHS.retentionDoc}: document is missing`);
    return;
  }
  for (const section of missingSections(docContent, RETENTION_DOC_SECTIONS)) {
    errors.push(`${PATHS.retentionDoc}: missing required section "${section}"`);
  }
  const tokens = [
    ...categoryIds(schedule),
    ...holdIds(schedule),
    ...Object.keys(schedule.errorCodes ?? {}),
    ...DELETION_METHODS,
  ];
  for (const token of missingMentions(docContent, tokens)) {
    errors.push(`${PATHS.retentionDoc}: does not document "${token}"`);
  }

  if (!mirrorContent) {
    errors.push(`${PATHS.retentionMirror}: mirror is missing`);
    return;
  }
  if (!mirrorContent.includes(schedule.policyVersion)) {
    errors.push(
      `${PATHS.retentionMirror}: does not reference policy version ${schedule.policyVersion}`,
    );
    return;
  }
  for (const id of categoryIds(schedule)) {
    if (!mirrorContent.includes(id)) {
      warnings.push(`${PATHS.retentionMirror}: does not mention category "${id}"`);
    }
  }
}

function validateFieldInventoryShape(inventory, errors) {
  if (inventory.schemaVersion !== 1) {
    errors.push(`field-inventory.json: unsupported schemaVersion ${inventory.schemaVersion}`);
  }
  if (!inventory.inventoryId || !inventory.inventoryVersion) {
    errors.push("field-inventory.json: inventoryId and inventoryVersion are required");
  }
  const fields = inventory.fields ?? [];
  if (fields.length === 0) {
    errors.push("field-inventory.json: fields must not be empty");
  }
  for (const dupe of duplicates(fields.map((field) => field.id))) {
    errors.push(`field-inventory.json: duplicate field id "${dupe}"`);
  }
  for (const field of fields) {
    if (!FIELD_CATEGORIES.includes(field.category)) {
      errors.push(
        `field-inventory.json: field "${field.id}" has invalid category "${field.category}"`,
      );
    }
    if (!field.purpose) {
      errors.push(`field-inventory.json: field "${field.id}" must state its purpose`);
    }
    if (!field.storage) {
      errors.push(`field-inventory.json: field "${field.id}" must name its storage`);
    }
    if (!FIELD_DELETION_BEHAVIORS.includes(field.deletionBehavior)) {
      errors.push(
        `field-inventory.json: field "${field.id}" has invalid deletionBehavior "${field.deletionBehavior}"`,
      );
    }
    if (![true, false, "possible"].includes(field.containsPersonalData)) {
      errors.push(
        `field-inventory.json: field "${field.id}" containsPersonalData must be true/false/"possible"`,
      );
    }
  }
}

/**
 * Cross-check the field inventory against the canonical retention schedule.
 *
 * Fields that reference a retention category must point at a real category and
 * agree with its deletion method. Fields with no known category are flagged for
 * review (never silently assumed absent) unless explicitly marked
 * `confirmed_absent`.
 */
export function validateFieldInventory(inventory, schedule, { docContent = "" } = {}) {
  const errors = [];
  const warnings = [];
  validateFieldInventoryShape(inventory, errors);

  const categories = schedule?.categories ?? [];
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const referenced = new Set();

  for (const field of inventory.fields ?? []) {
    const categoryId = field.retentionCategory;
    if (categoryId) {
      const category = categoryById.get(categoryId);
      if (!category) {
        errors.push(
          `field-inventory.json: field "${field.id}" references unknown retention category "${categoryId}"`,
        );
      } else {
        referenced.add(categoryId);
        if (field.deletionBehavior !== category.method) {
          errors.push(
            `field-inventory.json: field "${field.id}" deletionBehavior "${field.deletionBehavior}" disagrees with category "${categoryId}" method "${category.method}"`,
          );
        }
      }
    } else {
      const status = field.unknownStatus;
      if (!UNKNOWN_FIELD_STATUSES.includes(status)) {
        warnings.push(
          `field-inventory.json: field "${field.id}" has no retentionCategory and is not flagged for review (unknownStatus)`,
        );
      } else if (status === "unknown" || status === "under_review") {
        warnings.push(
          `field-inventory.json: field "${field.id}" is flagged for review (${status})`,
        );
      }
    }
  }

  for (const category of categories) {
    if (!referenced.has(category.id)) {
      warnings.push(
        `field-inventory.json: retention category "${category.id}" has no mapped field`,
      );
    }
  }

  if (!docContent) {
    errors.push(`${PATHS.fieldInventoryDoc}: document is missing`);
  } else {
    for (const section of missingSections(docContent, FIELD_INVENTORY_DOC_SECTIONS)) {
      errors.push(`${PATHS.fieldInventoryDoc}: missing required section "${section}"`);
    }
    const tokens = [
      ...fieldIds(inventory),
      ...FIELD_CATEGORIES,
      ...FIELD_DELETION_BEHAVIORS,
    ];
    for (const token of missingMentions(docContent, tokens)) {
      errors.push(`${PATHS.fieldInventoryDoc}: does not document "${token}"`);
    }
  }

  return { errors, warnings };
}

export function validateRetentionSchedule(schedule, context = {}) {
  const errors = [];
  const warnings = [];
  validateShapeAndSla(schedule, errors);
  validateCategories(schedule, errors, warnings);
  validateDocAndMirror(schedule, context, errors, warnings);
  return { errors, warnings };
}

/** Load + validate the retention schedule from disk. */
export function checkRetentionSchedule(root) {
  const schedule = readJson(root, PATHS.retentionSchedule);
  let docContent = "";
  let mirrorContent = "";
  try {
    docContent = readText(root, PATHS.retentionDoc);
  } catch {
    docContent = "";
  }
  try {
    mirrorContent = readText(root, PATHS.retentionMirror);
  } catch {
    mirrorContent = "";
  }
  const result = validateRetentionSchedule(schedule, { docContent, mirrorContent });
  return { ...result, schedule };
}

/** Load + validate the field inventory against the retention schedule from disk. */
export function checkFieldInventory(root) {
  const inventory = readJson(root, PATHS.fieldInventory);
  const schedule = readJson(root, PATHS.retentionSchedule);
  let docContent = "";
  try {
    docContent = readText(root, PATHS.fieldInventoryDoc);
  } catch {
    docContent = "";
  }
  const result = validateFieldInventory(inventory, schedule, { docContent });
  return { ...result, inventory, schedule };
}

// ── Planning (pure) ──────────────────────────────────────────────────────────

/** Due timestamp for a record, or null when retention is indefinite / not yet due. */
export function dueAtFor(category, windowStart, now = Date.now()) {
  if (category.windowDays === INDEFINITE) return null;
  const start = windowStart instanceof Date ? windowStart.getTime() : Date.parse(windowStart);
  if (!Number.isFinite(start)) return null;
  const dueAt = start + category.windowDays * DAY_MS;
  return dueAt <= now ? new Date(dueAt).toISOString() : null;
}

export function isDue(category, windowStart, now = Date.now()) {
  return dueAtFor(category, windowStart, now) !== null;
}

/**
 * Effective deletion method under active holds.
 *
 * A hold on a holdable category degrades `hard_delete` to `pseudonymize`
 * (financial invariants survive; the subject stops being identifiable).
 * A hold on a non-holdable category blocks deletion for the hold period.
 */
export function effectiveMethod(method, { holdable = false, activeHolds = [] } = {}) {
  if (activeHolds.length === 0) return { method, retained: false, holds: [] };
  if (!holdable) return { method: "retain", retained: true, holds: activeHolds };
  const degraded = method === "hard_delete" ? "pseudonymize" : method;
  return { method: degraded, retained: degraded === "retain", holds: activeHolds };
}

/** Per-category outcome for a subject deletion request. */
export function outcomesForSubject(schedule, activeHolds = []) {
  return (schedule.categories ?? []).map((category) => {
    const effective = effectiveMethod(category.method, {
      holdable: category.holdable === true,
      activeHolds,
    });
    return {
      id: category.id,
      storage: category.storage,
      method: category.method,
      action: effective.method,
      retained: effective.retained,
      hold: effective.holds.length > 0 ? effective.holds : null,
      windowDays: category.windowDays,
    };
  });
}

/**
 * Plan a retention sweep.
 *
 * `records` is `{ [categoryId]: [{ id, windowStart }] }`. The plan is
 * idempotent: records already deleted do not appear on the next run, and
 * `batchSize` bounds how much each run touches.
 */
export function planSweep({
  schedule,
  records = {},
  activeHolds = [],
  now = Date.now(),
  batchSize = 500,
}) {
  const plan = [];
  const skipped = [];
  let dueTotal = 0;

  for (const category of schedule.categories ?? []) {
    const rows = records[category.id] ?? [];
    const dueRows = rows.filter((row) => isDue(category, row.windowStart, now));
    const due = dueRows.length;
    dueTotal += due;

    if (category.windowDays === INDEFINITE) {
      skipped.push({ category: category.id, reason: "indefinite_retention", method: category.method, due });
      continue;
    }
    if (category.method === "not_deletable") {
      skipped.push({ category: category.id, reason: "not_deletable_at_source", method: category.method, due });
      continue;
    }
    if (category.method === "device_local") {
      skipped.push({
        category: category.id,
        reason: "device_local_not_server_side",
        method: category.method,
        due,
      });
      continue;
    }

    const effective = effectiveMethod(category.method, {
      holdable: category.holdable === true,
      activeHolds,
    });
    if (effective.retained) {
      skipped.push({
        category: category.id,
        reason: `hold:${effective.holds.join(",")}`,
        method: category.method,
        due,
      });
      continue;
    }

    plan.push({
      category: category.id,
      method: category.method,
      action: effective.method,
      due,
      ids: dueRows.slice(0, batchSize).map((row) => row.id),
      hold: effective.holds.length > 0 ? effective.holds : null,
      windowDays: category.windowDays,
      windowFrom: category.windowFrom,
    });
  }

  return {
    plan,
    skipped,
    totals: {
      due: dueTotal,
      planned: plan.reduce((sum, entry) => sum + entry.due, 0),
      skipped: skipped.reduce((sum, entry) => sum + entry.due, 0),
      categories: (schedule.categories ?? []).length,
    },
  };
}

