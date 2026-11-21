#!/usr/bin/env node
/**
 * Least-privilege GITHUB_TOKEN permission gate for GitHub Actions workflows.
 *
 * Every workflow must declare an empty workflow-level `permissions: {}` and
 * every job must declare its exact effective scopes. This prevents a
 * workflow-wide write token from leaking into validation jobs, and makes a
 * newly added write scope fail CI until it is deliberately approved in the
 * policy below.
 *
 * Dependency-free and offline: it parses the small YAML subset used by
 * workflow files (mappings, sequences, block scalars, quoted/plain scalars).
 *
 * Usage:
 *   node scripts/check-workflow-permissions.js [workflows-directory]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');

const READ = { contents: 'read' };
// Jobs that neither check out code nor call a GitHub API need no token scopes.
const NONE = {};

/**
 * The single source of truth for expected *effective* job permissions.
 * `write` is only allowed where a job publishes results, comments on a PR,
 * merges a dependency update, uploads SARIF, or deploys a preview/site.
 */
const EXPECTED_JOB_PERMISSIONS = {
  'backend.yml': {
    'build-and-test': READ,
    'payment-lifecycle-integration': READ,
  },
  'cd.yml': {
    'build-and-push-image': READ,
    'rc-validate': READ,
    'migration-smoke-test': READ,
    release: READ,
  },
  'ci.yml': {
    'workflow-permissions': READ,
    backend: READ,
    'migration-smoke-test': READ,
    'docs-gate': READ,
    frontend: READ,
    'secret-scan': READ,
    scorecard: READ,
  },
  'codeql-analysis.yml': {
    analyze: { actions: 'read', contents: 'read', 'security-events': 'write' },
  },
  'contract.yml': {
    test: READ,
    'upgrade-regression': READ,
    security: READ,
    'mainnet-gate': READ,
    deploy: NONE,
  },
  'dependency-review.yml': {
    'dependency-review': { contents: 'read', 'pull-requests': 'write' },
  },
  'dependabot-auto-merge.yml': {
    'auto-merge': { contents: 'write', 'pull-requests': 'write' },
  },
  'frontend-ci.yml': {
    'lint-and-test': READ,
    'visual-regression': READ,
  },
  'mobile-release.yml': {
    'production-release': READ,
    'environment-matrix': READ,
    'maestro-android': READ,
  },
  'rc-validate.yml': {
    validate: READ,
    'load-test': READ,
  },
  'secret-scanning.yml': {
    'detect-secrets': READ,
    gitleaks: { contents: 'read', 'pull-requests': 'write' },
    'env-guard': READ,
  },
  'smoke-tests.yml': {
    'smoke-tests': READ,
  },
  'soroban-e2e.yml': {
    'e2e-testnet': READ,
  },
  'staging-preview.yml': {
    guard: NONE,
    deploy: { contents: 'read', 'pull-requests': 'write' },
    teardown: NONE,
  },
  'storybook.yml': {
    build: READ,
    deploy: { pages: 'write', 'id-token': 'write' },
  },
  'sync-labels.yml': {
    sync: { contents: 'read', issues: 'write' },
  },
};

function stripComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === '\\' && quote === '"') {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseScalar(rawValue) {
  const value = stripComment(rawValue).trim();
  if (value === '') return '';
  if (value === '{}') return {};
  if (value === '[]') return [];
  if (value.startsWith('{') && value.endsWith('}')) {
    const result = {};
    const inner = value.slice(1, -1).trim();
    if (!inner) return result;
    for (const entry of inner.split(',')) {
      const separator = entry.indexOf(':');
      if (separator === -1) throw new Error(`invalid inline mapping: ${value}`);
      result[unquote(entry.slice(0, separator).trim())] = parseScalar(
        entry.slice(separator + 1),
      );
    }
    return result;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  return unquote(value);
}

function parseKeyValue(content) {
  const match = /^("[^"]+"|'[^']+'|[^:]+):(?:\s+(.*))?$/.exec(content);
  if (!match) return null;
  return { key: unquote(match[1].trim()), value: (match[2] ?? '').trim() };
}

function nextSignificant(lines, start) {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    return { index, indent: line.length - line.trimStart().length, line: line.trim() };
  }
  return null;
}

function isBlockScalar(value) {
  return /^[|>][+-]?\d*$/.test(value);
}

/**
 * Parse the YAML subset used by this repository's workflow files. This is
 * intentionally small: it only needs mappings, sequences, inline maps and
 * block scalars, not anchors or multi-document streams.
 */
function parseWorkflowYaml(source, label = 'workflow') {
  const lines = source.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, value: root }];

  const popTo = (indent) => {
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;

    const indent = raw.length - raw.trimStart().length;
    const content = raw.trim();

    if (content === '-' || content.startsWith('- ')) {
      popTo(indent);
      const parent = stack[stack.length - 1].value;
      if (!Array.isArray(parent)) {
        throw new Error(`${label}:${index + 1} sequence item outside a sequence`);
      }
      const rest = content === '-' ? '' : content.slice(2).trim();
      if (isBlockScalar(rest)) {
        parent.push(rest);
        while (index + 1 < lines.length) {
          const next = lines[index + 1];
          if (next.trim() !== '' && next.length - next.trimStart().length <= indent) break;
          index += 1;
        }
        continue;
      }
      const entry = parseKeyValue(rest);
      if (!entry) {
        parent.push(parseScalar(rest));
        continue;
      }
      const item = {};
      parent.push(item);
      if (entry.value === '') {
        const peek = nextSignificant(lines, index + 1);
        const child = peek && peek.indent > indent && peek.line.startsWith('- ') ? [] : {};
        item[entry.key] = child;
        stack.push({ indent, value: child });
      } else {
        item[entry.key] = parseScalar(entry.value);
        stack.push({ indent, value: item });
      }
      continue;
    }

    const entry = parseKeyValue(content);
    if (!entry) {
      throw new Error(`${label}:${index + 1} unsupported YAML line: ${content}`);
    }

    popTo(indent);
    const parent = stack[stack.length - 1].value;
    if (!isPlainObject(parent)) {
      throw new Error(`${label}:${index + 1} mapping key outside a mapping`);
    }

    if (entry.value === '' || isBlockScalar(entry.value)) {
      const peek = nextSignificant(lines, index + 1);
      const child =
        peek && peek.indent > indent && (peek.line === '-' || peek.line.startsWith('- '))
          ? []
          : {};
      parent[entry.key] = child;
      stack.push({ indent, value: child });
      if (isBlockScalar(entry.value)) {
        while (index + 1 < lines.length) {
          const next = lines[index + 1];
          if (next.trim() !== '' && next.length - next.trimStart().length <= indent) break;
          index += 1;
        }
      }
    } else {
      parent[entry.key] = parseScalar(entry.value);
    }
  }

  return root;
}

function formatPermissions(permissions) {
  if (!isPlainObject(permissions)) return String(permissions);
  const entries = Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '{}';
  return `{ ${entries.map(([scope, level]) => `${scope}: ${level}`).join(', ')} }`;
}

function normalizePermissions(value, label, errors) {
  if (value === undefined) {
    errors.push(`${label}: permissions block is missing`);
    return null;
  }
  if (!isPlainObject(value)) {
    errors.push(`${label}: permissions must be an explicit mapping, got '${String(value)}'`);
    return null;
  }

  const normalized = {};
  for (const [scope, level] of Object.entries(value)) {
    if (!['read', 'write', 'none'].includes(level)) {
      errors.push(`${label}: permission '${scope}' has invalid level '${String(level)}'`);
      continue;
    }
    normalized[scope] = level;
  }
  return normalized;
}

function hasWrite(permissions) {
  return Object.values(permissions ?? {}).includes('write');
}

