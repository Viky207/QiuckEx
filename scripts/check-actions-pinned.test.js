'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { checkWorkflowContent } = require('./check-actions-pinned');

const SHA = 'a'.repeat(40);

test('passes when external action is pinned to a full SHA with version comment', () => {
  const yaml = [
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    `      - uses: actions/checkout@${SHA} # v4.1.1`,
    `      - uses: actions/setup-node@${SHA} # v4.0.2`,
  ].join('\n');

  const result = checkWorkflowContent(yaml, 'workflow.yml');
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.ok, true);
});

test('fails when external action uses a mutable tag', () => {
  const yaml = [
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
  ].join('\n');

  const result = checkWorkflowContent(yaml, 'workflow.yml');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errors.length, 1);
  assert.match(result.errors[0], /actions\/checkout@v4/);
  assert.match(result.errors[0], /SHA/);
});

test('fails when external action uses a branch name', () => {
  const yaml = [
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@main',
  ].join('\n');

  const result = checkWorkflowContent(yaml, 'workflow.yml');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errors.length, 1);
  assert.match(result.errors[0], /actions\/checkout@main/);
});

test('fails when external action uses a short SHA', () => {
  const yaml = [
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@abc1234',
  ].join('\n');

  const result = checkWorkflowContent(yaml, 'workflow.yml');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errors.length, 1);
  assert.match(result.errors[0], /actions\/checkout@abc1234/);
});

test('allows local ./ references without SHA pinning', () => {
  const yaml = [
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: ./.github/actions/setup',
    '      - uses: ./local-action',
  ].join('\n');

  const result = checkWorkflowContent(yaml, 'workflow.yml');
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.ok, true);
});

test('allows docker:// references without SHA pinning', () => {
  const yaml = [
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: docker://alpine:3.19',
  ].join('\n');

  const result = checkWorkflowContent(yaml, 'workflow.yml');
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.ok, true);
});

test('reports every offending reference in a mixed workflow', () => {
  const yaml = [
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    `      - uses: actions/checkout@${SHA} # v4.1.1`,
    '      - uses: actions/setup-node@v4',
    '      - uses: ./.github/actions/setup',
    '      - uses: actions/cache@main',
  ].join('\n');

  const result = checkWorkflowContent(yaml, 'workflow.yml');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errors.length, 2);
  assert.ok(result.errors.some((e) => /actions\/setup-node@v4/.test(e)));
  assert.ok(result.errors.some((e) => /actions\/cache@main/.test(e)));
});

test('ignores commented-out uses lines', () => {
  const yaml = [
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      # - uses: actions/checkout@v4',
    `      - uses: actions/checkout@${SHA} # v4.1.1`,
  ].join('\n');

  const result = checkWorkflowContent(yaml, 'workflow.yml');
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.ok, true);
});