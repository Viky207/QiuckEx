/**
 * Job Queue System - Admin Controller
 * 
 * REST API endpoints for operators to monitor and manage jobs.
 * All endpoints require authentication and admin scope.
 * 
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 14.1, 14.2, 14.3, 14.4, 14.5**
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Headers,
  UseGuards,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JobQueueService } from './job-queue.service';
import { JobRepository, JobFilters } from './job.repository';
import { JobReplayRepository } from './job-replay.repository';
import { JobType, JobStatus, Job } from './types';
import { DerivedRecordRepairPayload } from './types';
import { JobStatusProjection } from './job-status.projection';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { RequireScopes } from '../auth/decorators/require-scopes.decorator';

/**
 * DTO for bulk retry request
 */
export class BulkRetryRequestDto {
  type: JobType;
  status?: JobStatus;
}

export class DerivedRecordRepairRequestDto implements DerivedRecordRepairPayload {
  transactionHashes!: string[];
}

/**
 * Response for idempotent job-starting admin actions.
 *
 * `deduplicated` is true when an active run with the same scoped
 * idempotency key already existed and was returned instead of starting
 * a duplicate run.
 */
export interface IdempotentJobResponse {
  jobId: string;
  status: string;
  deduplicated: boolean;
}

/**
 * Build a scoped idempotency key for an admin job-starting action.
 *
 * The key is derived from the operation, the affected resource, and a
 * stable hash of the request parameters so that:
 * - identical requests map to the same key (deduplicated), and
 * - requests with different parameters map to different keys (not conflated).
 *
 * When the caller supplies an `Idempotency-Key` header it is included in the
 * scope so distinct operator intents remain distinguishable.
 */
export function buildScopedIdempotencyKey(
  operation: string,
  resource: string,
  params: unknown,
  headerKey?: string,
): string {
  const paramHash = createHash('sha256')
    .update(stableStringify(params))
    .digest('hex');
  const scope = headerKey ? `hdr:${headerKey}` : 'nohdr';
  return `admin:${operation}:${resource}:${scope}:${paramHash}`;
}

/**
 * Deterministically serialize a value for hashing (sorted object keys).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * DTO for bulk retry response
 */
export interface BulkRetryResponse {
  retriedCount: number;
  jobIds: string[];
}

/**
 * DTO for job metrics summary
 */
export interface JobMetrics {
  byType: Record<JobType, {
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  }>;
  dlqCount: number;
}

/**
 * Admin controller for job queue management
 * 
 * Provides endpoints for:
 * - Listing and filtering jobs
 * - Viewing job details
 * - Cancelling jobs
 * - Retrying failed jobs (single and bulk)
 * - Viewing metrics and DLQ
 * 
 * All endpoints require authentication with admin scope.
 */
@ApiTags('Admin - Job Queue')
@Controller('admin/jobs')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth()
export class JobAdminController {
  constructor(
    private readonly jobQueueService: JobQueueService,
    private readonly jobRepository: JobRepository,
    private readonly jobReplayRepository: JobReplayRepository,
  ) {}

