const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  validateWorkflowDirectory,
  validateWorkflowFiles,
  parseWorkflowYaml,
} = require('./check-workflow-permissions');

const REPO_ROOT = path.resolve(__dirname, '..');

// Focused fixtures: requireAll* is disabled so a single job can be tested
// without restating every workflow in the repository.
function check(fileName, yaml) {
  return validateWorkflowFiles(
    { [fileName]: yaml },
    { requireAllWorkflows: false, requireAllJobs: false },
  );
}

function fixture({ workflowLine = 'permissions: {}', jobName, jobPermissions, step = 'run: echo ok' }) {
  return [
    'name: Fixture',
    'on: push',
    workflowLine,
    'jobs:',
    `  ${jobName}:`,
    '    runs-on: ubuntu-latest',
    ...(jobPermissions ?? []),
    '    steps:',
    `      - ${step}`,
    '',
  ].join('\n');
}

const READ_ONLY_JOB = ['    permissions:', '      contents: read'];
const NO_TOKEN_JOB = ['    permissions: {}'];
const PR_COMMENT_JOB = [
  '    permissions:',
  '      contents: read',
  '      pull-requests: write',
];

test('repository workflows satisfy the effective permission policy', () => {
  const report = validateWorkflowDirectory(
    path.join(REPO_ROOT, '.github', 'workflows'),
  );
  assert.deepEqual(report.errors, []);
  assert.equal(report.ok, true);
});

test('accepts a read-only job with no write scopes', () => {
  const report = check(
    'backend.yml',
    fixture({ jobName: 'build-and-test', jobPermissions: READ_ONLY_JOB }),
  );
  assert.equal(report.ok, true, report.errors.join('\n'));
});

test('accepts a job that needs no token scopes', () => {
  const report = check(
    'contract.yml',
    fixture({ jobName: 'deploy', jobPermissions: NO_TOKEN_JOB }),
  );
  assert.equal(report.ok, true, report.errors.join('\n'));
});

test('rejects workflow-wide write permissions even when the job is read-only', () => {
  const report = check(
    'backend.yml',
    fixture({
      workflowLine: 'permissions:\n  contents: write',
      jobName: 'build-and-test',
      jobPermissions: READ_ONLY_JOB,
    }),
  );
  assert.match(report.errors.join('\n'), /workflow-level permissions must be \{\}/);
  assert.match(report.errors.join('\n'), /inherits write access/);
});

test('rejects a job that omits its own permissions block', () => {
  const report = check(
    'backend.yml',
    fixture({ jobName: 'build-and-test', jobPermissions: [] }),
  );
  assert.match(report.errors.join('\n'), /permissions block is missing/);
});

test('rejects unexpected write scopes on a read-only job', () => {
  const report = check(
    'backend.yml',
    fixture({
      jobName: 'build-and-test',
      jobPermissions: ['    permissions:', '      contents: read', '      actions: write'],
    }),
  );
  const errors = report.errors.join('\n');
  assert.match(errors, /unexpected write scope\(s\) actions/);
  assert.match(errors, /read-only jobs must not receive write access/);
});

test('rejects a required write job that loses its write scope', () => {
  const report = check(
    'dependency-review.yml',
    fixture({ jobName: 'dependency-review', jobPermissions: READ_ONLY_JOB }),
  );
  const errors = report.errors.join('\n');
  assert.match(errors, /do not match policy/);
  assert.match(errors, /pull-requests: write/);
});

test('accepts the pre-approved PR comment write scope', () => {
  const report = check(
    'dependency-review.yml',
    fixture({ jobName: 'dependency-review', jobPermissions: PR_COMMENT_JOB }),
  );
  assert.equal(report.ok, true, report.errors.join('\n'));
});

test('rejects a job that is absent from the permission policy', () => {
  const report = check(
    'backend.yml',
    fixture({ jobName: 'surprise-job', jobPermissions: READ_ONLY_JOB }),
  );
  assert.match(report.errors.join('\n'), /not declared in the permission policy/);
});

test('ignores permission-like text inside a block scalar script', () => {
  const yaml = fixture({
    jobName: 'build-and-test',
    jobPermissions: READ_ONLY_JOB,
    step: '|\n          echo "contents: write"',
  });
  assert.equal(parseWorkflowYaml(yaml).jobs['build-and-test'].permissions.contents, 'read');
  const report = check('backend.yml', yaml);
  assert.equal(report.ok, true, report.errors.join('\n'));
});
