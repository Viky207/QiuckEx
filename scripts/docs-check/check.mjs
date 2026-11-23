#!/usr/bin/env node
/**
 * QuickEx documentation gate: API, contract, and mobile docs - issue #295.
 *
 * Validates that the published documentation still describes the API the
 * repository actually implements. Documentation drifts silently: a controller is
 * added, the OpenAPI document is never regenerated, and a client gets a 404.
 *
 * Zero dependencies, no network access, and it never starts the backend or a
 * simulator, so it runs on a fresh clone before `pnpm install` and in CI on an
 * untrusted fork.
 *
 * Usage:
 *   node scripts/docs-check/check.mjs                     # all checks
 *   node scripts/docs-check/check.mjs --only contract     # openapi|contract|mobile|env|payment-intents
 *   node scripts/docs-check/check.mjs --json              # machine-readable report
 *
 * Exit codes: 0 = no errors, 1 = errors, 2 = usage error.
 */
import { REPO_ROOT } from "./lib/shared.mjs";
import { checkOpenApiStructure } from "./lib/openapi.mjs";
import { checkContractDrift, checkGlobalPrefixInvariant } from "./lib/contract.mjs";
import { checkMobileDocs } from "./lib/mobile.mjs";
import { checkEnvPrecedence } from "./lib/env-precedence.mjs";
import { checkPaymentIntentLifecycle } from "./lib/payment-intents.mjs";

const VALID_TARGETS = ["all", "openapi", "contract", "mobile", "env", "payment-intents"];

export function runCheck(root = REPO_ROOT, { only = "all" } = {}) {
  const checks = {};

  if (only === "all" || only === "openapi") {
    checks.openapi = checkOpenApiStructure(root);
  }
  if (only === "all" || only === "contract") {
    // The global-prefix invariant is a contract claim, so it rides with the
    // contract target rather than getting a target of its own.
    const drift = checkContractDrift(root);
    const prefix = checkGlobalPrefixInvariant(root);
    checks.contract = {
      errors: [...drift.errors, ...prefix.errors],
      warnings: [...drift.warnings, ...prefix.warnings],
      summary: { ...drift.summary, globalPrefix: prefix.summary.globalPrefix },
    };
  }
  if (only === "all" || only === "mobile") {
    checks.mobile = checkMobileDocs(root);
  }
  if (only === "all" || only === "env") {
    checks.env = checkEnvPrecedence(root);
  }
  if (only === "all" || only === "payment-intents") {
    checks["payment-intents"] = checkPaymentIntentLifecycle(root);
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
  const options = { only: "all", json: false, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--only") {
      options.only = argv[index + 1];
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
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

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(
      `usage: node scripts/docs-check/check.mjs [--only ${VALID_TARGETS.join("|")}] [--json] [--quiet]\n`,
    );
    return 0;
  }
  if (options.unknown || !VALID_TARGETS.includes(options.only)) {
    process.stderr.write(`unknown argument or target: ${options.unknown ?? options.only}\n`);
    return 2;
  }

  const report = runCheck(REPO_ROOT, { only: options.only });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const [name, result] of Object.entries(report.checks)) {
      process.stdout.write(
        `${result.errors.length === 0 ? "PASS" : "FAIL"} ${name}: ${result.errors.length} error(s), ${result.warnings.length} warning(s)\n`,
      );
      for (const message of result.errors) process.stdout.write(`  x ${message}\n`);
      if (!options.quiet) {
        for (const message of result.warnings) process.stdout.write(`  ! ${message}\n`);
      }
    }
    process.stdout.write(
      report.ok
        ? "\ndocs gate: PASS\n"
        : `\ndocs gate: FAIL (${report.errors.length} error(s))\n`,
    );
  }

  return report.ok ? 0 : 1;
}

const isEntryPoint =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");

if (isEntryPoint) {
  process.exitCode = main();
}
