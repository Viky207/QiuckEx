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
  accessibilityGuide: "docs/ACCESSIBILITY-TESTING-GUIDE.md",
  glossary: "docs/GLOSSARY.md",
  troubleshootingGuide: "docs/API-TROUBLESHOOTING-GUIDE.md",
  privacyFieldInventory: "docs/PRIVACY-FIELD-INVENTORY.md",
};

/**
 * Required `##` sections for the webhook consumer quickstart.
 *
 * The quickstart must cover endpoint setup, signature verification (including
 * a negative example), idempotent processing, retry behavior, and a local test
 * event. Section identifiers are matched by leading number via
 * `missingSections`, so renumbering does not break the gate.
 */
export const WEBHOOK_QUICKSTART_SECTIONS = [
  "Endpoint setup",
  "Signature verification",
  "Negative example",
  "Idempotent processing",
  "Retry behavior",
  "Local test event",
];

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

/**
 * Extract fenced code blocks from a markdown document.
 *
 * Returns blocks in document order with the fence info string (e.g. "json"),
 * the 1-based line number of the opening fence, and the raw body. An unclosed
 * fence is reported via `problems` rather than thrown so the gate can list
 * every issue at once.
 *
 * @returns {{ blocks: Array<{info: string, line: number, body: string}>, problems: string[] }}
 */
export function fencedBlocks(markdown) {
  const blocks = [];
  const problems = [];
  const lines = markdown.split("\n");

  let open = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*(.*?)\s*$/);
    if (!fence) {
      if (open) open.body.push(line);
      continue;
    }
    if (!open) {
      open = { marker: fence[1][0], info: fence[2], line: index + 1, body: [] };
      continue;
    }
    if (fence[1][0] === open.marker) {
      blocks.push({ info: open.info, line: open.line, body: open.body.join("\n") });
      open = null;
    } else {
      open.body.push(line);
    }
  }
  if (open) problems.push(`Unclosed code fence opened at line ${open.line}.`);

  return { blocks, problems };
}

/**
 * Parse every fenced JSON example in a markdown document.
 *
 * A block is treated as JSON when its info string is `json` (optionally with
 * extra attributes). Blocks that fail to parse are reported via `problems`
 * with their line number instead of aborting the whole check.
 *
 * @returns {{ examples: Array<{line: number, value: unknown}>, problems: string[] }}
 */
export function jsonExamples(markdown) {
  const { blocks, problems } = fencedBlocks(markdown);
  const examples = [];
  for (const block of blocks) {
    if (!/^json\b/i.test(block.info)) continue;
    try {
      examples.push({ line: block.line, value: JSON.parse(block.body) });
    } catch (error) {
      problems.push(`Invalid JSON example at line ${block.line}: ${error.message}`);
    }
  }
  return { examples, problems };
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
 * Parse glossary entries from a markdown document.
 *
 * Each entry is a `###` heading (the preferred term) followed by a body that
 * must contain a "Preferred definition:" line and a canonical link, either as
 * a markdown link (`[label](target)`) or a bare URL. Entries are returned in
 * document order; malformed entries are reported via `problems` rather than
 * thrown so the gate can list every issue at once.
 *
 * @returns {{ entries: Array<{term: string, definition: string, link: string}>, problems: string[] }}
 */
export function parseGlossary(markdown) {
  const entries = [];
  const problems = [];
  const lines = markdown.split("\n");

  let current = null;
  const flush = () => {
    if (!current) return;
    const { term, body } = current;
    const definitionLine = body.find((line) => /^\s*Preferred definition:/i.test(line));
    const definition = definitionLine
      ? definitionLine.replace(/^\s*Preferred definition:\s*/i, "").trim()
      : "";
    const linkLine = body.find((line) => /\[[^\]]+\]\([^)]+\)/.test(line) || /https?:\/\/\S+/.test(line));
    let link = "";
    if (linkLine) {
      const markdownLink = linkLine.match(/\[[^\]]+\]\(([^)]+)\)/);
      const bareUrl = linkLine.match(/https?:\/\/\S+/);
      link = (markdownLink ? markdownLink[1] : bareUrl ? bareUrl[0] : "").trim();
    }
    if (!definition) problems.push(`Glossary term "${term}" is missing a preferred definition.`);
    if (!link) problems.push(`Glossary term "${term}" is missing a canonical link.`);
    entries.push({ term, definition, link });
    current = null;
  };

  for (const line of lines) {
    const heading = line.match(/^###\s+(.*?)\s*$/);
    if (heading) {
      flush();
      current = { term: heading[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();

  return { entries, problems };
}
