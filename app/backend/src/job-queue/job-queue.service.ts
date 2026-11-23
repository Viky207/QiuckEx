/**
 * Job Queue System - Job Queue Service
 * 
 * Main public API for the unified job queue system.
 * Provides methods for enqueuing, cancelling, and querying jobs.
 * 
 * **Validates: Requirements 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 6.1, 6.2, 15.2, 15.3**
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JobRepository, JobFilters, PaginatedJobs } from './job.repository';
import { JobRegistry } from './job-registry.service';
import { CancellationStore } from './cancellation-token';
import { JobQueueMetricsService } from './job-queue-metrics.service';
import { AppConfigService } from '../config/app-config.service';
import { Job, JobType, JobStatus } from './types';

/**
 * Safe, admin-scoped projection of a job's retry/triage status.
 *
 * Deliberately omits payload, credentials, and any other job data so that
 * operators can triage queued or repeatedly failing jobs without exposing
 * secrets or unnecessary personal data.
 */
export interface JobStatusProjection {
  /** Job identifier */
  id: string;
  /** Job type */
  type: JobType;
  /** Current job status */
  status: JobStatus;
  /** Number of attempts made so far */
  attempts: number;
  /** Maximum attempts allowed by the retry policy */
  maxAttempts: number;
  /** When the job is next scheduled to run (next retry / initial run) */
  nextRetryAt: string | null;
  /** Stable, machine-readable failure code (null when not failed) */
  failureCode: string | null;
  /** Correlation ID for tracing across logs and downstream systems */
  correlationId: string | null;
  /** When the job was created */
  createdAt: string;
  /** When the job reached a terminal state, if applicable */
  completedAt: string | null;
}

/**
 * Result of a single retention cleanup pass.
 */
export interface RetentionCleanupResult {
  /** Number of terminal job records deleted in this pass */
  deleted: number;
  /** Retention window applied (in days) */
  retentionDays: number;
  /** Batch size used for paginated deletion */
  batchSize: number;
  /** Cutoff timestamp; terminal jobs completed before this are eligible */
  cutoff: string;
}

/**
 * Error thrown when attempting to enqueue a job with an unregistered type
 */
export class UnregisteredJobTypeError extends Error {
  constructor(type: JobType) {
    super(`Job type '${type}' is not registered`);
    this.name = 'UnregisteredJobTypeError';
  }
}

/**
 * Error thrown when payload validation fails
 */
export class PayloadValidationError extends Error {
  constructor(message: string) {
    super(`Payload validation failed: ${message}`);
    this.name = 'PayloadValidationError';
  }
}

/**
 * Main service for job queue operations
 * 
 * This service provides the public API for:
 * - Enqueuing jobs (immediate or delayed)
 * - Cancelling jobs
 * - Querying job status and history
 * 
 * It uses:
 * - JobRepository for persistence
 * - JobRegistry for validation and handler lookup
 * - CancellationStore for cancellation management
 */
@Injectable()
export class JobQueueService {
  private readonly logger = new Logger(JobQueueService.name);

