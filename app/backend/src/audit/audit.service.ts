import { Injectable, Logger } from '@nestjs/common';
import { AuditLog, QueryAuditLogsDto } from './audit.model';
import { randomUUID, createHash } from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';

/**
 * Audit action recorded whenever an admin background-job enqueue request is
 * evaluated for idempotency. The metadata shape is intentionally limited to
 * non-sensitive identifiers so dedupe decisions stay auditable without
 * leaking secrets or personal data.
 */
export const ADMIN_JOB_IDEMPOTENCY_AUDIT_ACTION = 'admin.job.enqueue.idempotency';

export interface AdminJobIdempotencyAuditInput {
  /** Logical operation, e.g. `reconcile` or `cleanup`. */
  operation: string;
  /** Resource the operation targets, e.g. `orders` or `sessions`. */
  resource: string;
  /** Stable hash of the request parameters (never the raw parameters). */
  parameterHash: string;
  /** Whether an existing run was reused instead of starting a new one. */
  reused: boolean;
  /** Identifier of the run that was reused, when applicable. */
  reusedJobId?: string;
  /** Identifier of the newly created run, when applicable. */
  jobId?: string;
  /** Scoped idempotency key supplied by the caller, when present. */
  idempotencyKey?: string;
  /** Human-readable reason for the dedupe decision. */
  reason?: string;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private logs: AuditLog[] = [];

  constructor(private readonly supabaseService: SupabaseService) {}

  /**
   * Builds the audit metadata for an idempotent admin job enqueue decision.
   * Only non-sensitive identifiers are included; raw parameters and secrets
   * are never recorded.
   */
  static buildJobIdempotencyMetadata(
    input: AdminJobIdempotencyAuditInput,
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      operation: input.operation,
      resource: input.resource,
      parameterHash: input.parameterHash,
      reused: input.reused,
    };
    if (input.reusedJobId) metadata.reusedJobId = input.reusedJobId;
    if (input.jobId) metadata.jobId = input.jobId;
    if (input.idempotencyKey) metadata.idempotencyKey = input.idempotencyKey;
    if (input.reason) metadata.reason = input.reason;
    return metadata;
  }

  /**
   * Computes a stable, non-reversible hash of job request parameters so that
   * dedupe decisions can be audited without persisting raw parameters.
   */
  static hashJobParameters(params: unknown): string {
    const serialized = AuditService.stableStringify(params);
    return createHash('sha256').update(serialized).digest('hex');
  }

  private static stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => AuditService.stableStringify(item)).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${AuditService.stableStringify(item)}`)
      .join(',')}}`;
  }

  /**
   * Records an auditable idempotency decision for an admin background-job
   * enqueue request. Used by JobQueueService.
   */
  async logJobIdempotencyDecision(
    actor: string,
    input: AdminJobIdempotencyAuditInput,
    requestId?: string,
  ): Promise<void> {
    await this.log(
      actor,
      ADMIN_JOB_IDEMPOTENCY_AUDIT_ACTION,
      `${input.operation}:${input.resource}`,
      AuditService.buildJobIdempotencyMetadata(input),
      requestId,
    );
  }

  async log(
    actor: string,
    action: string,
    target?: string,
    metadata?: Record<string, unknown>,
    requestId?: string,
  ): Promise<void> {
    const entry: AuditLog = {
      id: randomUUID(),
      actor,
      action,
      target,
      metadata,
      requestId,
      createdAt: new Date(),
    };
    this.logs.push(entry);
    this.logger.log(`Audit Event: ${action} by ${actor}`);

    try {
      const client = this.supabaseService.getClient();
      const { error } = await client.from('admin_audit_logs').insert({
        id: entry.id,
        actor: entry.actor,
        action: entry.action,
        target: entry.target ?? null,
        metadata: entry.metadata ?? {},
        request_id: entry.requestId ?? null,
        created_at: entry.createdAt.toISOString(),
      });

      if (error) {
        this.logger.warn(`Failed to persist audit log ${entry.id}: ${error.message}`);
      }
    } catch (error) {
      this.logger.warn(
        `Audit store unavailable, keeping in-memory copy only: ${(error as Error).message}`,
      );
    }
  }

  async logScopeChange(params: {
    actor: string;
    keyId: string;
    before: string[];
    after: string[];
    success: boolean;
    requestId?: string;
    reason?: string;
  }): Promise<void> {
    const { actor, keyId, before, after, success, requestId, reason } = params;
    const metadata: Record<string, unknown> = {
      keyId,
      beforeScopes: [...before],
      afterScopes: [...after],
      outcome: success ? 'success' : 'failure',
    };
    if (reason) {
      metadata.reason = reason;
    }

    await this.log(actor, 'api_key.scopes.update', keyId, metadata, requestId);
  }

  async query(dto: QueryAuditLogsDto) {
    let result = await this.readLogs();

    if (dto.action) {
      result = result.filter(log => log.action === dto.action);
    }
    if (dto.actor) {
      result = result.filter(log => log.actor === dto.actor);
    }
    if (dto.startTime) {
      const start = new Date(dto.startTime).getTime();
      result = result.filter(log => log.createdAt.getTime() >= start);
    }
    if (dto.endTime) {
      const end = new Date(dto.endTime).getTime();
      result = result.filter(log => log.createdAt.getTime() <= end);
    }

    // Pagination
    const page = Number(dto.page) || 1;
    const limit = Number(dto.limit) || 50;
    const startIndex = (page - 1) * limit;
    const paginated = result.slice(startIndex, startIndex + limit);

    return {
      data: paginated,
      total: result.length,
      page,
      limit,
    };
  }

  async exportCsv(): Promise<string> {
    const logs = await this.readLogs();
    if (logs.length === 0) return 'id,actor,action,target,requestId,createdAt\n';
    
    const header = 'id,actor,action,target,requestId,createdAt\n';
    const rows = logs.map(log => {
      return `${log.id},${log.actor},${log.action},${log.target || ''},${log.requestId || ''},${log.createdAt.toISOString()}`;
    }).join('\n');
    
    return header + rows;
  }

  async applyRetention(days: number = 90) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    
    const initialCount = this.logs.length;
    this.logs = this.logs.filter(log => log.createdAt > cutoff);
    const deletedCount = initialCount - this.logs.length;

    try {
      const client = this.supabaseService.getClient();
      await client.from('admin_audit_logs').delete().lt('created_at', cutoff.toISOString());
    } catch (error) {
      this.logger.warn(
        `Failed to apply audit retention in store: ${(error as Error).message}`,
      );
    }
    
    this.logger.log(`Applied retention policy: deleted ${deletedCount} logs older than ${days} days`);
    return { deletedCount };
  }

  private async readLogs(): Promise<AuditLog[]> {
    try {
      const client = this.supabaseService.getClient();
      const { data, error } = await client
        .from('admin_audit_logs')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      return (data ?? []).map((row) => ({
        id: String(row.id),
        actor: String(row.actor),
        action: String(row.action),
        target: row.target ? String(row.target) : undefined,
        metadata:
          row.metadata && typeof row.metadata === 'object'
            ? (row.metadata as Record<string, unknown>)
            : undefined,
        requestId: row.request_id ? String(row.request_id) : undefined,
        createdAt: new Date(String(row.created_at)),
      }));
    } catch (error) {
      this.logger.warn(
        `Reading audit logs from memory fallback: ${(error as Error).message}`,
      );
      return [...this.logs].sort(
        (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
      );
    }
  }
}
