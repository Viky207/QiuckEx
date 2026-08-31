/**
 * Job Queue System - Template Execution Handler
 * 
 * Implements the JobHandler interface for template execution jobs.
 * Processes recurring link template executions with variable substitution.
 * 
 * This handler processes template executions by:
 * 1. Validating the execution request
 * 2. Rendering templates with variable data
 * 3. Creating recurring payment links from rendered templates
 * 4. Updating execution status
 */

import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, Job, CancellationToken } from '../types';
import { TemplateExecutionPayload } from '../types/job-payloads.types';
import { RecurringLinkTemplateService } from '../../links/recurring-link-template.service';
import { RecurringLinkTemplateRepository } from '../../links/recurring-link-template.repository';
import { TemplateExecutionStatus } from '../../links/dto/recurring-link-template.dto';
import { PermanentJobError } from './webhook-delivery.handler';

/**
 * Template Execution Handler
 * 
 * Processes template execution jobs by rendering templates with variable data
 * and generating recurring payment links from the rendered output.
 */
@Injectable()
export class TemplateExecutionHandler implements JobHandler<TemplateExecutionPayload> {
  private readonly logger = new Logger(TemplateExecutionHandler.name);

  constructor(
    private readonly templateService: RecurringLinkTemplateService,
    private readonly templateRepository: RecurringLinkTemplateRepository,
  ) {}

