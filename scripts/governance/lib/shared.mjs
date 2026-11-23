/**
 * Shared helpers for the QuickEx governance gate.
 *
 * Zero dependencies on purpose: the gate must run in CI and on a fresh clone
 * before `pnpm install`, and it must never execute repository code.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root (…/QiuckEx), derived from this file's location. */
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

export const PATHS = {
  adrDir: "docs/adr",
  governanceDoc: "docs/GOVERNANCE.md",
  assetListingDoc: "docs/policies/ASSET-LISTING-POLICY.md",
  assetListingPolicy: "docs/policies/data/asset-listing-policy.json",
  assetListingMirror: "app/backend/src/asset-listing/asset-listing.policy.ts",
  retentionDoc: "docs/policies/DATA-RETENTION-PRIVACY-POLICY.md",
  retentionSchedule: "docs/policies/data/retention-schedule.json",
  retentionMirror: "app/backend/src/privacy/retention/retention-schedule.ts",
  a11yDoc: "docs/policies/ACCESSIBILITY-LOCALIZATION-STANDARD.md",
  a11yBaseline: "docs/policies/data/a11y-i18n-baseline.json",
  branchProtectionPolicy: "docs/policies/data/branch-protection-policy.json",
  verifiedAssetsMigration:
    "app/backend/supabase/migrations/20260526000000_create_verified_assets.sql",
  frontendI18n: "app/frontend/src/lib/i18n.ts",
  frontendSwitcher: "app/frontend/src/components/LocaleSwitcher.tsx",
  mobileI18n: "app/mobile/src/lib/i18n.ts",
  mobileSwitcher: "app/mobile/components/LocaleSwitcher.tsx",
};

export function fromRoot(root, relative) {
  return join(root, relative);
}

export function readText(root, relative) {
  return readFileSync(fromRoot(root, relative), "utf8");
}

export function readJson(root, relative) {
  return JSON.parse(readText(root, relative));
}

export function fileExists(root, relative) {
  return existsSync(fromRoot(root, relative));
}

export function listFiles(root, relativeDir) {
  const dir = fromRoot(root, relativeDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => !name.startsWith(".")).sort();
}

/** Extract every level-2 heading (`## X`) from markdown, normalised. */
export function headings(markdown) {
  return markdown
    .split("\n")
    .map((line) => line.match(/^##\s+(.*?)\s*$/))
    .filter(Boolean)
    .map((match) => match[1].trim());
}

/**
 * Verify that a markdown document contains the given `##` sections (matched by
 * their leading identifier, e.g. "5." or the full heading text).
 */
export function missingSections(markdown, required) {
  const found = headings(markdown);
  return required.filter((required_) => {
    return !found.some(
      (heading) =>
        heading === required_ ||
        heading.startsWith(required_) ||
        heading.replace(/^[0-9]+\.\s*/, "") ===
          required_.replace(/^[0-9]+\.\s*/, ""),
    );
  });
}

/** Report tokens (literal strings) that a document fails to mention. */
export function missingMentions(markdown, tokens) {
  return tokens.filter((token) => !markdown.includes(token));
}

export function unique(values) {
  return [...new Set(values)];
}

/** Load the checked-in branch-protection policy (read-only). */
export function loadBranchProtectionPolicy(root) {
  return readJson(root, PATHS.branchProtectionPolicy);
}

/**
 * Compare the checked-in branch-protection policy against a GitHub branch
 * protection payload (as returned by the REST API for the protected branch).
 *
 * Pure and read-only: it never mutates the payload or the policy and never
 * touches repository settings. Returns an array of actionable rule names for
 * every missing or incorrect protection; an empty array means compliant.
 *
 * Policy shape:
 *   {
 *     "branch": "main",
 *     "requiredStatusChecks": ["ci", "governance"],
 *     "requiredApprovingReviewCount": 1,
 *     "dismissStaleReviews": true,
 *     "requireCodeOwnerReviews": true,
 *     "enforceAdmins": true,
 *     "requireLinearHistory": true,
 *     "allowForcePushes": false,
 *     "allowDeletions": false
 *   }
 */
export function diffBranchProtection(policy, protection) {
  const issues = [];
  const p = policy ?? {};
  const actual = protection ?? {};

  const statusChecks = actual.required_status_checks ?? null;
  const actualContexts = Array.isArray(statusChecks?.contexts)
    ? statusChecks.contexts
    : [];
  const requiredChecks = Array.isArray(p.requiredStatusChecks)
    ? p.requiredStatusChecks
    : [];
  for (const check of requiredChecks) {
    if (!actualContexts.includes(check)) {
      issues.push(`required status check "${check}" is not enforced`);
    }
  }

  const reviews = actual.required_pull_request_reviews ?? null;
  const requiredCount = p.requiredApprovingReviewCount ?? 0;
  const actualCount = reviews?.required_approving_review_count ?? 0;
  if (actualCount < requiredCount) {
    issues.push(
      `required approving review count is ${actualCount}, expected at least ${requiredCount}`,
    );
  }

  if (p.dismissStaleReviews === true && reviews?.dismiss_stale_reviews !== true) {
    issues.push("dismiss stale reviews on new commits is not enforced");
  }

  if (
    p.requireCodeOwnerReviews === true &&
    reviews?.require_code_owner_reviews !== true
  ) {
    issues.push("code owner review requirement is not enforced");
  }

  if (p.enforceAdmins === true && actual.enforce_admins?.enabled !== true) {
    issues.push("branch protection is not enforced for administrators");
  }

  if (
    p.requireLinearHistory === true &&
    actual.required_linear_history?.enabled !== true
  ) {
    issues.push("linear history requirement is not enforced");
  }

  if (p.allowForcePushes === false && actual.allow_force_pushes?.enabled === true) {
    issues.push("force pushes are allowed but must be blocked");
  }

  if (p.allowDeletions === false && actual.allow_deletions?.enabled === true) {
    issues.push("branch deletions are allowed but must be blocked");
  }

  return issues;
}

/** Duplicate values in an array, order-preserving. */
export function duplicates(values) {
  const seen = new Set();
  const dupes = new Set();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}
