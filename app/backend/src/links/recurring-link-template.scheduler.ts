import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RecurringLinkTemplateService } from './recurring-link-template.service';
import { RecurringLinkTemplateRepository, DbRecurringLinkTemplate } from './recurring-link-template.repository';
import { JobQueueService } from '../job-queue/job-queue.service';
import { JobType, TemplateExecutionPayload } from '../job-queue/types';
import { TemplateStatus } from './dto/recurring-link-template.dto';

// Define the cron parser interface for better type safety
interface CronSchedule {
  minute: string;
  hour: string;
  day: string;
  month: string;
  weekday: string;
}

interface ScheduledExecution {
  templateId: string;
  templateName: string;
  nextExecutionTime: Date;
  timezone: string;
  cronExpression: string;
}

@Injectable()
export class RecurringLinkTemplateScheduler implements OnModuleInit {
  private readonly logger = new Logger(RecurringLinkTemplateScheduler.name);
  private readonly activeTemplates = new Map<string, ScheduledExecution>();
  private readonly timezoneCache = new Map<string, boolean>(); // Cache for timezone validation

  constructor(
    private readonly templateService: RecurringLinkTemplateService,
    private readonly repository: RecurringLinkTemplateRepository,
    private readonly jobQueueService: JobQueueService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.logger.log('Recurring link template scheduler initialized');
    // Initial load of active templates
    this.refreshActiveTemplates().catch(error => {
      this.logger.error('Failed to load active templates on startup', error);
    });
  }

  // ---------------------------------------------------------------------------
  // Cron Jobs
  // ---------------------------------------------------------------------------

