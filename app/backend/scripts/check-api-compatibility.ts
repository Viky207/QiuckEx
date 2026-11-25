import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ApiCompatibilityService } from '../src/api-compatibility/api-compatibility.service';
import {
  ApiCompatibilityChange,
  ApiCompatibilityReport,
} from '../src/api-compatibility/api-compatibility.types';

interface CliOptions {
  baselinePath?: string;
  allowlistPath?: string;
  override: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    override: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--baseline':
        options.baselinePath = argv[++i];
        break;
      case '--allowlist':
        options.allowlistPath = argv[++i];
        break;
      case '--override':
        options.override = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('--baseline=')) {
          options.baselinePath = arg.slice('--baseline='.length);
        } else if (arg.startsWith('--allowlist=')) {
          options.allowlistPath = arg.slice('--allowlist='.length);
        } else {
          console.error(`Unknown argument: ${arg}`);
          printUsage();
          process.exit(2);
        }
    }
  }

  return options;
}

function printUsage(): void {
  console.log(`Usage: check-api-compatibility [options]

Options:
  --baseline <path>   Path to the frozen API baseline file
  --allowlist <path>  Path to the allowlist of accepted breaking changes
  --override          Exit 0 even when breaking changes are detected
  --json              Emit the report as JSON instead of human-readable text
  -h, --help          Show this help message
`);
}

const PAGINATION_PARAM_NAMES = new Set(['cursor', 'limit', 'pageSize', 'page_size']);
const PAGINATION_ENVELOPE_FIELDS = new Set(['nextCursor', 'hasMore']);
const PAGINATION_ERROR_CODES = new Set([
  'INVALID_CURSOR',
  'CURSOR_EXPIRED',
  'EXPIRED_CURSOR',
]);

function isPaginationSensitiveChange(change: ApiCompatibilityChange): boolean {
  const path = change.path ?? '';
  const details = change.details ?? '';

  // Cursor pagination request parameters (e.g. query.cursor, query.limit).
  for (const param of PAGINATION_PARAM_NAMES) {
    if (path.includes(param) || details.includes(param)) {
      return true;
    }
  }

  // Cursor pagination response envelope fields (nextCursor, hasMore).
  for (const field of PAGINATION_ENVELOPE_FIELDS) {
    if (path.includes(field) || details.includes(field)) {
      return true;
    }
  }

  // Documented invalid-cursor / expired-cursor error responses.
  for (const code of PAGINATION_ERROR_CODES) {
    if (path.includes(code) || details.includes(code)) {
      return true;
    }
  }

  return false;
}

function promotePaginationChanges(report: ApiCompatibilityReport): ApiCompatibilityReport {
  const promoted: ApiCompatibilityChange[] = [];
  const remainingNonBreaking: ApiCompatibilityChange[] = [];

  for (const change of report.nonBreakingChanges) {
    if (isPaginationSensitiveChange(change)) {
      promoted.push({
        ...change,
        details: change.details
          ? `${change.details} (cursor pagination contract)`
          : 'Cursor pagination contract change',
      });
    } else {
      remainingNonBreaking.push(change);
    }
  }

  if (promoted.length === 0) {
    return report;
  }

  return {
    ...report,
    breakingChanges: [...report.breakingChanges, ...promoted],
    nonBreakingChanges: remainingNonBreaking,
  };
}

function formatReport(report: ApiCompatibilityReport): string {
  const lines: string[] = [];

  lines.push('API Compatibility Report');
  lines.push('========================');
  lines.push('');

  if (report.breakingChanges.length === 0 && report.nonBreakingChanges.length === 0) {
    lines.push('No changes detected against the baseline.');
    return lines.join('\n');
  }

  if (report.breakingChanges.length > 0) {
    lines.push(`Breaking changes (${report.breakingChanges.length}):`);
    for (const change of report.breakingChanges) {
      lines.push(`  [BREAKING] ${change.kind}: ${change.path}`);
      if (change.details) {
        lines.push(`             ${change.details}`);
      }
    }
    lines.push('');
  }

  if (report.nonBreakingChanges.length > 0) {
    lines.push(`Non-breaking changes (${report.nonBreakingChanges.length}):`);
    for (const change of report.nonBreakingChanges) {
      lines.push(`  [OK] ${change.kind}: ${change.path}`);
      if (change.details) {
        lines.push(`       ${change.details}`);
      }
    }
    lines.push('');
  }

  if (report.allowedBreakingChanges.length > 0) {
    lines.push(`Allowlisted breaking changes (${report.allowedBreakingChanges.length}):`);
    for (const change of report.allowedBreakingChanges) {
      lines.push(`  [ALLOWED] ${change.kind}: ${change.path}`);
      if (change.details) {
        lines.push(`            ${change.details}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const service = app.get(ApiCompatibilityService);

    const rawReport = await service.checkCompatibility({
      baselinePath: options.baselinePath,
      allowlistPath: options.allowlistPath,
    });

    // Cursor pagination semantics (opaque cursors, page limits, continuation,
    // and invalid/expired cursor errors) are part of the public contract.
    // Any drift in those parameters, envelope fields, or error responses is
    // treated as breaking so the documented behavior cannot silently change.
    const report = promotePaginationChanges(rawReport);

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReport(report));
    }

    const hasUnresolvedBreakingChanges = report.breakingChanges.length > 0;

    if (hasUnresolvedBreakingChanges) {
      if (options.override) {
        console.warn(
          '\nWARNING: Breaking API changes detected, but --override was supplied. Exiting 0.',
        );
        process.exitCode = 0;
        return;
      }

      console.error(
        '\nERROR: Breaking API changes detected. Update the baseline or record an allowlist entry.',
      );
      process.exitCode = 1;
      return;
    }

    process.exitCode = 0;
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Failed to run API compatibility check:', error);
  process.exitCode = 1;
});