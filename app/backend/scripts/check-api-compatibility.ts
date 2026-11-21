import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ApiCompatibilityService } from '../src/api-compatibility/api-compatibility.service';
import {
  AliasDeprecationEntry,
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

function formatAliasDeprecation(entry: AliasDeprecationEntry): string[] {
  const lines: string[] = [];

  const status = entry.warningPeriodActive ? 'WARNING ACTIVE' : 'WARNING EXPIRED';
  lines.push(`  [${status}] ${entry.aliasPath} -> ${entry.replacementPath}`);
  lines.push(`             replacement endpoint: ${entry.replacementEndpoint}`);
  lines.push(`             warning period: ${entry.warningPeriodStatus}`);
  if (entry.deprecatedSince) {
    lines.push(`             deprecated since: ${entry.deprecatedSince}`);
  }
  if (entry.removalNotBefore) {
    lines.push(`             removal not before: ${entry.removalNotBefore}`);
  }
  if (entry.details) {
    lines.push(`             ${entry.details}`);
  }

  return lines;
}

function formatReport(report: ApiCompatibilityReport): string {
  const lines: string[] = [];

  lines.push('API Compatibility Report');
  lines.push('========================');
  lines.push('');

  const aliasDeprecations = report.aliasDeprecations ?? [];

  if (
    report.breakingChanges.length === 0 &&
    report.nonBreakingChanges.length === 0 &&
    aliasDeprecations.length === 0
  ) {
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

  if (aliasDeprecations.length > 0) {
    lines.push(`Alias deprecations (${aliasDeprecations.length}):`);
    for (const entry of aliasDeprecations) {
      lines.push(...formatAliasDeprecation(entry));
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

    const report = await service.checkCompatibility({
      baselinePath: options.baselinePath,
      allowlistPath: options.allowlistPath,
    });

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ...report,
            aliasDeprecations: report.aliasDeprecations ?? [],
          },
          null,
          2,
        ),
      );
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