  constructor(
    private readonly repository: JobRepository,
    private readonly registry: JobRegistry,
    private readonly cancellationStore: CancellationStore,
    private readonly metrics: JobQueueMetricsService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Enqueue a job idempotently.
   *
   * Repeated operator requests (e.g. after a timeout) with the same scoped
   * idempotency key and identical parameters return the existing active run
   * instead of starting duplicate work. Reusing a key with different
   * parameters raises an IdempotencyConflictError rather than silently
   * conflating the requests. Every dedupe decision is recorded via the
   * AuditService.
   *
   * @param type - Job type (must be registered)
   * @param payload - Job-specific payload data
   * @param options - Scoped idempotency options
   * @param scheduledAt - When the job should execute (defaults to now)
   * @returns The job id and whether an existing run was reused
   */
  async enqueueIdempotent<TPayload = unknown>(
    type: JobType,
    payload: TPayload,
    options: IdempotentEnqueueOptions,
    scheduledAt: Date = new Date(),
  ): Promise<IdempotentEnqueueResult> {
    const { idempotencyKey, operation, resource } = options;
    const parametersHash = this.hashParameters(type, payload);

    const existing = await this.repository.findByIdempotencyKey(idempotencyKey);

    if (existing) {
      const existingHash = this.hashParameters(existing.type, existing.payload);

      if (existingHash !== parametersHash) {
        await this.recordDedupeDecision('conflict', {
          idempotencyKey,
          operation,
          resource,
          parametersHash,
          existingJobId: existing.id,
          existingParametersHash: existingHash,
        });
        throw new IdempotencyConflictError(idempotencyKey);
      }

      if (this.isActive(existing.status)) {
        await this.recordDedupeDecision('reused', {
          idempotencyKey,
          operation,
          resource,
          parametersHash,
          existingJobId: existing.id,
        });
        this.logger.log({
          message: 'Idempotent enqueue reused existing run',
          jobId: existing.id,
          type,
          idempotencyKey,
        });
        return { jobId: existing.id, reused: true };
      }

      // Terminal run: the previous attempt finished, so a new run is allowed.
      await this.recordDedupeDecision('created-after-terminal', {
        idempotencyKey,
        operation,
        resource,
        parametersHash,
        previousJobId: existing.id,
        previousStatus: existing.status,
      });
    }

    const jobId = await this.enqueueDelayed(
      type,
      payload,
      scheduledAt,
      idempotencyKey,
    );

    await this.recordDedupeDecision('created', {
      idempotencyKey,
      operation,
      resource,
      parametersHash,
      jobId,
    });

    return { jobId, reused: false };
  }

  private isActive(status: JobStatus): boolean {
    return status === JobStatus.PENDING || status === JobStatus.RUNNING;
  }

  private hashParameters(type: JobType, payload: unknown): string {
    const serialized = this.stableStringify({ type, payload });
    return createHash('sha256').update(serialized).digest('hex');
  }

  private stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${this.stableStringify(
            (value as Record<string, unknown>)[key],
          )}`,
      );
    return `{${entries.join(',')}}`;
  }

  private async recordDedupeDecision(
    decision: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    this.logger.log({
      message: 'Idempotent enqueue dedupe decision',
      decision,
      ...details,
    });
    try {
      await this.auditService.record({
        action: 'job_queue.idempotent_enqueue',
        outcome: decision,
        metadata: details,
      });
    } catch (error) {
      // Auditing must not block the enqueue decision itself.
      this.logger.warn(
        `Failed to record idempotent enqueue audit entry: ${error.message}`,
      );
    }
  }

  /**
   * Enqueue a job for immediate execution
   * 
   * Creates a new job with the current timestamp as scheduledAt.
   * The job will be picked up by the JobExecutor on the next poll.
   * 
   * @param type - Job type (must be registered)
   * @param payload - Job-specific payload data
   * @returns The created job ID
   * @throws UnregisteredJobTypeError if job type is not registered
   * @throws PayloadValidationError if payload validation fails
   * 
   * **Validates: Requirements 2.1, 2.3, 2.4, 1.5, 15.2, 15.3**
   */
  async enqueue<TPayload = unknown>(
    type: JobType,
    payload: TPayload,
    idempotencyKey?: string,
  ): Promise<string> {
    return this.enqueueDelayed(type, payload, new Date(), idempotencyKey);
  }

  /**
   * Enqueue a job for delayed execution
   * 
   * Creates a new job with a future scheduledAt timestamp.
   * The job will be picked up by the JobExecutor when scheduledAt is reached.
   * 
   * @param type - Job type (must be registered)
   * @param payload - Job-specific payload data
   * @param scheduledAt - When the job should execute
   * @returns The created job ID
   * @throws UnregisteredJobTypeError if job type is not registered
   * @throws PayloadValidationError if payload validation fails
   * 
   * **Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.6, 1.5, 15.2, 15.3**
   */
  async enqueueDelayed<TPayload = unknown>(
    type: JobType,
    payload: TPayload,
    scheduledAt: Date,
    idempotencyKey?: string,
  ): Promise<string> {
    // Requirement 1.5: Reject enqueue for unregistered job types
    if (!this.registry.isRegistered(type)) {
      this.logger.error(`Attempted to enqueue unregistered job type: ${type}`);
      throw new UnregisteredJobTypeError(type);
    }

    // Requirement 15.2, 15.3: Validate payload against job type schema
    try {
      const handler = this.registry.getHandler(type);
      await handler.validate(payload);
    } catch (error) {
      this.logger.error(
        `Payload validation failed for job type ${type}: ${error.message}`,
        error.stack,
      );
      throw new PayloadValidationError(error.message);
    }

    // Get retry policy for this job type
    const policy = this.registry.getPolicy(type);

    // Requirement 2.3: Persist job with status "pending"
    const job = idempotencyKey
      ? await this.repository.createJob<TPayload>(
          type,
          payload,
          policy.maxAttempts,
          scheduledAt,
          idempotencyKey,
        )
      : await this.repository.createJob<TPayload>(
          type,
          payload,
          policy.maxAttempts,
          scheduledAt,
        );

    // Increment jobs_enqueued_total metric
    this.metrics.incrementJobsEnqueued(type);
    
    // Update jobs_pending_count gauge
    this.metrics.updateJobsPendingCount(type, 1);

    // Structured logging: job enqueued at INFO level
    this.logger.log({
      message: 'Job enqueued',
      jobId: job.id,
      type,
      scheduledAt: scheduledAt.toISOString(),
    });

    // Requirement 2.5: Return unique job identifier
    return job.id;
  }

  /**
   * Request cancellation of a job
   * 
   * For pending jobs: Updates status to 'cancelled' immediately
   * For running jobs: Sets a cancellation token that the handler can check
   * For completed/failed/cancelled jobs: No-op (already terminal state)
   * 
   * @param jobId - The job ID to cancel
   * @throws Error if job not found
   * 
   * **Validates: Requirements 6.1, 6.2, 6.3**
   */
  async cancel(jobId: string): Promise<void> {
    const job = await this.repository.findById(jobId);

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // Requirement 6.2: Cancel pending jobs immediately
    if (job.status === JobStatus.PENDING) {
      await this.repository.updateJobStatus(jobId, JobStatus.CANCELLED, {
        completedAt: new Date(),
      });
      
      // Increment jobs_cancelled_total metric
      this.metrics.incrementJobsCancelled(job.type);
      
      // Update gauge metrics
      this.metrics.updateJobsPendingCount(job.type, -1);
      
      // Structured logging: job cancelled at INFO level
      this.logger.log({
        message: 'Job cancelled',
        jobId,
        type: job.type,
      });
      return;
    }

    // Requirement 6.3: Set cancellation token for running jobs
    if (job.status === JobStatus.RUNNING) {
      this.cancellationStore.requestCancellation(jobId);
      this.logger.log(`Cancellation requested for running job: ${jobId}`);
      return;
    }

    // Job is already in a terminal state (completed, failed, cancelled)
    this.logger.debug(
      `Cannot cancel job ${jobId} - already in terminal state: ${job.status}`,
    );
  }

  /**
   * Get detailed information for a specific job
   * 
   * @param jobId - The job ID
   * @returns The job, or null if not found
   * 
   * **Validates: Requirement 5.2** (via admin controller)
   */
  async getJob<TPayload = unknown>(jobId: string): Promise<Job<TPayload> | null> {
    return this.repository.findById<TPayload>(jobId);
  }

  /**
   * List jobs with optional filters
   * 
   * Supports filtering by:
   * - Job type
   * - Job status
   * - Date range (createdAfter, createdBefore)
   * - Pagination (limit, offset)
   * 
   * @param filters - Query filters
   * @returns Paginated job results
   * 
   * **Validates: Requirements 5.1, 5.5** (via admin controller)
   */
  async listJobs(filters: JobFilters = {}): Promise<PaginatedJobs> {
    return this.repository.listJobs(filters);
  }

  /**
   * Get a safe, admin-scoped status projection for a job.
   *
   * Returns only triage metadata (attempts, next retry, stable failure code,
   * correlation ID) and never the job payload or credentials.
   *
   * @param jobId - The job ID
   * @returns The safe status projection
   * @throws NotFoundException if the job does not exist
   *
   * **Validates: Requirement 5.2** (via admin controller)
   */
  async getJobStatusProjection(jobId: string): Promise<JobStatusProjection> {
    const job = await this.repository.findById(jobId);

    if (!job) {
      throw new NotFoundException(`Job not found: ${jobId}`);
    }

    return {
      id: job.id,
      type: job.type,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      nextRetryAt: job.scheduledAt ? job.scheduledAt.toISOString() : null,
      failureCode: job.failureCode ?? null,
      correlationId: job.correlationId ?? null,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    };
  }

  /**
   * Run a single retention cleanup pass for terminal jobs.
   *
   * Deletes terminal (completed/failed/cancelled) job records whose
   * completedAt is older than the configured retention window. Active jobs
   * (pending/running) are never touched. Deletion is paginated and idempotent:
   * running the pass repeatedly only removes records still past the cutoff.
   *
   * Retention duration and batch size are configurable via
   * `jobRetentionDays` and `jobRetentionCleanupBatchSize`.
   *
   * @returns Summary of the cleanup pass
   */
  async cleanupExpiredJobs(): Promise<RetentionCleanupResult> {
    const retentionDays = this.config.jobRetentionDays;
    const batchSize = this.config.jobRetentionCleanupBatchSize;

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const deleted = await this.repository.deleteTerminalJobsBefore(
      cutoff,
      batchSize,
    );

    // Structured logging: counts only, never payload data
    this.logger.log({
      message: 'Job retention cleanup completed',
      deleted,
      retentionDays,
      batchSize,
      cutoff: cutoff.toISOString(),
    });

    return {
      deleted,
      retentionDays,
      batchSize,
      cutoff: cutoff.toISOString(),
    };
  }
}
