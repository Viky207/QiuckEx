import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const RETENTION_SCHEDULE_PATH = 'docs/policies/data/retention-schedule.json';
const FIELD_INVENTORY_PATH = 'docs/PRIVACY-FIELD-INVENTORY.md';

const REQUIRED_FIELD_SECTIONS = [
  'data category',
  'purpose',
  'retention policy',
  'deletion behavior',
];

const KNOWN_FIELD_GROUPS = [
  'profile',
  'payment',
  'telemetry',
  'audit',
  'crash-report',
  'privacy-event',
  'key-rotation',
];

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readOptionalFile(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function extractRetentionCategories(schedule) {
  const categories = new Set();

  const visit = (node) => {
    if (node == null) {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (typeof node === 'object') {
      if (typeof node.category === 'string' && node.category.trim()) {
        categories.add(node.category.trim());
      }
      if (typeof node.id === 'string' && node.id.trim()) {
        categories.add(node.id.trim());
      }
      if (typeof node.name === 'string' && node.name.trim()) {
        categories.add(node.name.trim());
      }
      for (const value of Object.values(node)) {
        visit(value);
      }
      return;
    }
    if (typeof node === 'string' && node.trim()) {
      categories.add(node.trim());
    }
  };

  visit(schedule);
  return categories;
}

function parseInventorySections(markdown) {
  const sections = new Map();
  const lines = markdown.split(/\r?\n/);

  let currentHeading = null;
  let currentBody = [];

  const flush = () => {
    if (currentHeading != null) {
      const key = normalize(currentHeading);
      const existing = sections.get(key) ?? '';
      sections.set(key, `${existing}\n${currentBody.join('\n')}`.trim());
    }
    currentHeading = null;
    currentBody = [];
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[2].trim();
      continue;
    }
    if (currentHeading != null) {
      currentBody.push(line);
    }
  }
  flush();

  return sections;
}

function sectionMentionsField(body, field) {
  const normalizedBody = normalize(body);
  const normalizedField = normalize(field);
  if (!normalizedField) {
    return false;
  }
  if (normalizedBody.includes(normalizedField)) {
    return true;
  }
  const tokens = normalizedField.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }
  return tokens.every((token) => normalizedBody.includes(token));
}

function sectionHasRequiredAttributes(body) {
  const normalizedBody = normalize(body);
  const missing = REQUIRED_FIELD_SECTIONS.filter(
    (attribute) => !normalizedBody.includes(attribute),
  );
  return { ok: missing.length === 0, missing };
}

function findFieldSection(sections, field) {
  const normalizedField = normalize(field);
  for (const [key, body] of sections.entries()) {
    if (key === normalizedField || key.includes(normalizedField)) {
      return { key, body };
    }
  }
  for (const [key, body] of sections.entries()) {
    if (sectionMentionsField(body, field)) {
      return { key, body };
    }
  }
  return null;
}

function collectKnownFields(schedule) {
  const fields = new Set();

  const visit = (node) => {
    if (node == null) {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (typeof node === 'object') {
      if (Array.isArray(node.fields)) {
        for (const field of node.fields) {
          if (typeof field === 'string' && field.trim()) {
            fields.add(field.trim());
          } else if (field && typeof field === 'object') {
            const name = field.name ?? field.field ?? field.id;
            if (typeof name === 'string' && name.trim()) {
              fields.add(name.trim());
            }
          }
        }
      }
      for (const value of Object.values(node)) {
        visit(value);
      }
    }
  };

  visit(schedule);
  return fields;
}

function collectInventoryFieldHeadings(sections) {
  const headings = new Set();
  for (const key of sections.keys()) {
    headings.add(key);
  }
  return headings;
}

export async function checkPrivacyFieldInventory(root) {
  const errors = [];
  const warnings = [];
  const summary = {
    retentionCategories: 0,
    documentedCategories: 0,
    knownFields: 0,
    documentedFields: 0,
    unknownFields: 0,
    missingAttributes: 0,
  };

  const schedulePath = join(root, RETENTION_SCHEDULE_PATH);
  const inventoryPath = join(root, FIELD_INVENTORY_PATH);

  const scheduleRaw = await readOptionalFile(schedulePath);
  if (scheduleRaw == null) {
    errors.push(`Missing retention schedule: ${RETENTION_SCHEDULE_PATH}`);
  }

  const inventoryRaw = await readOptionalFile(inventoryPath);
  if (inventoryRaw == null) {
    errors.push(`Missing field inventory: ${FIELD_INVENTORY_PATH}`);
  }

  if (scheduleRaw == null || inventoryRaw == null) {
    return { errors, warnings, summary };
  }

  let schedule;
  try {
    schedule = JSON.parse(scheduleRaw);
  } catch (error) {
    errors.push(
      `Invalid JSON in ${RETENTION_SCHEDULE_PATH}: ${error.message}`,
    );
    return { errors, warnings, summary };
  }

  const sections = parseInventorySections(inventoryRaw);
  if (sections.size === 0) {
    errors.push(
      `Field inventory ${FIELD_INVENTORY_PATH} contains no sections to validate`,
    );
  }

  const retentionCategories = extractRetentionCategories(schedule);
  summary.retentionCategories = retentionCategories.size;

  for (const category of retentionCategories) {
    const section = findFieldSection(sections, category);
    if (!section) {
      errors.push(
        `Retention category "${category}" is not documented in ${FIELD_INVENTORY_PATH}`,
      );
      continue;
    }
    summary.documentedCategories += 1;
    const attributes = sectionHasRequiredAttributes(section.body);
    if (!attributes.ok) {
      summary.missingAttributes += 1;
      errors.push(
        `Retention category "${category}" is missing required attributes: ${attributes.missing.join(', ')}`,
      );
    }
  }

  const knownFields = collectKnownFields(schedule);
  summary.knownFields = knownFields.size;

  for (const field of knownFields) {
    const section = findFieldSection(sections, field);
    if (!section) {
      errors.push(
        `Known field "${field}" is not documented in ${FIELD_INVENTORY_PATH}`,
      );
      continue;
    }
    summary.documentedFields += 1;
    const attributes = sectionHasRequiredAttributes(section.body);
    if (!attributes.ok) {
      summary.missingAttributes += 1;
      errors.push(
        `Known field "${field}" is missing required attributes: ${attributes.missing.join(', ')}`,
      );
    }
  }

  const inventoryHeadings = collectInventoryFieldHeadings(sections);
  const knownFieldKeys = new Set();
  for (const field of knownFields) {
    knownFieldKeys.add(normalize(field));
  }
  for (const category of retentionCategories) {
    knownFieldKeys.add(normalize(category));
  }
  for (const group of KNOWN_FIELD_GROUPS) {
    knownFieldKeys.add(normalize(group));
  }

  for (const heading of inventoryHeadings) {
    if (!heading) {
      continue;
    }
    const isKnown = [...knownFieldKeys].some(
      (known) => known && (heading === known || heading.includes(known) || known.includes(heading)),
    );
    if (!isKnown) {
      summary.unknownFields += 1;
      warnings.push(
        `Field inventory section "${heading}" is not present in the retention schedule; flag for review`,
      );
    }
  }

  return { errors, warnings, summary };
}

export default checkPrivacyFieldInventory;