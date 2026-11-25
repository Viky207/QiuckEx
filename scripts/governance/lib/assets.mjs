/**
 * Asset listing policy validation + evaluation — issue #306.
 *
 * Canonical policy: docs/policies/data/asset-listing-policy.json
 * Document of record: docs/policies/ASSET-LISTING-POLICY.md
 * Runtime mirror: app/backend/src/asset-listing/asset-listing.policy.ts
 *
 * The evaluation functions are pure so the rules can be unit tested here and
 * asserted against the backend implementation.
 */
import { PATHS, duplicates, missingMentions, missingSections, readJson, readText } from "./shared.mjs";

export const ASSET_STATUSES = ["pending", "listed", "suspended", "delisted", "rejected"];
export const ASSET_TIERS = ["native", "verified", "community", "unlisted"];
export const TRIGGER_SEVERITIES = ["critical", "high", "medium"];
export const SERVED_TIERS = ["native", "verified"];
export const DAY_MS = 24 * 60 * 60 * 1000;

export const ASSET_LISTING_DOC_SECTIONS = [
  "1. Scope",
  "2. Listing states",
  "3. Verification tiers",
  "4. Delisting triggers",
  "5. Authorization",
  "6. Observability",
  "7. Configuration",
  "8. Rollout and rollback",
  "9. Keeping code and policy in sync",
  "10. References",
];

/**
 * Required sections of the maintainer onboarding guide — issue #572.
 *
 * Canonical guide: docs/ASSET-ONBOARDING-GUIDE.md
 */
export const ASSET_ONBOARDING_GUIDE_SECTIONS = [
  "Required issuer proof",
  "Review ownership",
  "Registry update path",
  "Cache invalidation checks",
  "Delisting and rollback",
];

export function errorCodes(policy) {
  return Object.keys(policy.errorCodes ?? {});
}

