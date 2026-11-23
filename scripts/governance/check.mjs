#!/usr/bin/env node
/**
 * QuickEx governance gate.
 *
 * Validates the published governance artefacts (ADR set, asset listing policy,
 * retention/privacy schedule, accessibility & localization standard) and their
 * machine-readable mirrors. Zero dependencies and no network access, so it runs
 * on every pull request before anything is installed.
 *
 * Usage:
 *   node scripts/governance/check.mjs                     # all checks
 *   node scripts/governance/check.mjs --only adr           # adr|assets|retention|a11y|branch-protection|docs
 *   node scripts/governance/check.mjs --json               # machine-readable report
 *   node scripts/governance/check.mjs --only a11y --write-baseline
 *
 * Exit codes: 0 = no errors, 1 = errors, 2 = usage error.
 */
import { existsSync, writeFileSync } from "node:fs";
import { checkAdrs } from "./lib/adr.mjs";
import { checkAssetListingPolicy } from "./lib/assets.mjs";
import { checkRetentionSchedule } from "./lib/retention.mjs";
import { buildBaseline, validateI18n } from "./lib/i18n.mjs";
import { checkBranchProtection } from "./lib/branch-protection.mjs";
import { PATHS, REPO_ROOT, missingSections, readText } from "./lib/shared.mjs";

export const GOVERNANCE_DOC_SECTIONS = [
  "1. Policies and standards",
  "2. Owners",
  "3. Review cadence",
  "4. Architecture decision records",
  "5. Machine checks",
  "6. Waivers",
  "7. Adding a policy",
];

export function runCheck(root = REPO_ROOT, { only = "all" } = {}) {
  const checks = {};

  if (only === "all" || only === "adr") {
    checks.adr = checkAdrs(root);
  }
  if (only === "all" || only === "assets") {
    checks.assets = checkAssetListingPolicy(root);
  }
  if (only === "all" || only === "retention") {
    checks.retention = checkRetentionSchedule(root);
  }
  if (only === "all" || only === "a11y") {
    let docContent = "";
    try {
      docContent = readText(root, PATHS.a11yDoc);
    } catch {
      docContent = "";
    }
    checks.a11y = validateI18n(root, { docContent });
  }
  if (only === "all" || only === "branch-protection") {
    checks["branch-protection"] = checkBranchProtection(root);
  }
  if (only === "all" || only === "docs") {
    const errors = [];
    const warnings = [];
    if (!existsSync(`${root}/${PATHS.governanceDoc}`)) {
      errors.push(`${PATHS.governanceDoc}: governance hub is missing`);
    } else {
      for (const section of missingSections(readText(root, PATHS.governanceDoc), GOVERNANCE_DOC_SECTIONS)) {
        errors.push(`${PATHS.governanceDoc}: missing required section "${section}"`);
      }
    }
    for (const doc of [PATHS.assetListingDoc, PATHS.retentionDoc, PATHS.a11yDoc]) {
      if (!readText(root, doc).includes("GOVERNANCE.md")) {
        warnings.push(`${doc}: does not link back to docs/GOVERNANCE.md`);
      }
    }
    checks.docs = { errors, warnings };
  }

  const errors = Object.entries(checks).flatMap(([name, result]) =>
    result.errors.map((message) => `[${name}] ${message}`),
  );
  const warnings = Object.entries(checks).flatMap(([name, result]) =>
    result.warnings.map((message) => `[${name}] ${message}`),
  );

  return { checks, errors, warnings, ok: errors.length === 0 };
}

function parseArgs(argv) {
  const options = { only: "all", json: false, writeBaseline: false, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--only") {
      options.only = argv[index + 1];
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write-baseline") {
      options.writeBaseline = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      options.unknown = arg;
    }
  }
  return options;
}

const VALID_TARGETS = ["all", "adr", "assets", "retention", "a11y", "branch-protection", "docs"];

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(
      "usage: node scripts/governance/check.mjs [--only " +
        `${VALID_TARGETS.join("|")}] [--json] [--write-baseline] [--quiet]\n`,
    );
    return 0;
  }
  if (options.unknown || !VALID_TARGETS.includes(options.only)) {
    process.stderr.write(`unknown argument or target: ${options.unknown ?? options.only}\n`);
    return 2;
  }

  if (options.writeBaseline) {
    const baseline = buildBaseline(REPO_ROOT);
    writeFileSync(
      `${REPO_ROOT}/${PATHS.a11yBaseline}`,
      `${JSON.stringify(baseline, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`wrote ${PATHS.a11yBaseline}\n`);
  }

  const report = runCheck(REPO_ROOT, { only: options.only });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const [name, result] of Object.entries(report.checks)) {
      const state = result.errors.length === 0 ? "PASS" : "FAIL";
      process.stdout.write(
        `${state} ${name}: ${result.errors.length} error(s), ${result.warnings.length} warning(s)\n`,
      );
      for (const message of result.errors) process.stdout.write(`  ✗ ${message}\n`);
      if (!options.quiet) {
        for (const message of result.warnings) process.stdout.write(`  ! ${message}\n`);
      }
    }
    process.stdout.write(
      report.ok
        ? "\ngovernance gate: PASS\n"
        : `\ngovernance gate: FAIL (${report.errors.length} error(s))\n`,
    );
  }

  return report.ok ? 0 : 1;
}

const isEntryPoint =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");

if (isEntryPoint) {
  process.exitCode = main();
}