  /**
   * Check and execute due template-based recurring link generation every minute
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async checkAndExecuteScheduledTemplates(): Promise<void> {
    try {
      this.logger.debug('Checking for scheduled template executions...');

      const now = new Date();
      const dueExecutions = this.findDueExecutions(now);

      if (dueExecutions.length === 0) {
        this.logger.debug('No template executions due');
        return;
      }

      this.logger.log(`Found ${dueExecutions.length} template execution(s) due`);

      // Process each due execution
      for (const execution of dueExecutions) {
        await this.scheduleTemplateExecution(execution, now);
      }

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error in scheduled template execution check: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
    }
  }

  /**
   * Refresh active templates cache every 5 minutes to pick up new/updated templates
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async refreshActiveTemplates(): Promise<void> {
    try {
      this.logger.debug('Refreshing active templates cache...');

      const activeTemplates = await this.repository.findActiveTemplatesForScheduling();
      const newTemplateMap = new Map<string, ScheduledExecution>();

      for (const template of activeTemplates) {
        try {
          const nextExecution = this.calculateNextExecution(
            template.cron_expression,
            template.timezone,
            new Date()
          );

          if (nextExecution) {
            newTemplateMap.set(template.id, {
              templateId: template.id,
              templateName: template.name,
              nextExecutionTime: nextExecution,
              timezone: template.timezone,
              cronExpression: template.cron_expression,
            });
          }
        } catch (error) {
          this.logger.warn(`Failed to calculate next execution for template ${template.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      // Update active templates map
      this.activeTemplates.clear();
      newTemplateMap.forEach((value, key) => {
        this.activeTemplates.set(key, value);
      });

      this.logger.log(`Loaded ${this.activeTemplates.size} active template(s) for scheduling`);

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error refreshing active templates: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
    }
  }

  /**
   * Clean up old template executions every hour to prevent table bloat
   */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupOldExecutions(): Promise<void> {
    try {
      this.logger.debug('Running template execution cleanup...');

      // This would call a database function to clean up old executions
      // Implementation depends on specific retention policies
      const daysToKeep = parseInt(process.env.TEMPLATE_EXECUTION_RETENTION_DAYS || '90');

      // Call database cleanup function
      const { data: deletedCount, error } = await this.repository['supabase']
        .rpc('cleanup_old_template_executions', { days_to_keep: daysToKeep });

      if (error) {
        throw error;
      }

      if (deletedCount > 0) {
        this.logger.log(`Cleaned up ${deletedCount} old template execution record(s)`);
      }

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error during cleanup: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Template Scheduling Logic
  // ---------------------------------------------------------------------------

  /**
   * Find executions that are due based on current time
   */
  private findDueExecutions(now: Date): ScheduledExecution[] {
    const dueExecutions: ScheduledExecution[] = [];

    for (const [templateId, execution] of this.activeTemplates) {
      // Check if execution time has passed (with 1-minute grace period)
      const gracePeriod = 60 * 1000; // 1 minute in milliseconds
      const adjustedNow = new Date(now.getTime() + gracePeriod);

      if (execution.nextExecutionTime <= adjustedNow) {
        dueExecutions.push(execution);
        
        // Calculate and update next execution time
        try {
          const nextExecution = this.calculateNextExecution(
            execution.cronExpression,
            execution.timezone,
            now
          );

          if (nextExecution) {
            execution.nextExecutionTime = nextExecution;
          } else {
            // If we can't calculate next execution, remove from active templates
            this.activeTemplates.delete(templateId);
            this.logger.warn(`Removed template ${templateId} from scheduling due to invalid cron expression`);
          }
        } catch (error) {
          this.logger.error(`Failed to update next execution time for template ${templateId}:`, error);
          this.activeTemplates.delete(templateId);
        }
      }
    }

    return dueExecutions;
  }

  /**
   * Schedule a template execution by enqueueing a job
   */
  private async scheduleTemplateExecution(
    execution: ScheduledExecution,
    scheduledAt: Date,
  ): Promise<void> {
    try {
      this.logger.log(`Scheduling template execution for: ${execution.templateName} (${execution.templateId})`);

      // Create template execution record with placeholder variable data
      // In a real implementation, you might want to allow templates to define default variable data
      // or get variable data from external sources
      const defaultVariableData = this.generateDefaultVariableData();

      const templateExecution = await this.repository.createExecution({
        templateId: execution.templateId,
        templateVersionId: '', // Will be resolved by the job processor
        scheduledAt,
        variableData: defaultVariableData,
      });

      // Enqueue job for background processing
      const jobPayload: TemplateExecutionPayload = {
        executionId: templateExecution.id,
        templateId: execution.templateId,
        scheduledAt: scheduledAt.toISOString(),
        timezone: execution.timezone,
        variableData: defaultVariableData,
      };

      const job = await this.jobQueueService.enqueue(JobType.TEMPLATE_EXECUTION, jobPayload);

      this.logger.log(`Template execution job enqueued: ${job} for execution: ${templateExecution.id}`);

      // Emit event
      this.eventEmitter.emit('template.execution.scheduled', {
        executionId: templateExecution.id,
        templateId: execution.templateId,
        templateName: execution.templateName,
        scheduledAt,
        jobId: job,
      });

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to schedule template execution for ${execution.templateId}: ${errorMessage}`, error instanceof Error ? error.stack : undefined);

      // Emit failure event
      this.eventEmitter.emit('template.execution.schedule.failed', {
        templateId: execution.templateId,
        templateName: execution.templateName,
        error: errorMessage,
        scheduledAt,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Cron Expression Parsing and Timezone Handling
  // ---------------------------------------------------------------------------

  /**
   * Calculate the next execution time for a cron expression in a specific timezone
   */
  private calculateNextExecution(
    cronExpression: string,
    timezone: string,
    fromTime: Date,
  ): Date | null {
    try {
      // Validate timezone
      if (!this.isValidTimezone(timezone)) {
        throw new Error(`Invalid timezone: ${timezone}`);
      }

      // Parse cron expression
      const schedule = this.parseCronExpression(cronExpression);
      
      // Convert current time to target timezone
      const tzTime = this.convertToTimezone(fromTime, timezone);
      
      // Find next execution time
      const nextTime = this.findNextCronMatch(schedule, tzTime, timezone);
      
      // Convert back to UTC
      return this.convertFromTimezone(nextTime, timezone);
      
    } catch (error) {
      this.logger.error(`Failed to calculate next execution for cron "${cronExpression}" in timezone "${timezone}":`, error);
      return null;
    }
  }

  /**
   * Parse cron expression into components
   */
  private parseCronExpression(cronExpression: string): CronSchedule {
    const parts = cronExpression.trim().split(/\s+/);
    
    if (parts.length !== 5) {
      throw new Error(`Invalid cron expression: ${cronExpression}. Expected 5 parts (minute hour day month weekday)`);
    }

    return {
      minute: parts[0],
      hour: parts[1],
      day: parts[2],
      month: parts[3],
      weekday: parts[4],
    };
  }

  /**
   * Find the next time that matches the cron schedule
   * This is a simplified implementation - in production, use a library like node-cron
   */
  private findNextCronMatch(
    schedule: CronSchedule,
    fromTime: Date,
    timezone: string,
  ): Date {
    // This is a simplified implementation
    // In production, you would use a proper cron library like 'cron-parser' or 'node-cron'
    
    const nextTime = new Date(fromTime);
    
    // Simple implementation: just add based on the most specific time unit
    if (schedule.minute !== '*') {
      // If minute is specified, find next matching minute
      const targetMinute = parseInt(schedule.minute);
      if (!isNaN(targetMinute) && targetMinute >= 0 && targetMinute <= 59) {
        nextTime.setMinutes(targetMinute, 0, 0);
        if (nextTime <= fromTime) {
          nextTime.setHours(nextTime.getHours() + 1);
        }
      }
    } else {
      // Default: next minute
      nextTime.setTime(fromTime.getTime() + 60 * 1000);
      nextTime.setSeconds(0, 0);
    }
    
    return nextTime;
  }

  /**
   * Validate timezone using Intl.DateTimeFormat
   */
  private isValidTimezone(timezone: string): boolean {
    // Check cache first
    if (this.timezoneCache.has(timezone)) {
      return this.timezoneCache.get(timezone)!;
    }

    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
      this.timezoneCache.set(timezone, true);
      return true;
    } catch {
      this.timezoneCache.set(timezone, false);
      return false;
    }
  }

  /**
   * Convert UTC time to timezone-specific time
   */
  private convertToTimezone(utcTime: Date, timezone: string): Date {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    const parts = formatter.formatToParts(utcTime);
    const year = parseInt(parts.find(p => p.type === 'year')?.value || '0');
    const month = parseInt(parts.find(p => p.type === 'month')?.value || '1') - 1; // Month is 0-indexed
    const day = parseInt(parts.find(p => p.type === 'day')?.value || '1');
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
    const second = parseInt(parts.find(p => p.type === 'second')?.value || '0');

    return new Date(year, month, day, hour, minute, second);
  }

  /**
   * Convert timezone-specific time back to UTC
   */
  private convertFromTimezone(localTime: Date, timezone: string): Date {
    // Create a date string in the target timezone
    const year = localTime.getFullYear();
    const month = String(localTime.getMonth() + 1).padStart(2, '0');
    const day = String(localTime.getDate()).padStart(2, '0');
    const hour = String(localTime.getHours()).padStart(2, '0');
    const minute = String(localTime.getMinutes()).padStart(2, '0');
    const second = String(localTime.getSeconds()).padStart(2, '0');

    const dateString = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
    
    // Parse as if it's in the target timezone
    const tempDate = new Date(dateString);
    
    // Get the offset for the target timezone at this time
    const utcTime1 = tempDate.getTime() + (tempDate.getTimezoneOffset() * 60000);
    const utcTime2 = new Date(utcTime1 + this.getTimezoneOffset(timezone, tempDate));
    
    return utcTime2;
  }

  /**
   * Get timezone offset in milliseconds
   */
  private getTimezoneOffset(timezone: string, date: Date): number {
    const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
    return utcDate.getTime() - tzDate.getTime();
  }

  // ---------------------------------------------------------------------------
  // Utility Methods
  // ---------------------------------------------------------------------------

  /**
   * Generate default variable data for scheduled executions
   * In production, this might come from external APIs, databases, or configuration
   */
  private generateDefaultVariableData(): Record<string, any> {
    const now = new Date();
    const timestamp = now.toISOString();
    const dateStr = now.toISOString().split('T')[0];
    
    return {
      // Default variable values that can be used in templates
      current_date: dateStr,
      current_datetime: timestamp,
      execution_id: `exec_${Date.now()}`,
      // Add more default variables as needed
    };
  }

  /**
   * Get current scheduling status for debugging/monitoring
   */
  getSchedulingStatus(): {
    activeTemplateCount: number;
    templates: Array<{
      templateId: string;
      templateName: string;
      nextExecutionTime: string;
      timezone: string;
      cronExpression: string;
    }>;
  } {
    return {
      activeTemplateCount: this.activeTemplates.size,
      templates: Array.from(this.activeTemplates.values()).map(execution => ({
        templateId: execution.templateId,
        templateName: execution.templateName,
        nextExecutionTime: execution.nextExecutionTime.toISOString(),
        timezone: execution.timezone,
        cronExpression: execution.cronExpression,
      })),
    };
  }

  /**
   * Force refresh of active templates (for testing/debugging)
   */
  async forceRefreshTemplates(): Promise<void> {
    await this.refreshActiveTemplates();
  }

  /**
   * Manually trigger template execution (for testing/debugging)
   */
  async triggerTemplateExecution(templateId: string): Promise<void> {
    const execution = this.activeTemplates.get(templateId);
    if (!execution) {
      throw new Error(`Template ${templateId} is not in active scheduling`);
    }

    await this.scheduleTemplateExecution(execution, new Date());
  }
}