/** Parse `('CODE', …)` tuples out of the verified_assets seed migration. */
export function parseSeedCodes(sql) {
  const codes = new Set();
  for (const match of sql.matchAll(/\(\s*'([A-Za-z0-9]{1,12})'\s*,/g)) {
    codes.add(match[1]);
  }
  return [...codes].sort();
}

function validateVocabulary(policy, errors) {
  const statuses = policy.statuses ?? [];
  for (const status of ASSET_STATUSES) {
    if (!statuses.includes(status)) {
      errors.push(`asset-listing-policy.json: status "${status}" missing from statuses`);
    }
  }
  for (const status of policy.servedStatuses ?? []) {
    if (!statuses.includes(status)) {
      errors.push(`asset-listing-policy.json: servedStatuses entry "${status}" is not a known status`);
    }
  }
  if ((policy.servedStatuses ?? []).length === 0) {
    errors.push("asset-listing-policy.json: servedStatuses must not be empty");
  }

  const transitions = policy.transitions ?? [];
  if (transitions.length === 0) {
    errors.push("asset-listing-policy.json: transitions must not be empty");
  }
  for (const dupe of duplicates(transitions.map((t) => `${t.from}->${t.to}`))) {
    errors.push(`asset-listing-policy.json: duplicate transition ${dupe}`);
  }
  for (const transition of transitions) {
    if (!statuses.includes(transition.from) || !statuses.includes(transition.to)) {
      errors.push(
        `asset-listing-policy.json: transition ${transition.from}->${transition.to} uses an unknown status`,
      );
    }
    if (!transition.action) {
      errors.push(
        `asset-listing-policy.json: transition ${transition.from}->${transition.to} needs an action`,
      );
    }
  }

  if (Object.keys(policy.tiers ?? {}).length === 0) {
    errors.push("asset-listing-policy.json: tiers must map at least one asset code");
  }
  for (const tier of new Set(Object.values(policy.tiers ?? {}))) {
    if (!ASSET_TIERS.includes(tier)) {
      errors.push(`asset-listing-policy.json: unknown tier "${tier}"`);
    }
  }
}


function validateEvidenceAndTriggers(policy, errors) {
  for (const [kind, rule] of Object.entries(policy.evidence ?? {})) {
    if (!Number.isInteger(rule.maxAgeDays) || rule.maxAgeDays <= 0) {
      errors.push(`asset-listing-policy.json: evidence "${kind}" needs a positive maxAgeDays`);
    }
    for (const tier of rule.requiredForTiers ?? []) {
      if (!ASSET_TIERS.includes(tier)) {
        errors.push(`asset-listing-policy.json: evidence "${kind}" requires unknown tier "${tier}"`);
      }
    }
  }
  const requiredTiers = new Set(
    Object.values(policy.evidence ?? {}).flatMap((rule) => rule.requiredForTiers ?? []),
  );
  if (!requiredTiers.has("verified")) {
    errors.push('asset-listing-policy.json: tier "verified" must require evidence');
  }

  const triggers = policy.delistingTriggers ?? [];
  if (triggers.length === 0) {
    errors.push("asset-listing-policy.json: delistingTriggers must not be empty");
  }
  for (const dupe of duplicates(triggers.map((trigger) => trigger.id))) {
    errors.push(`asset-listing-policy.json: duplicate trigger id "${dupe}"`);
  }
  const statuses = policy.statuses ?? [];
  for (const trigger of triggers) {
    if (!TRIGGER_SEVERITIES.includes(trigger.severity)) {
      errors.push(`asset-listing-policy.json: trigger "${trigger.id}" has invalid severity`);
    }
    if (typeof trigger.immediate !== "boolean") {
      errors.push(`asset-listing-policy.json: trigger "${trigger.id}" needs a boolean immediate flag`);
    }
    if (!statuses.includes(trigger.defaultResolution)) {
      errors.push(
        `asset-listing-policy.json: trigger "${trigger.id}" resolves to unknown status "${trigger.defaultResolution}"`,
      );
    }
  }
}

function validatePolicyShape(policy, errors) {
  if (policy.schemaVersion !== 1) {
    errors.push(`asset-listing-policy.json: unsupported schemaVersion ${policy.schemaVersion}`);
  }
  if (!policy.policyId || !policy.policyVersion) {
    errors.push("asset-listing-policy.json: policyId and policyVersion are required");
  }
  if (!Number.isInteger(policy.minIssuerAccountAgeDays) || policy.minIssuerAccountAgeDays <= 0) {
    errors.push("asset-listing-policy.json: minIssuerAccountAgeDays must be a positive integer");
  }
  if (!Number.isInteger(policy.suspensionMaxDays) || policy.suspensionMaxDays <= 0) {
    errors.push("asset-listing-policy.json: suspensionMaxDays must be a positive integer");
  }
  if (!Number.isInteger(policy.coolingOffDaysBeforeRelist) || policy.coolingOffDaysBeforeRelist < 0) {
    errors.push("asset-listing-policy.json: coolingOffDaysBeforeRelist must be >= 0");
  }
  for (const [code, http] of Object.entries(policy.errorCodes ?? {})) {
    if (!Number.isInteger(http) || http < 400 || http > 599) {
      errors.push(`asset-listing-policy.json: error code ${code} needs a 4xx/5xx status`);
    }
  }
  if (Object.keys(policy.errorCodes ?? {}).length === 0) {
    errors.push("asset-listing-policy.json: errorCodes must not be empty");
  }
  if ((policy.metrics ?? []).length === 0) {
    errors.push("asset-listing-policy.json: metrics must not be empty");
  }
  const flags = policy.featureFlags ?? {};
  if (!flags.enforcement || !flags.decisions) {
    errors.push("asset-listing-policy.json: featureFlags.enforcement and featureFlags.decisions are required");
  }
  if (!(flags.defaultDisabledNetworks ?? []).includes("mainnet")) {
    errors.push(
      'asset-listing-policy.json: featureFlags.defaultDisabledNetworks must include "mainnet" (feature-gating requirement)',
    );
  }
}

function validateDocAndMirror(policy, { docContent, seedCodes = [], mirrorContent = "" }, errors, warnings) {
  for (const code of seedCodes) {
    if (!(code in (policy.tiers ?? {}))) {
      errors.push(`asset-listing-policy.json: seeded asset "${code}" has no tier assignment`);
    }
  }

  if (!docContent) {
    errors.push(`${PATHS.assetListingDoc}: document is missing`);
    return;
  }
  for (const section of missingSections(docContent, ASSET_LISTING_DOC_SECTIONS)) {
    errors.push(`${PATHS.assetListingDoc}: missing required section "${section}"`);
  }
  const tokens = [
    ...(policy.delistingTriggers ?? []).map((trigger) => trigger.id),
    ...errorCodes(policy),
    ...new Set(Object.values(policy.tiers ?? {})),
  ];
  for (const token of missingMentions(docContent, tokens)) {
    errors.push(`${PATHS.assetListingDoc}: does not document "${token}"`);
  }

  if (!mirrorContent) {
    errors.push(`${PATHS.assetListingMirror}: mirror is missing`);
    return;
  }
  if (!mirrorContent.includes(policy.policyVersion)) {
    errors.push(
      `${PATHS.assetListingMirror}: does not reference policy version ${policy.policyVersion}`,
    );
  }
  for (const token of [
    ...(policy.delistingTriggers ?? []).map((trigger) => trigger.id),
    ...errorCodes(policy),
  ]) {
    if (!mirrorContent.includes(token)) {
      warnings.push(`${PATHS.assetListingMirror}: does not mention "${token}"`);
    }
  }
}

/**
 * Validate the maintainer onboarding guide against the policy — issue #572.
 *
 * Fails when the guide is missing, when a required section is absent, or when
 * a delisting trigger id / `ASSET_LISTING_*` error code is not mentioned.
 */
export function validateAssetOnboardingGuide(policy, guideContent) {
  const errors = [];
  if (!guideContent) {
    errors.push(`${PATHS.assetOnboardingGuide}: guide is missing`);
    return { errors };
  }
  for (const section of missingSections(guideContent, ASSET_ONBOARDING_GUIDE_SECTIONS)) {
    errors.push(`${PATHS.assetOnboardingGuide}: missing required section "${section}"`);
  }
  const tokens = [
    ...(policy.delistingTriggers ?? []).map((trigger) => trigger.id),
    ...errorCodes(policy).filter((code) => code.startsWith("ASSET_LISTING_")),
  ];
  for (const token of missingMentions(guideContent, tokens)) {
    errors.push(`${PATHS.assetOnboardingGuide}: does not document "${token}"`);
  }
  return { errors };
}

/** Load + validate the onboarding guide from disk. */
export function checkAssetOnboardingGuide(root) {
  const policy = readJson(root, PATHS.assetListingPolicy);
  let guideContent = "";
  try {
    guideContent = readText(root, PATHS.assetOnboardingGuide);
  } catch {
    guideContent = "";
  }
  return validateAssetOnboardingGuide(policy, guideContent);
}

export function validateAssetListingPolicy(policy, context = {}) {
  const errors = [];
  const warnings = [];
  validatePolicyShape(policy, errors);
  validateVocabulary(policy, errors);
  validateEvidenceAndTriggers(policy, errors);
  validateDocAndMirror(policy, context, errors, warnings);
  if (context.guideContent !== undefined) {
    errors.push(...validateAssetOnboardingGuide(policy, context.guideContent).errors);
  }
  return { errors, warnings };
}

/** Load + validate the policy from disk. */
export function checkAssetListingPolicy(root) {
  const policy = readJson(root, PATHS.assetListingPolicy);
  let docContent = "";
  let mirrorContent = "";
  try {
    docContent = readText(root, PATHS.assetListingDoc);
  } catch {
    docContent = "";
  }
  try {
    mirrorContent = readText(root, PATHS.assetListingMirror);
  } catch {
    mirrorContent = "";
  }
  let guideContent = "";
  try {
    guideContent = readText(root, PATHS.assetOnboardingGuide);
  } catch {
    guideContent = "";
  }
  const seedCodes = parseSeedCodes(readText(root, PATHS.verifiedAssetsMigration));
  const result = validateAssetListingPolicy(policy, { docContent, seedCodes, mirrorContent, guideContent });
  return { ...result, policy, seedCodes };
}

// ── Evaluation (pure) ────────────────────────────────────────────────────────

/** Tier for an asset: explicit record tier wins, then the policy table. */
export function tierFor(policy, record) {
  return record.tier ?? policy.tiers?.[record.code] ?? "unlisted";
}

/** Evidence kinds required for a tier, per the policy. */
export function requiredEvidenceFor(policy, tier) {
  return Object.entries(policy.evidence ?? {})
    .filter(([, rule]) => (rule.requiredForTiers ?? []).includes(tier))
    .map(([kind]) => kind);
}

/**
 * Evaluate one registry record at `now`.
 *
 * Returns `{ status, tier, served, reasons, expiringAt }` where `status` is the
 * *effective* status (evidence expiry degrades `listed` to `suspended`).
 */
export function evaluateAssetListing({ policy, record, evidence = [], now = Date.now() }) {
  const tier = tierFor(policy, record);
  const reasons = [];
  let status = record.status ?? "pending";

  const required = requiredEvidenceFor(policy, tier);
  const byKind = new Map(evidence.map((entry) => [entry.kind, entry]));
  let earliestExpiry = null;

  for (const kind of required) {
    const entry = byKind.get(kind);
    if (!entry) {
      reasons.push(`evidence_missing:${kind}`);
      continue;
    }
    const expiresAt = Date.parse(entry.expiresAt);
    if (Number.isFinite(expiresAt)) {
      if (earliestExpiry === null || expiresAt < earliestExpiry) earliestExpiry = expiresAt;
      if (expiresAt <= now) reasons.push(`evidence_expired:${kind}`);
    }
  }

  if (status === "listed" && reasons.length > 0) {
    status = "suspended";
    reasons.push("trigger:evidence_expired");
  }
  if (status === "suspended" && record.suspendedAt) {
    const suspendedMs = now - Date.parse(record.suspendedAt);
    if (suspendedMs > policy.suspensionMaxDays * DAY_MS) {
      status = "delisted";
      reasons.push("trigger:suspension_timeout");
    }
  }

  const served = (policy.servedStatuses ?? []).includes(status) && SERVED_TIERS.includes(tier);

  return { status, tier, served, reasons, expiringAt: earliestExpiry };
}

/** Served asset keys for a batch of registry records (used by the API layer). */
export function servedAssetKeys(policy, records, evidenceByKey = {}, now = Date.now()) {
  return records
    .map((record) => evaluateAssetListing({ policy, record, evidence: evidenceByKey[record.key] ?? [], now }))
    .filter((evaluation) => evaluation.served)
    .map((evaluation) => evaluation.key);
}

/**
 * Apply a decision (list/suspend/delist/reject) to a record.
 *
 * Returns `{ ok, code, next, reasons }`: `code` is a stable policy error code
 * (`ASSET_LISTING_*`) when the transition is rejected.
 */
export function applyDecision({ policy, record, action, trigger = null, now = Date.now(), evidence = [] }) {
  const from = record.status ?? "pending";
  const transition = (policy.transitions ?? []).find(
    (candidate) => candidate.from === from && candidate.action === action,
  );

  if (!transition) {
    return {
      ok: false,
      code: "ASSET_LISTING_INVALID_TRANSITION",
      reasons: [`no transition for ${from} + ${action}`],
    };
  }

  if (action === "list" && from === "delisted") {
    const delistedAt = record.delistedAt ? Date.parse(record.delistedAt) : NaN;
    if (!Number.isFinite(delistedAt)) {
      return {
        ok: false,
        code: "ASSET_LISTING_EVIDENCE_INCOMPLETE",
        reasons: ["re-listing requires a recorded delisting timestamp"],
      };
    }
    const coolingOffMs = policy.coolingOffDaysBeforeRelist * DAY_MS;
    if (now < delistedAt + coolingOffMs) {
      return {
        ok: false,
        code: "ASSET_LISTING_COOLING_OFF_ACTIVE",
        reasons: [`cooling-off ends at ${new Date(delistedAt + coolingOffMs).toISOString()}`],
      };
    }
  }

  if (action === "list") {
    const tier = tierFor(policy, record);
    const required = requiredEvidenceFor(policy, tier);
    const byKind = new Map(evidence.map((entry) => [entry.kind, entry]));
    const problems = [];
    for (const kind of required) {
      const entry = byKind.get(kind);
      if (!entry) {
        problems.push(`ASSET_LISTING_EVIDENCE_INCOMPLETE:${kind}`);
        continue;
      }
      if (Date.parse(entry.expiresAt) <= now) {
        problems.push(`ASSET_LISTING_EVIDENCE_EXPIRED:${kind}`);
      }
    }
    if (problems.length > 0) {
      const expired = problems.some((problem) => problem.startsWith("ASSET_LISTING_EVIDENCE_EXPIRED"));
      return {
        ok: false,
        code: expired ? "ASSET_LISTING_EVIDENCE_EXPIRED" : "ASSET_LISTING_EVIDENCE_INCOMPLETE",
        reasons: problems,
      };
    }
  }

  if (trigger && !(policy.delistingTriggers ?? []).some((entry) => entry.id === trigger)) {
    return {
      ok: false,
      code: "ASSET_LISTING_EVIDENCE_INCOMPLETE",
      reasons: [`unknown trigger "${trigger}"`],
    };
  }

  const next = {
    ...record,
    status: transition.to,
    tier: tierFor(policy, record),
    lastAction: action,
    lastTrigger: trigger,
    updatedAt: new Date(now).toISOString(),
  };
  if (transition.to === "delisted") next.delistedAt = next.updatedAt;
  if (transition.to === "suspended") next.suspendedAt = next.updatedAt;
  if (transition.to === "listed") {
    delete next.suspendedAt;
    delete next.delistedAt;
  }

  return { ok: true, code: null, next, reasons: [] };
}

