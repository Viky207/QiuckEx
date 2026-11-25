// scripts/docs-check/lib/troubleshooting.mjs
//
// Validates docs/TROUBLESHOOTING.md against the canonical error registry.
//
// The troubleshooting guide is keyed by stable, public API error codes. This
// module ensures that:
//   - every public stable error code has a guide entry with a likely cause,
//     a safe user action, and an operator escalation path;
//   - no internal-only codes leak into the public guide;
//   - codes found in the guide that are not in the registry are surfaced as
//     warnings (rather than silently passing) so drift is visible.
//
// It returns `{ errors, warnings, summary }`, consistent with the other
// docs-check modules.

import fs from "node:fs";
import path from "node:path";

const GUIDE_RELATIVE_PATH = path.join("docs", "TROUBLESHOOTING.md");

// Candidate locations for the canonical error registry. The first one that
// exists and yields codes wins. These are intentionally conservative: we only
// read public, stable codes from these sources.
const REGISTRY_CANDIDATES = [
  path.join("docs", "openapi.yaml"),
  path.join("docs", "openapi.yml"),
  path.join("docs", "openapi.json"),
  path.join("openapi.yaml"),
  path.join("openapi.yml"),
  path.join("openapi.json"),
  path.join("backend", "src", "errors", "registry.ts"),
  path.join("backend", "src", "errors", "registry.js"),
  path.join("backend", "src", "errors", "registry.mjs"),
  path.join("src", "errors", "registry.ts"),
  path.join("src", "errors", "registry.js"),
  path.join("src", "errors", "registry.mjs"),
];

// Sections that must be present for each code entry.
const REQUIRED_SECTIONS = [
  { key: "cause", label: "likely cause", patterns: [/likely\s+cause/i, /^cause\b/i] },
  { key: "action", label: "safe user action", patterns: [/safe\s+user\s+action/i, /user\s+action/i, /^action\b/i] },
  {
    key: "escalation",
    label: "operator escalation path",
    patterns: [/operator\s+escalation/i, /escalation\s+path/i, /^escalation\b/i],
  },
];

function readFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function findRegistryFile(root) {
  for (const candidate of REGISTRY_CANDIDATES) {
    const fullPath = path.join(root, candidate);
    const content = readFileIfExists(fullPath);
    if (content != null) {
      return { fullPath, content };
    }
  }
  return null;
}

// Extract error codes from an OpenAPI document. We look for enum values under
// schemas/properties whose name suggests an error code, and also accept a
// top-level `x-error-codes` extension. Only codes marked public/stable are
// considered; anything explicitly marked internal is excluded.
function extractCodesFromOpenApi(content, filePath) {
  const codes = new Set();
  const internal = new Set();

  let doc;
  try {
    doc = JSON.parse(content);
  } catch {
    // Not JSON; attempt a lightweight YAML scan below.
    doc = null;
  }

  if (doc && typeof doc === "object") {
    collectFromObject(doc, codes, internal);
    return { codes, internal };
  }

  // Lightweight YAML scan: find enum blocks and error-code-like string values.
  // This is intentionally permissive; the registry is the source of truth and
  // unknown codes are reported as warnings downstream.
  const lines = content.split(/\r?\n/);
  let inEnum = false;
  let enumIndent = 0;
  for (const line of lines) {
    const enumMatch = line.match(/^(\s*)enum\s*:\s*$/);
    if (enumMatch) {
      inEnum = true;
      enumIndent = enumMatch[1].length;
      continue;
    }
    if (inEnum) {
      const itemMatch = line.match(/^(\s*)-\s*["']?([A-Z][A-Z0-9_]+)["']?\s*$/);
      if (itemMatch && itemMatch[1].length > enumIndent) {
        codes.add(itemMatch[2]);
        continue;
      }
      if (line.trim() !== "" && !/^\s*-/.test(line)) {
        inEnum = false;
      }
    }
  }

  // Also pick up explicit internal markers in YAML.
  const internalMatches = content.matchAll(/internal[^\n]*?([A-Z][A-Z0-9_]{2,})/g);
  for (const m of internalMatches) {
    internal.add(m[1]);
  }

  return { codes, internal };
}

function collectFromObject(node, codes, internal, keyHint = "") {
  if (node == null || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectFromObject(item, codes, internal, keyHint);
    }
    return;
  }

  const looksLikeErrorCodeKey = /error.?code/i.test(keyHint);

  for (const [key, value] of Object.entries(node)) {
    if (key === "enum" && Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === "string" && /^[A-Z][A-Z0-9_]+$/.test(v)) {
          if (looksLikeErrorCodeKey || /error/i.test(keyHint)) {
            codes.add(v);
          }
        }
      }
      continue;
    }

    if (key === "x-error-codes" && Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          codes.add(entry);
        } else if (entry && typeof entry === "object" && typeof entry.code === "string") {
          const isInternal = entry.internal === true || entry.visibility === "internal";
          if (isInternal) {
            internal.add(entry.code);
          } else {
            codes.add(entry.code);
          }
        }
      }
      continue;
    }

    if (key === "x-internal-error-codes" && Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          internal.add(entry);
        }
      }
      continue;
    }

    collectFromObject(value, codes, internal, key);
  }
}