  /**
   * Execute template processing
   * 
   * Processes a template execution by:
   * 1. Fetching the execution record
   * 2. Validating the template and version
   * 3. Rendering the template with variable data
   * 4. Creating a recurring payment link
   * 5. Updating the execution status
   * 
   * @param job - The template execution job
   * @param cancellationToken - Token to check for cancellation
   * @throws PermanentJobError for permanent validation or template errors
   * @throws Error for transient processing errors
   */
  async execute(job: Job<TemplateExecutionPayload>, cancellationToken: CancellationToken): Promise<void> {
    // Check cancellation token before processing
    cancellationToken.throwIfCancelled();

    const { executionId, templateId, versionId, variableData, scheduledAt, timezone, previewScope } = job.payload;

    this.logger.log(
      `Processing template execution: ${executionId} for template ${templateId} (jobId: ${job.id})`,
    );

    try {
      // Fetch the execution record
      const execution = await this.templateRepository.findExecutionById(executionId);
      if (!execution) {
        throw new PermanentJobError(`Template execution not found: ${executionId}`);
      }

      // Verify the execution is still pending
      if (execution.status !== TemplateExecutionStatus.PENDING) {
        this.logger.warn(
          `Template execution ${executionId} is not in pending state: ${execution.status}`,
        );
        return; // Skip processing if already processed
      }

      // Check cancellation again after database operations
      cancellationToken.throwIfCancelled();

      // Fetch the template
      const template = await this.templateRepository.findTemplateById(templateId);
      if (!template) {
        throw new PermanentJobError(`Template not found: ${templateId}`);
      }

      // Verify template is active
      if (template.status !== 'active') {
        throw new PermanentJobError(`Template ${templateId} is not active: ${template.status}`);
      }

      // Get the template version to use
      let templateVersion;
      if (versionId) {
        templateVersion = await this.templateRepository.findTemplateVersionById(versionId);
        if (!templateVersion || templateVersion.template_id !== templateId) {
          throw new PermanentJobError(`Template version not found: ${versionId}`);
        }
      } else {
        templateVersion = await this.templateRepository.findActiveVersionForTemplate(templateId);
        if (!templateVersion) {
          throw new PermanentJobError(`No active version found for template: ${templateId}`);
        }
      }

      // Verify version is active or specified
      if (!versionId && templateVersion.status !== 'active') {
        throw new PermanentJobError(`Template version ${templateVersion.id} is not active`);
      }

      // Update execution status to indicate processing has started
      await this.templateRepository.updateExecutionStatus(
        executionId,
        TemplateExecutionStatus.PENDING, // Keep as pending but update job reference
        {
          // Job reference will be tracked by the job system
        },
      );

      // Check cancellation before expensive template processing
      cancellationToken.throwIfCancelled();

      // Process the template execution using the service
      await this.templateService.processTemplateExecution(executionId);

      this.logger.log(
        `Template execution completed successfully: ${executionId} (jobId: ${job.id})`,
      );

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      this.logger.error(
        `Template execution failed (executionId: ${executionId}, jobId: ${job.id}): ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );

      // Update execution status as failed
      try {
        await this.templateRepository.updateExecutionStatus(
          executionId,
          TemplateExecutionStatus.FAILED,
          {
            errorMessage,
            retryCount: job.attempts,
            lastRetryAt: new Date(),
          },
        );
      } catch (updateError) {
        this.logger.error(
          `Failed to update execution status for ${executionId}:`,
          updateError,
        );
      }

      // Classify errors
      if (this.isPermanentError(error)) {
        this.logger.error(
          `Permanent error detected (executionId: ${executionId}, jobId: ${job.id}) - no retry`,
        );
        throw new PermanentJobError(`Permanent error: ${errorMessage}`);
      }

      // Transient error - will retry
      this.logger.warn(
        `Transient error detected (executionId: ${executionId}, jobId: ${job.id}) - will retry`,
      );
      throw new Error(`Transient error: ${errorMessage}`);
    }
  }

  /**
   * Validate template execution payload
   * 
   * Checks that required fields are present and valid:
   * - executionId: ID of the template execution record
   * - templateId: ID of the template to execute
   * - variableData: Object containing template variables
   * - scheduledAt: ISO timestamp of when execution was scheduled
   * - timezone: IANA timezone identifier
   * 
   * @param payload - The template execution payload
   * @throws PermanentJobError if validation fails
   */
  async validate(payload: TemplateExecutionPayload): Promise<void> {
    const errors: string[] = [];

    // Required fields validation
    if (!payload.executionId || typeof payload.executionId !== 'string') {
      errors.push('executionId is required and must be a string');
    }

    if (!payload.templateId || typeof payload.templateId !== 'string') {
      errors.push('templateId is required and must be a string');
    }

    if (!payload.variableData || typeof payload.variableData !== 'object') {
      errors.push('variableData is required and must be an object');
    }

    if (!payload.scheduledAt || typeof payload.scheduledAt !== 'string') {
      errors.push('scheduledAt is required and must be a string');
    }

    if (!payload.timezone || typeof payload.timezone !== 'string') {
      errors.push('timezone is required and must be a string');
    }

    // Optional field validation
    if (payload.versionId !== undefined && typeof payload.versionId !== 'string') {
      errors.push('versionId must be a string if provided');
    }

    if (payload.previewScope !== undefined && typeof payload.previewScope !== 'string') {
      errors.push('previewScope must be a string if provided');
    }

    // Validate scheduledAt is a valid ISO timestamp
    if (payload.scheduledAt) {
      const scheduledDate = new Date(payload.scheduledAt);
      if (isNaN(scheduledDate.getTime())) {
        errors.push('scheduledAt must be a valid ISO 8601 timestamp');
      }
    }

    // Validate timezone format
    if (payload.timezone) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: payload.timezone });
      } catch {
        errors.push('timezone must be a valid IANA timezone identifier');
      }
    }

    // Validate UUID format for IDs (basic check)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (payload.executionId && !uuidRegex.test(payload.executionId)) {
      errors.push('executionId must be a valid UUID');
    }

    if (payload.templateId && !uuidRegex.test(payload.templateId)) {
      errors.push('templateId must be a valid UUID');
    }

    if (payload.versionId && !uuidRegex.test(payload.versionId)) {
      errors.push('versionId must be a valid UUID');
    }

    // Validate variable data is not empty
    if (payload.variableData && Object.keys(payload.variableData).length === 0) {
      errors.push('variableData cannot be empty');
    }

    if (errors.length > 0) {
      throw new PermanentJobError(`Validation failed: ${errors.join(', ')}`);
    }
  }

  /**
   * Handle job failure
   * 
   * Marks the execution record as permanently failed when the job exhausts all retry attempts.
   * This is called when the job moves to the Dead Letter Queue.
   * 
   * @param job - The failed job
   * @param error - The error that caused the failure
   */
  async onFailure(job: Job<TemplateExecutionPayload>, error: Error): Promise<void> {
    const { executionId, templateId } = job.payload;

    this.logger.error(
      `Template execution permanently failed (templateId: ${templateId}, executionId: ${executionId}, jobId: ${job.id}): ${error.message}`,
    );

    try {
      // Mark execution as permanently failed
      await this.templateRepository.updateExecutionStatus(
        executionId,
        TemplateExecutionStatus.FAILED,
        {
          errorMessage: `Permanent failure after ${job.attempts} attempts: ${error.message}`,
          retryCount: job.attempts,
          lastRetryAt: new Date(),
        },
      );

      this.logger.log(
        `Updated execution ${executionId} status to failed after permanent job failure`,
      );

    } catch (updateError) {
      this.logger.error(
        `Failed to update execution status for permanently failed job (executionId: ${executionId}):`,
        updateError,
      );
    }
  }

  /**
   * Determine if an error is permanent and should not be retried
   * 
   * Permanent errors include:
   * - Validation errors
   * - Template not found errors
   * - Template configuration errors
   * - Variable substitution errors
   * 
   * Transient errors include:
   * - Database connection errors
   * - Network timeouts
   * - Temporary service unavailability
   * 
   * @param error - The error to classify
   * @returns true if the error is permanent
   */
  private isPermanentError(error: unknown): boolean {
    if (error instanceof PermanentJobError) {
      return true;
    }

    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      
      // Permanent error patterns
      const permanentPatterns = [
        'template not found',
        'template version not found',
        'validation failed',
        'invalid template',
        'missing required variable',
        'template is not active',
        'invalid variable data',
        'template configuration error',
        'syntax error',
        'parse error',
      ];

      // Transient error patterns
      const transientPatterns = [
        'connection refused',
        'timeout',
        'network error',
        'service unavailable',
        'temporary failure',
        'rate limited',
        'connection reset',
        'connection lost',
      ];

      // Check for transient patterns first (these take precedence)
      if (transientPatterns.some(pattern => message.includes(pattern))) {
        return false;
      }

      // Check for permanent patterns
      if (permanentPatterns.some(pattern => message.includes(pattern))) {
        return true;
      }

      // Check for specific error types that are permanent
      if (
        error.name === 'ValidationError' ||
        error.name === 'TypeError' ||
        error.name === 'SyntaxError' ||
        error.name === 'ReferenceError'
      ) {
        return true;
      }
    }

    // Default to transient for unknown errors (better to retry than give up)
    return false;
  }

  /**
   * Get handler configuration
   * 
   * Returns the configuration for this handler type including retry policy.
   * 
   * @returns Handler configuration object
   */
  getConfig(): {
    maxAttempts: number;
    backoffStrategy: 'fixed' | 'linear' | 'exponential';
    initialDelayMs: number;
    maxDelayMs: number;
    visibilityTimeoutMs: number;
  } {
    return {
      maxAttempts: 3, // Template processing should be fairly reliable
      backoffStrategy: 'exponential',
      initialDelayMs: 5000, // 5 seconds
      maxDelayMs: 300000, // 5 minutes
      visibilityTimeoutMs: 600000, // 10 minutes (template processing can take time)
    };
  }
}