function validateWorkflowFiles(files, { requireAllWorkflows = true, requireAllJobs = true } = {}) {
  const errors = [];
  const declaredWorkflows = new Set(Object.keys(EXPECTED_JOB_PERMISSIONS));

  for (const [fileName, source] of Object.entries(files)) {
    const label = `.github/workflows/${fileName}`;
    let workflow;
    try {
      workflow = parseWorkflowYaml(source, label);
    } catch (error) {
      errors.push(error.message);
      continue;
    }

    const workflowPermissions = normalizePermissions(workflow.permissions, label, errors);
    if (workflowPermissions && Object.keys(workflowPermissions).length > 0) {
      errors.push(
        `${label}: workflow-level permissions must be {} so no job inherits ${
          hasWrite(workflowPermissions) ? 'write' : 'extra'
        } access (found ${formatPermissions(workflowPermissions)})`,
      );
    }

    const jobs = workflow.jobs;
    if (!isPlainObject(jobs)) {
      errors.push(`${label}: jobs mapping is missing`);
      continue;
    }

    const expectedJobs = EXPECTED_JOB_PERMISSIONS[fileName];
    if (!expectedJobs) {
      errors.push(`${label}: workflow is not declared in the permission policy`);
      continue;
    }
    declaredWorkflows.delete(fileName);

    for (const [jobId, job] of Object.entries(jobs)) {
      const jobLabel = `${label}/${jobId}`;
      if (!isPlainObject(job)) {
        errors.push(`${jobLabel}: job definition must be a mapping`);
        continue;
      }
      const actual = normalizePermissions(job.permissions, jobLabel, errors);
      const expected = expectedJobs[jobId];
      if (!expected) {
        errors.push(`${jobLabel}: job is not declared in the permission policy`);
        continue;
      }
      if (!actual) continue;

      // GitHub applies job-level permissions in place of workflow-level ones.
      // With an empty workflow default, the effective token is exactly this map.
      const unexpectedWrites = Object.entries(actual)
        .filter(([scope, level]) => level === 'write' && expected[scope] !== 'write')
        .map(([scope]) => scope);
      if (unexpectedWrites.length > 0) {
        errors.push(
          `${jobLabel}: unexpected write scope(s) ${unexpectedWrites.join(', ')}; ${
            hasWrite(expected) ? 'only pre-approved publish/write jobs may request write access' : 'read-only jobs must not receive write access'
          }`,
        );
      }

      const sameKeys =
        Object.keys(actual).length === Object.keys(expected).length &&
        Object.keys(expected).every((scope) => actual[scope] === expected[scope]);
      if (!sameKeys) {
        errors.push(
          `${jobLabel}: effective permissions ${formatPermissions(actual)} do not match policy ${formatPermissions(expected)}`,
        );
      }
    }

    if (requireAllJobs) {
      for (const jobId of Object.keys(expectedJobs)) {
        if (!Object.hasOwn(jobs, jobId)) {
          errors.push(`${label}: policy declares job '${jobId}' but the workflow no longer does`);
        }
      }
    }
  }

  if (requireAllWorkflows) {
    for (const fileName of declaredWorkflows) {
      errors.push(`.github/workflows/${fileName}: declared in the permission policy but no workflow file was checked`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateWorkflowDirectory(directory = WORKFLOWS_DIR) {
  const files = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    files[entry.name] = fs.readFileSync(path.join(directory, entry.name), 'utf8');
  }
  return validateWorkflowFiles(files);
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'usage: node scripts/check-workflow-permissions.js [workflows-directory]\n',
    );
    return 0;
  }
  const directory = path.resolve(argv[0] ?? WORKFLOWS_DIR);
  const report = validateWorkflowDirectory(directory);
  if (!report.ok) {
    for (const error of report.errors) process.stderr.write(`FAIL ${error}\n`);
    process.stderr.write(`workflow permissions: FAIL (${report.errors.length} error(s))\n`);
    return 1;
  }
  const jobCount = Object.values(EXPECTED_JOB_PERMISSIONS).reduce(
    (total, jobs) => total + Object.keys(jobs).length,
    0,
  );
  process.stdout.write(
    `workflow permissions: PASS (${Object.keys(EXPECTED_JOB_PERMISSIONS).length} workflows, ${jobCount} jobs)\n`,
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  EXPECTED_JOB_PERMISSIONS,
  parseWorkflowYaml,
  validateWorkflowDirectory,
  validateWorkflowFiles,
  main,
};
