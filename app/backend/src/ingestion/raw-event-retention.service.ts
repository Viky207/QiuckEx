import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UnparsedSorobanEventRepository } from './unparsed-soroban-event.repository';

/**
 * Retention policy for raw (unparsed) Soroban events.
 *
 * Field inventory / retention reference:
 * - Data category: telemetry / raw Soroban event payloads
 *   (stored in the unparsed Soroban event store).
 * - Purpose: replay and re-derivation of parsed events; debugging ingestion.
 * - Retention window: `SOROBAN_RAW_EVENT_RETENTION_DAYS` (default 90 days,
 *   minimum 1 day). Events replayed before `now - retentionDays` are archived.
 * - Deletion behavior: expired events are archived (not hard-deleted) by the
 *   daily 02:00 UTC job; archival is idempotent and only affects events that
 *   have already been replayed. Non-replayed events are retained regardless of
 *   age so ingestion can still process them.
 * - Secrets/signing material: never stored in raw event payloads.
 */
@Injectable()
export class RawEventRetentionService {
  private readonly logger = new Logger(RawEventRetentionService.name);

  /** Default retention window in days when the env var is unset. */
  static readonly DEFAULT_RETENTION_DAYS = 90;

  /** Minimum allowed retention window in days. */
  static readonly MIN_RETENTION_DAYS = 1;

  private readonly retentionDays = Math.max(
    RawEventRetentionService.MIN_RETENTION_DAYS,
    Number(
      process.env.SOROBAN_RAW_EVENT_RETENTION_DAYS ??
        RawEventRetentionService.DEFAULT_RETENTION_DAYS,
    ),
  );

  constructor(private readonly events: UnparsedSorobanEventRepository) {}

  /**
   * The configured retention window in days.
   * Exposed so the field inventory / retention reference can report the
   * effective value rather than assuming the default.
   */
  getRetentionDays(): number {
    return this.retentionDays;
  }

  /**
   * The cutoff before which replayed events are archived, based on the
   * configured retention window.
   */
  getRetentionCutoff(now: Date = new Date()): Date {
    return new Date(
      now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000,
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM, { timeZone: 'UTC' })
  async archiveExpiredEvents(): Promise<number> {
    const cutoff = this.getRetentionCutoff();
    const archived = await this.events.archiveReplayedBefore(cutoff);
    this.logger.log(
      `Archived ${archived} replayed raw Soroban event(s) before ${cutoff.toISOString()} ` +
        `(retention window: ${this.retentionDays} day(s))`,
    );
    return archived;
  }
}