  @Post('repair/derived-records')
  @RequireScopes('admin')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Queue repair of derived transaction and receipt records' })
  @ApiResponse({ status: 202, description: 'Repair job queued or existing active run returned' })
  async repairDerivedRecords(
    @Body() body: DerivedRecordRepairRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<IdempotentJobResponse> {
    const idempotencyKeyScoped = buildScopedIdempotencyKey(
      'repair-derived-records',
      'derived-records',
      body,
      idempotencyKey,
    );

    const result = await this.jobQueueService.enqueue(
      JobType.DERIVED_RECORD_REPAIR,
      body,
      { idempotencyKey: idempotencyKeyScoped },
    );

    return {
      jobId: result.jobId,
      status: result.deduplicated ? 'existing' : 'queued',
      deduplicated: result.deduplicated,
    };
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
   * **Validates: Requirements 5.1, 5.5**
   */
  @Get()
  @RequireScopes('admin')
  @ApiOperation({ summary: 'List jobs with filters' })
  @ApiResponse({ status: 200, description: 'Paginated job list' })
  async listJobs(
    @Query('type') type?: JobType,
    @Query('status') status?: JobStatus,
    @Query('createdAfter') createdAfter?: string,
    @Query('createdBefore') createdBefore?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
  ) {
    const filters: JobFilters = {
      type,
      status,
      createdAfter: createdAfter ? new Date(createdAfter) : undefined,
      createdBefore: createdBefore ? new Date(createdBefore) : undefined,
      limit,
      offset,
    };

    return this.jobQueueService.listJobs(filters);
  }

  /**
   * Get detailed information for a specific job
   * 
   * Returns full job details including payload and failure reason.
   * 
   * **Validates: Requirement 5.2**
   */
  @Get(':id')
  @RequireScopes('admin')
  @ApiOperation({ summary: 'Get job details by ID' })
  @ApiResponse({ status: 200, description: 'Job details' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async getJob(@Param('id') id: string): Promise<Job> {
    const job = await this.jobQueueService.getJob(id);

    if (!job) {
      throw new NotFoundException(`Job not found: ${id}`);
    }

    return job;
  }

  /**
   * Get safe retry status for a specific job
   * 
   * Returns an operator-facing projection containing only non-sensitive
   * triage metadata: attempts, next retry time, stable failure code, and
   * correlation ID. The job payload and any credentials are never included.
   * 
   * **Validates: Requirement 5.2 (safe status view)**
   */
  @Get(':id/status')
  @RequireScopes('admin')
  @ApiOperation({ summary: 'Get safe retry status for a job' })
  @ApiResponse({ status: 200, description: 'Safe job status projection' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async getJobStatus(@Param('id') id: string): Promise<JobStatusProjection> {
    const job = await this.jobQueueService.getJob(id);

    if (!job) {
      throw new NotFoundException(`Job not found: ${id}`);
    }

    return JobStatusProjection.fromJob(job);
  }

  /**
   * Cancel a job by ID
   * 
   * For pending jobs: Updates status to 'cancelled' immediately
   * For running jobs: Sets a cancellation token that the handler can check
   * For completed/failed/cancelled jobs: No-op (already terminal state)
   * 
   * **Validates: Requirements 6.1, 6.2, 6.3**
   */
  @Post(':id/cancel')
  @RequireScopes('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a job' })
  @ApiResponse({ status: 200, description: 'Job cancelled successfully' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async cancelJob(@Param('id') id: string): Promise<{ message: string }> {
    await this.jobQueueService.cancel(id);
    return { message: `Job ${id} cancellation requested` };
  }

  /**
   * Manually retry a failed job
   * 
   * Resets job status to pending, clears failureReason, and sets scheduledAt to now.
   * Rejects retry for completed or cancelled jobs.
   * Preserves original attempts count.
   * Logs all replays for auditability.
   * 
   * **Validates: Requirements 14.1, 14.2, 14.3, 14.4**
   */
  @Post(':id/retry')
  @RequireScopes('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually retry a failed job' })
  @ApiResponse({ status: 200, description: 'Job retry scheduled' })
  @ApiResponse({ status: 400, description: 'Job cannot be retried' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async retryJob(@Param('id') id: string): Promise<{ message: string; replayLogId: string }> {
    const job = await this.jobQueueService.getJob(id);

    if (!job) {
      throw new NotFoundException(`Job not found: ${id}`);
    }

    // Requirement 14.3: Reject retry for completed or cancelled jobs
    if (job.status === JobStatus.COMPLETED || job.status === JobStatus.CANCELLED) {
      // Log rejected replay attempt
      await this.jobReplayRepository.createReplayLog({
        jobId: id,
        jobType: job.type,
        status: 'rejected',
        previousAttempts: job.attempts,
        reason: `Cannot retry job in ${job.status} status`,
        triggeredBy: 'api',
      });

      throw new BadRequestException(
        `Cannot retry job in ${job.status} status. Only failed or pending jobs can be retried.`,
      );
    }

    // Create replay log before updating job status (auditable trail)
    const replayLog = await this.jobReplayRepository.createReplayLog({
      jobId: id,
      jobType: job.type,
      status: 'queued',
      previousAttempts: job.attempts,
      reason: 'Manual replay triggered by operator',
      triggeredBy: 'api',
    });

    if (!replayLog) {
      throw new Error('Failed to create replay audit log');
    }

    // Requirement 14.2: Reset status to pending, clear failureReason, set scheduledAt to now
    // Requirement 14.4: Preserve original attempts count
    await this.jobRepository.updateJobStatus(id, JobStatus.PENDING, {
      failureReason: null,
      scheduledAt: new Date(),
      // Note: attempts count is preserved (not reset)
    });

    return { 
      message: `Job ${id} scheduled for retry`,
      replayLogId: replayLog.id
    };
  }

  /**
   * Bulk retry jobs by type and status
   * 
   * Supports bulk retry for all jobs of a specific type in DLQ (failed status).
   * Logs all replays for auditability.
   * 
   * **Validates: Requirement 14.5**
   */
  @Post('bulk-retry')
  @RequireScopes('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk retry jobs by type' })
  @ApiResponse({ status: 200, description: 'Bulk retry completed' })
  async bulkRetry(
    @Body() request: BulkRetryRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<BulkRetryResponse & { replayLogIds: string[]; deduplicated: boolean }> {
    const filters: JobFilters = {
      type: request.type,
      status: request.status || JobStatus.FAILED,
      limit: 1000, // Limit bulk operations to prevent timeouts
    };

    const { jobs } = await this.jobQueueService.listJobs(filters);

    const retriedJobIds: string[] = [];
    const replayLogIds: string[] = [];
    let deduplicated = false;

    for (const job of jobs) {
      // Only retry failed jobs (DLQ)
      if (job.status === JobStatus.FAILED) {
        // Scope the idempotency key per job so a replayed bulk request
        // does not create duplicate replay logs for the same job.
        const jobIdempotencyKey = buildScopedIdempotencyKey(
          'bulk-retry',
          job.id,
          { type: request.type, status: filters.status },
          idempotencyKey,
        );

        const replayLog = await this.jobReplayRepository.createReplayLog({
          jobId: job.id,
          jobType: job.type,
          status: 'queued',
          previousAttempts: job.attempts,
          reason: 'Bulk replay triggered by operator',
          triggeredBy: 'api',
          idempotencyKey: jobIdempotencyKey,
        });

        if (!replayLog) {
          // An active replay for this job already exists; skip duplicate work.
          deduplicated = true;
          continue;
        }

        replayLogIds.push(replayLog.id);

        await this.jobRepository.updateJobStatus(job.id, JobStatus.PENDING, {
          failureReason: null,
          scheduledAt: new Date(),
        });
        retriedJobIds.push(job.id);
      }
    }

    return {
      retriedCount: retriedJobIds.length,
      jobIds: retriedJobIds,
      replayLogIds,
      deduplicated,
    };
  }

  /**
   * Get replay history for a specific job
   * 
   * Returns all manual replay attempts for a job, providing full audit trail.
   */
  @Get(':id/replays')
  @RequireScopes('admin')
  @ApiOperation({ summary: 'Get replay history for a job' })
  @ApiResponse({ status: 200, description: 'Replay history retrieved' })
  async getReplayHistory(@Param('id') id: string) {
    const job = await this.jobQueueService.getJob(id);
    if (!job) {
      throw new NotFoundException(`Job not found: ${id}`);
    }

    return this.jobReplayRepository.getReplayLogsForJob(id);
  }

  /**
   * Get job metrics summary
   * 
   * Returns counts by job type and status:
   * - Pending, running, completed, failed, cancelled counts per type
   * - Total DLQ count
   * 
   * **Validates: Requirement 5.3**
   */
  @Get('metrics/summary')
  @RequireScopes('admin')
  @ApiOperation({ summary: 'Get job metrics summary' })
  @ApiResponse({ status: 200, description: 'Job metrics' })
  async getMetrics(): Promise<JobMetrics> {
    // Initialize metrics structure
    const byType: Record<string, {
      pending: number;
      running: number;
      completed: number;
      failed: number;
      cancelled: number;
    }> = {};

    // Initialize all job types
    for (const type of Object.values(JobType)) {
      byType[type] = {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      };
    }

    // Query jobs for each type and status combination
    for (const type of Object.values(JobType)) {
      for (const status of Object.values(JobStatus)) {
        const { total } = await this.jobQueueService.listJobs({
          type,
          status,
          limit: 0, // Only get count, not actual jobs
        });

        byType[type][status] = total;
      }
    }

    // Count DLQ jobs (failed jobs that have exhausted retries)
    const allFailedJobs = await this.jobQueueService.listJobs({
      status: JobStatus.FAILED,
      limit: 10000, // Large limit to get all failed jobs
    });

    const dlqCount = allFailedJobs.jobs.filter(
      job => job.attempts >= job.maxAttempts,
    ).length;

    return {
      byType,
      dlqCount,
    };
  }

  /**
   * Get dead letter queue (DLQ) jobs
   * 
   * Returns jobs where status=failed AND attempts >= maxAttempts.
   * Supports pagination and filters by type, age, and failure reason.
   * 
   * **Validates: Requirement 5.4**
   */
  @Get('dlq')
  @RequireScopes('admin')
  @ApiOperation({ summary: 'Get dead letter queue jobs' })
  @ApiResponse({ status: 200, description: 'DLQ jobs' })
  async getDeadLetterQueue(
    @Query('type') type?: JobType,
    @Query('failureReasonContains') failureReasonContains?: string,
    @Query('createdAfter') createdAfter?: string,
    @Query('createdBefore') createdBefore?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
  ) {
    const filters: JobFilters = {
      type,
      status: JobStatus.FAILED,
      failureReasonContains,
      createdAfter: createdAfter ? new Date(createdAfter) : undefined,
      createdBefore: createdBefore ? new Date(createdBefore) : undefined,
      limit,
      offset,
    };

    const result = await this.jobQueueService.listJobs(filters);

    // Filter to only include jobs that have exhausted retries (DLQ)
    const dlqJobs = result.jobs.filter(job => job.attempts >= job.maxAttempts);

    return {
      jobs: dlqJobs,
      total: dlqJobs.length,
      limit: result.limit,
      offset: result.offset,
    };
  }
}