#!/usr/bin/env node
'use strict';

/**
 * check-actions-pinned.js
 *
 * Verifies that every external `uses:` reference in GitHub Actions workflows
 * and composite actions is pinned to an immutable 40-character commit SHA.
 *
 * Local references (starting with `./`) are allowed and skipped.
 * Docker references (`docker://...`) are reported as unsupported unless they
 * carry a digest; by default they are flagged so they can be reviewed.
 *
 * Usage:
 *   node scripts/check-actions-pinned.js            # check (exit 1 on failure)
 *   node scripts/check-actions-pinned.js --fix      # print update instructions
 *   node scripts/check-actions-pinned.js --help     # show help
 *
 * Exit codes:
 *   0  all references are pinned (or --fix/--help mode)
 *   1  one or more mutable references found
 *   2  unexpected error (e.g. unreadable file)
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const ACTIONS_DIR = path.join(REPO_ROOT, '.github', 'actions');

const SHA_RE = /^[0-9a-f]{40}$/i;

// Matches a `uses:` key at the start of a YAML line (allowing list-item `-`).
// Captures the value (quoted or unquoted) up to an optional trailing comment.
const USES_RE = /^(\s*(?:-\s+)?uses\s*:\s*)(['"]?)([^'"#\s]+)\2(\s*(?:#.*)?)$/;

function printHelp() {
  process.stdout.write(
    [
      'check-actions-pinned.js',
      '',
      'Ensures all external `uses:` references are pinned to full 40-char commit SHAs.',
      '',
      'Options:',
      '  --fix     Print instructions for updating mutable pins (does not modify files)',
      '  --help    Show this help message',
      '',
      'Exit codes:',
      '  0  success',
      '  1  mutable references found',
      '  2  unexpected error',
      '',
    ].join('\n')
  );
}

function listFiles(dir, matcher) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFiles(full, matcher));
    } else if (entry.isFile() && matcher(full)) {
      results.push(full);
    }
  }
  return results;
}

function collectTargetFiles() {
  const workflowFiles = listFiles(
    WORKFLOWS_DIR,
    (f) => f.endsWith('.yml') || f.endsWith('.yaml')
  );
  const actionFiles = listFiles(
    ACTIONS_DIR,
    (f) => path.basename(f) === 'action.yml' || path.basename(f) === 'action.yaml'
  );
  return [...workflowFiles, ...actionFiles].sort();
}

function isLocalRef(ref) {
  return ref.startsWith('./') || ref.startsWith('../');
}

function isDockerRef(ref) {
  return ref.startsWith('docker://');
}

function isPinned(ref) {
  // Expected form: owner/repo[/path]@<40-char-sha>
  const at = ref.lastIndexOf('@');
  if (at === -1) {
    return false;
  }
  const sha = ref.slice(at + 1);
  return SHA_RE.test(sha);
}

function checkFile(file) {
  const rel = path.relative(REPO_ROOT, file);
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split(/\r?\n/);
  const problems = [];

  lines.forEach((line, idx) => {
    const match = USES_RE.exec(line);
    if (!match) {
      return;
    }
    const ref = match[3];
    if (!ref) {
      return;
    }
    if (isLocalRef(ref)) {
      return;
    }
    if (isDockerRef(ref)) {
      // Docker refs must carry a digest (@sha256:...) to be immutable.
      if (!/@sha256:[0-9a-f]{64}$/i.test(ref)) {
        problems.push({
          file: rel,
          line: idx + 1,
          ref,
          reason: 'docker reference is not pinned to a sha256 digest',
        });
      }
      return;
    }
    if (!isPinned(ref)) {
      problems.push({
        file: rel,
        line: idx + 1,
        ref,
        reason: 'reference is not pinned to a 40-character commit SHA',
      });
    }
  });

  return problems;
}

function printFixInstructions(problems) {
  const out = [];
  out.push('');
  out.push('Update instructions for mutable action references:');
  out.push('');
  out.push('1. Resolve the reviewed tag/branch to its full commit SHA, e.g.:');
  out.push('     git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag>');
  out.push('   or use the GitHub UI to copy the commit SHA for the release.');
  out.push('');
  out.push('2. Replace the mutable reference with the SHA and keep a readable');
  out.push('   version comment so reviewers can see the intended version:');
  out.push('     uses: owner/repo@<40-char-sha> # vX.Y.Z');
  out.push('');
  out.push('3. Re-run this check:');
  out.push('     node scripts/check-actions-pinned.js');
  out.push('');
  if (problems.length > 0) {
    out.push('References needing updates:');
    for (const p of problems) {
      out.push(`  - ${p.file}:${p.line}  ${p.ref}`);
    }
    out.push('');
  }
  process.stdout.write(out.join('\n'));
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }
  const fixMode = args.includes('--fix');

  const files = collectTargetFiles();
  if (files.length === 0) {
    process.stdout.write(
      'check-actions-pinned: no workflow or action files found; nothing to check.\n'
    );
    return 0;
  }

  const allProblems = [];
  for (const file of files) {
    allProblems.push(...checkFile(file));
  }

  if (allProblems.length === 0) {
    process.stdout.write(
      `check-actions-pinned: OK (${files.length} file(s) checked).\n`
    );
    return 0;
  }

  process.stderr.write(
    `check-actions-pinned: found ${allProblems.length} mutable action reference(s):\n`
  );
  for (const p of allProblems) {
    process.stderr.write(`  ${p.file}:${p.line}  ${p.ref}\n    ${p.reason}\n`);
  }

  if (fixMode) {
    printFixInstructions(allProblems);
    return 0;
  }

  process.stderr.write(
    '\nRun with --fix for update instructions.\n'
  );
  return 1;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (err) {
    process.stderr.write(`check-actions-pinned: error: ${err && err.message ? err.message : err}\n`);
    process.exit(2);
  }
}

module.exports = {
  SHA_RE,
  USES_RE,
  isLocalRef,
  isDockerRef,
  isPinned,
  checkFile,
  collectTargetFiles,
  main,
};