// Extract codes from a backend error registry module. We look for object
// literals keyed by code, and for `code: "..."` / `code: '...'` fields, plus
// explicit visibility markers.
function extractCodesFromRegistry(content) {
  const codes = new Set();
  const internal = new Set();

  // Match `CODE_NAME: { ... }` style keys.
  const keyMatches = content.matchAll(/["']?([A-Z][A-Z0-9_]{2,})["']?\s*:\s*\{/g);
  for (const m of keyMatches) {
    codes.add(m[1]);
  }

  // Match `code: "CODE_NAME"` fields.
  const codeFieldMatches = content.matchAll(/code\s*:\s*["']([A-Z][A-Z0-9_]{2,})["']/g);
  for (const m of codeFieldMatches) {
    codes.add(m[1]);
  }

  // Detect internal-only markers near codes.
  const internalBlocks = content.matchAll(
    /["']?([A-Z][A-Z0-9_]{2,})["']?\s*:\s*\{[^}]*?(?:internal\s*:\s*true|visibility\s*:\s*["']internal["'])/gs,
  );
  for (const m of internalBlocks) {
    internal.add(m[1]);
  }

  return { codes, internal };
}

function loadRegistry(root) {
  const found = findRegistryFile(root);
  if (!found) {
    return { codes: new Set(), internal: new Set(), source: null };
  }

  const isOpenApi = /openapi\.(ya?ml|json)$/i.test(found.fullPath);
  const extracted = isOpenApi
    ? extractCodesFromOpenApi(found.content, found.fullPath)
    : extractCodesFromRegistry(found.content);

  // Public stable codes are those in the registry minus internal-only ones.
  const publicCodes = new Set();
  for (const code of extracted.codes) {
    if (!extracted.internal.has(code)) {
      publicCodes.add(code);
    }
  }

  return {
    codes: publicCodes,
    internal: extracted.internal,
    source: path.relative(root, found.fullPath),
  };
}

// Parse the troubleshooting guide into a map of code -> entry.
//
// Expected shape (flexible):
//
//   ## CODE_NAME
//
//   **Likely cause:** ...
//   **Safe user action:** ...
//   **Operator escalation path:** ...
//
// Headings may be `##`, `###`, or `####`. Section labels may be bold, plain,
// or list items. We capture the raw text of each section so we can validate
// presence and non-emptiness.
function parseGuide(content) {
  const entries = new Map();
  const lines = content.split(/\r?\n/);

  let currentCode = null;
  let currentEntry = null;
  let currentSection = null;

  const headingRegex = /^(#{2,4})\s+(.+?)\s*$/;
  const codeHeadingRegex = /^([A-Z][A-Z0-9_]{2,})\b/;

  const flush = () => {
    if (currentCode && currentEntry) {
      entries.set(currentCode, currentEntry);
    }
    currentCode = null;
    currentEntry = null;
    currentSection = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    const heading = line.match(headingRegex);
    if (heading) {
      const title = heading[2].trim();
      const codeMatch = title.match(codeHeadingRegex);
      if (codeMatch) {
        flush();
        currentCode = codeMatch[1];
        currentEntry = {
          code: currentCode,
          title,
          sections: { cause: "", action: "", escalation: "" },
          raw: [],
        };
        continue;
      }
      // A non-code heading ends the current entry.
      flush();
      continue;
    }

    if (!currentEntry) {
      continue;
    }

    currentEntry.raw.push(line);

    // Detect section labels.
    const labelMatch = line.match(/^\s*(?:[-*]\s*)?(?:\*\*|__)?\s*([A-Za-z][A-Za-z ]+?)\s*(?:\*\*|__)?\s*:\s*(.*)$/);
    if (labelMatch) {
      const label = labelMatch[1].trim();
      const value = labelMatch[2].trim();
      for (const section of REQUIRED_SECTIONS) {
        if (section.patterns.some((re) => re.test(label))) {
          currentSection = section.key;
          currentEntry.sections[section.key] = value;
          break;
        }
      }
      continue;
    }

    // Continuation lines for the current section.
    if (currentSection && line.trim() !== "") {
      const existing = currentEntry.sections[currentSection];
      currentEntry.sections[currentSection] = existing ? `${existing}\n${line.trim()}` : line.trim();
    }
  }

  flush();
  return entries;
}

function isNonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function checkTroubleshootingGuide(root = process.cwd()) {
  const errors = [];
  const warnings = [];

  const guidePath = path.join(root, GUIDE_RELATIVE_PATH);
  const guideContent = readFileIfExists(guidePath);

  if (guideContent == null) {
    errors.push({
      code: "TROUBLESHOOTING_GUIDE_MISSING",
      message: `Troubleshooting guide not found at ${GUIDE_RELATIVE_PATH}.`,
      path: GUIDE_RELATIVE_PATH,
    });
    return {
      errors,
      warnings,
      summary: {
        guidePresent: false,
        registrySource: null,
        publicCodes: 0,
        documentedCodes: 0,
        missingCodes: 0,
        internalCodesInGuide: 0,
        unknownCodesInGuide: 0,
      },
    };
  }

  const registry = loadRegistry(root);
  if (!registry.source) {
    errors.push({
      code: "ERROR_REGISTRY_MISSING",
      message:
        "Could not locate the canonical error registry (OpenAPI document or backend error registry). " +
        "The troubleshooting guide cannot be validated without it.",
      path: GUIDE_RELATIVE_PATH,
    });
    return {
      errors,
      warnings,
      summary: {
        guidePresent: true,
        registrySource: null,
        publicCodes: 0,
        documentedCodes: 0,
        missingCodes: 0,
        internalCodesInGuide: 0,
        unknownCodesInGuide: 0,
      },
    };
  }

  const entries = parseGuide(guideContent);

  // 1. Every public stable code must have an entry with all required sections.
  const missingCodes = [];
  for (const code of registry.codes) {
    const entry = entries.get(code);
    if (!entry) {
      missingCodes.push(code);
      errors.push({
        code: "TROUBLESHOOTING_ENTRY_MISSING",
        message: `Public error code "${code}" has no entry in ${GUIDE_RELATIVE_PATH}.`,
        path: GUIDE_RELATIVE_PATH,
        errorCode: code,
      });
      continue;
    }

    for (const section of REQUIRED_SECTIONS) {
      if (!isNonEmpty(entry.sections[section.key])) {
        errors.push({
          code: "TROUBLESHOOTING_SECTION_MISSING",
          message: `Entry for "${code}" is missing the "${section.label}" section.`,
          path: GUIDE_RELATIVE_PATH,
          errorCode: code,
          section: section.key,
        });
      }
    }
  }

  // 2. No internal-only codes may appear in the public guide.
  const internalCodesInGuide = [];
  for (const code of entries.keys()) {
    if (registry.internal.has(code)) {
      internalCodesInGuide.push(code);
      errors.push({
        code: "TROUBLESHOOTING_INTERNAL_CODE",
        message: `Internal-only error code "${code}" must not appear in the public troubleshooting guide.`,
        path: GUIDE_RELATIVE_PATH,
        errorCode: code,
      });
    }
  }

  // 3. Codes in the guide that are not in the registry are warnings, not
  //    silent passes. This surfaces drift (new codes added to the guide before
  //    the registry, or typos) without failing the build outright.
  const unknownCodesInGuide = [];
  for (const code of entries.keys()) {
    if (registry.internal.has(code)) {
      continue;
    }
    if (!registry.codes.has(code)) {
      unknownCodesInGuide.push(code);
      warnings.push({
        code: "TROUBLESHOOTING_UNKNOWN_CODE",
        message:
          `Error code "${code}" appears in ${GUIDE_RELATIVE_PATH} but is not present in the ` +
          `canonical error registry (${registry.source}). Verify it is a public stable code.`,
        path: GUIDE_RELATIVE_PATH,
        errorCode: code,
      });
    }
  }

  return {
    errors,
    warnings,
    summary: {
      guidePresent: true,
      registrySource: registry.source,
      publicCodes: registry.codes.size,
      documentedCodes: entries.size,
      missingCodes: missingCodes.length,
      internalCodesInGuide: internalCodesInGuide.length,
      unknownCodesInGuide: unknownCodesInGuide.length,
    },
  };
}

export default checkTroubleshootingGuide;