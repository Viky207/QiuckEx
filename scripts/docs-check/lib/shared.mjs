/**
 * Shared helpers for the QuickEx documentation gate.
 *
 * Zero dependencies on purpose: the gate must run in CI and on a fresh clone
 * before `pnpm install`, and it must never execute repository code.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root (…/QiuckEx), derived from this file's location. */
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

export const PATHS = {
  openapi: "docs/openapi.json",
  apiReference: "docs/PUBLIC-API-REFERENCE.md",
  contractMap: "docs/BACKEND-CLIENT-CONTRACT-MAP.md",
  capabilityMap: "docs/CAPABILITY-MAP.md",
  mainEntry: "app/backend/src/main.ts",
  controllers: "app/backend/src",
  mobileReadme: "app/mobile/README.md",
  mobileConfig: "app/mobile/app.config.ts",
  scorecardGenerator: "scripts/generate-release-scorecard.mjs",
  scorecardGuide: "docs/RELEASE-SCORECARD-GUIDE.md",
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
  try {
    return statSync(fromRoot(root, relative)).isFile();
  } catch {
    return false;
  }
}

/** Every `*.controller.ts` under a directory, repo-relative and sorted. */
export function listControllerFiles(root, dir = PATHS.controllers) {
  const base = fromRoot(root, dir);
  const found = [];
  const walk = (absolute, relative) => {
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childAbsolute = join(absolute, entry.name);
      const childRelative = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(childAbsolute, childRelative);
      else if (entry.name.endsWith(".controller.ts")) found.push(childRelative);
    }
  };
  walk(base, dir);
  return found;
}

export function unique(values) {
  return [...new Set(values)];
}

/** Every `##` heading in a markdown document, in order. */
export function headings(markdown) {
  return markdown
    .split("\n")
    .map((line) => line.match(/^##\s+(.*?)\s*$/))
    .filter(Boolean)
    .map((match) => match[1].trim());
}

/** Required `##` sections, matched by leading identifier (e.g. "5."). */
export function missingSections(markdown, required) {
  const found = headings(markdown);
  return required.filter((needed) => {
    return !found.some(
      (heading) =>
        heading === needed ||
        heading.startsWith(needed) ||
        heading.replace(/^[0-9]+\.\s*/, "") === needed.replace(/^[0-9]+\.\s*/, ""),
    );
  });
}

/**
 * Field names emitted by the release scorecard generator.
 *
 * The generator is parsed as text (never imported) so the docs gate keeps its
 * zero-execution guarantee. Only `name: "<identifier>"` object literals are
 * considered, which is how the generator declares every scorecard field.
 */
export function scorecardFieldNames(source) {
  const names = [];
  const pattern = /\bname:\s*["']([A-Za-z][A-Za-z0-9_]*)["']/g;
  let match;
  while ((match = pattern.exec(source)) !== null) names.push(match[1]);
  return unique(names);
}

/**
 * Scorecard fields that are not documented in the guide.
 *
 * A field counts as documented when the guide mentions it as inline code
 * (`` `field` ``) or as a table cell / heading token, so the guide can link
 * each field to its generating check without a rigid layout.
 */
export function undocumentedScorecardFields(guide, fields) {
  return fields.filter((field) => {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(guide);
  });
}

/**
 * Threshold statements the guide must make, expressed as regexes so wording
 * can evolve while the semantics stay pinned.
 */
export const SCORECARD_THRESHOLD_RULES = [
  {
    id: "pass-threshold",
    description: "states the PASS score threshold",
    pattern: /PASS[\s\S]{0,120}?(?:>=|≥|at least|minimum of)\s*90\b/i,
  },
  {
    id: "warn-threshold",
    description: "states the WARN score band",
    pattern: /WARN[\s\S]{0,120}?(?:>=|≥|at least|minimum of)\s*70\b/i,
  },
  {
    id: "blocked-threshold",
    description: "states the BLOCKED score boundary",
    pattern: /BLOCKED[\s\S]{0,120}?(?:<|below|under|less than)\s*70\b/i,
  },
  {
    id: "grade-thresholds",
    description: "states the A/B/C/D grade thresholds",
    pattern: /grade[\s\S]{0,200}?A[\s\S]{0,40}?90[\s\S]{0,80}?B[\s\S]{0,40}?80[\s\S]{0,80}?C[\s\S]{0,40}?70/i,
  },
];

/** Threshold rules the guide does not satisfy. */
export function missingScorecardThresholds(guide) {
  return SCORECARD_THRESHOLD_RULES.filter((rule) => !rule.pattern.test(guide));
}
