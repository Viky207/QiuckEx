/**
 * Job Queue System - Initializer Service
 * 
 * Registers all job handlers with their retry policies at application startup.
 * This service implements OnModuleInit to ensure handlers are registered
 * before the JobExecutor starts processing jobs.
 * 
 * Requirements: 1.3, 7.1
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { JobRegistry } from './job-registry.service';
import { JobRetentionService } from './job-retention.service';
import { JobType } from './types';
import { 
  WebhookDeliveryHandler, 
  RecurringPaymentHandler, 
  ExportGenerationHandler,
  ReconciliationHandler,
  StellarReconnectHandler,
  TemplateExecutionHandler,
  DerivedRecordRepairHandler,
} from './handlers';

/**
 * Job Queue Initializer Service
 * 
 * Responsible for registering all job handlers with their retry policies
 * at application startup. This ensures the JobRegistry is fully populated
 * before the JobExecutor begins polling for jobs.
 */
@Injectable()
export class JobQueueInitializer implements OnModuleInit {
  private readonly logger = new Logger(JobQueueInitializer.name);

  /** Name of the periodic retention cleanup interval registered with SchedulerRegistry. */
  static readonly RETENTION_CLEANUP_INTERVAL_NAME = 'job-retention-cleanup';

  constructor(
    private readonly registry: JobRegistry,
    private readonly webhookDeliveryHandler: WebhookDeliveryHandler,
    private readonly recurringPaymentHandler: RecurringPaymentHandler,
    private readonly exportGenerationHandler: ExportGenerationHandler,
    private readonly reconciliationHandler: ReconciliationHandler,
    private readonly stellarReconnectHandler: StellarReconnectHandler,
    private readonly templateExecutionHandler: TemplateExecutionHandler,
    private readonly derivedRecordRepairHandler: DerivedRecordRepairHandler,
    private readonly jobRetentionService: JobRetentionService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  /**
   * Register all job handlers on module initialization
   * 
   * This method is called by NestJS after the module's dependencies are resolved
   * but before the application starts accepting requests.
   * 
   * **Validates: Requirements 1.3, 7.1, 8.1, 9.1, 10.1, 11.1**
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('Registering job handlers...');

    // Register webhook_delivery handler
    // Requirements: 7.1
    this.registry.registerHandler(
      JobType.WEBHOOK_DELIVERY,
      this.webhookDeliveryHandler,
      {
        maxAttempts: 5,
        backoffStrategy: 'exponential',
        initialDelayMs: 60000,        // 1 minute
        maxDelayMs: 7200000,          // 2 hours
        visibilityTimeoutMs: 300000,  // 5 minutes
      },
    );

    // Register recurring_payment handler
    // Requirements: 8.1
    this.registry.registerHandler(
      JobType.RECURRING_PAYMENT,
      this.recurringPaymentHandler,
      {
        maxAttempts: 3,
        backoffStrategy: 'exponential',
        initialDelayMs: 60000,        // 1 minute
        maxDelayMs: 3600000,          // 1 hour
        visibilityTimeoutMs: 600000,  // 10 minutes
      },
    );

    // Register export_generation handler
    // Requirements: 9.1
    this.registry.registerHandler(
      JobType.EXPORT_GENERATION,
      this.exportGenerationHandler,
      {
        maxAttempts: 2,
        backoffStrategy: 'fixed',
        initialDelayMs: 300000,       // 5 minutes
        maxDelayMs: 300000,           // 5 minutes (fixed strategy)
        visibilityTimeoutMs: 600000,  // 10 minutes
      },
    );

    // Register reconciliation handler
    // Requirements: 10.1
    this.registry.registerHandler(
      JobType.RECONCILIATION,
      this.reconciliationHandler,
      {
        maxAttempts: 1,
        backoffStrategy: 'fixed',
        initialDelayMs: 0,            // No delay (immediate retry if needed)
        maxDelayMs: 0,                // No delay (fixed strategy)
        visibilityTimeoutMs: 300000,  // 5 minutes
      },
    );

    // Register stellar_reconnect handler
    // Requirements: 11.1
    this.registry.registerHandler(
      JobType.STELLAR_RECONNECT,
      this.stellarReconnectHandler,
      {
        maxAttempts: 0,               // Unlimited retries
        backoffStrategy: 'exponential',
        initialDelayMs: 1000,         // 1 second
        maxDelayMs: 60000,            // 1 minute
        visibilityTimeoutMs: 120000,  // 2 minutes
      },
    );

    // Register template_execution handler
    // Template execution with variable substitution and recurring link generation
    this.registry.registerHandler(
      JobType.TEMPLATE_EXECUTION,
      this.templateExecutionHandler,
      {
        maxAttempts: 3,
        backoffStrategy: 'exponential',
        initialDelayMs: 5000,         // 5 seconds
        maxDelayMs: 300000,           // 5 minutes
        visibilityTimeoutMs: 600000,  // 10 minutes (template processing can take time)
      },
    );

    this.registry.registerHandler(
      JobType.DERIVED_RECORD_REPAIR,
      this.derivedRecordRepairHandler,
      {
        maxAttempts: 3,
        backoffStrategy: 'exponential',
        initialDelayMs: 5000,
        maxDelayMs: 300000,
        visibilityTimeoutMs: 900000,
      },
    );

    this.logger.log('Job handler registration complete');

    this.scheduleRetentionCleanup();
  }

  /**
   * Schedule the periodic retention cleanup for terminal jobs.
   *
   * The cleanup runs on a fixed interval derived from the configured retention
   * policy. Each run is idempotent and paginated, and only deletes terminal
   * (completed/failed/cancelled) jobs that are older than the retention window
   * and not flagged as audit-required. Active jobs are never touched.
   */
  private scheduleRetentionCleanup(): void {
    const config = this.jobRetentionService.getConfig();

    if (!config.enabled) {
      this.logger.log('Job retention cleanup is disabled; skipping scheduling');
      return;
    }

    const intervalMs = config.cleanupIntervalMs;

    const interval = setInterval(() => {
      void this.runRetentionCleanup();
    }, intervalMs);

    // Do not keep the Node.js event loop alive solely for cleanup.
    if (typeof interval.unref === 'function') {
      interval.unref();
    }

    try {
      this.schedulerRegistry.addInterval(
        JobQueueInitializer.RETENTION_CLEANUP_INTERVAL_NAME,
        interval,
      );
    } catch (error) {
      // A duplicate registration should not prevent startup.
      this.logger.warn(
        `Failed to register retention cleanup interval: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    this.logger.log(
      `Scheduled job retention cleanup every ${intervalMs}ms ` +
        `(retention window ${config.retentionMs}ms, batch size ${config.batchSize})`,
    );
  }

  /**
   * Execute a single retention cleanup pass.
   *
   * Exposed for tests and manual invocation. Failures are logged and swallowed
   * so a transient error cannot crash the scheduler.
   */
  async runRetentionCleanup(): Promise<void> {
    try {
      const result = await this.jobRetentionService.cleanupExpiredJobs();
      if (result.deletedCount > 0) {
        this.logger.log(
          `Job retention cleanup removed ${result.deletedCount} terminal job(s)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Job retention cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
