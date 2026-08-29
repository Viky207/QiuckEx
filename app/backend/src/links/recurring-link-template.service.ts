import { 
  Injectable, 
  Logger, 
  NotFoundException, 
  BadRequestException,
  ConflictException 
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CreateRecurringLinkTemplateDto,
  UpdateRecurringLinkTemplateDto,
  CreateTemplateVersionDto,
  UpdateTemplateVersionDto,
  ExecuteTemplateDto,
  PreviewTemplateDto,
  RecurringLinkTemplateResponseDto,
  TemplateVersionResponseDto,
  TemplateExecutionResponseDto,
  TemplatePreviewResponseDto,
  TemplateStatus,
  TemplateVersionStatus,
  TemplateExecutionStatus,
  QueryRecurringLinkTemplatesDto,
} from './dto/recurring-link-template.dto';
import {
  RecurringLinkTemplateRepository,
  DbRecurringLinkTemplate,
  DbRecurringLinkTemplateVersion,
  DbRecurringLinkTemplateExecution,
} from './recurring-link-template.repository';
import { CreateRecurringPaymentLinkDto, FrequencyType } from './dto/recurring-payment.dto';
import { RecurringPaymentsService } from './recurring-payments.service';
import { JobQueueService } from '../job-queue/job-queue.service';

@Injectable()
export class RecurringLinkTemplateService {
  private readonly logger = new Logger(RecurringLinkTemplateService.name);

  constructor(
    private readonly repository: RecurringLinkTemplateRepository,
    private readonly recurringPaymentsService: RecurringPaymentsService,
    private readonly jobQueueService: JobQueueService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ---------------------------------------------------------------------------
  // Template Management
  // ---------------------------------------------------------------------------

  /**
   * Create a new recurring link template
   */
  async createTemplate(
    dto: CreateRecurringLinkTemplateDto,
    createdBy: string,
    previewScope?: string,
  ): Promise<RecurringLinkTemplateResponseDto> {
    this.validateCreateTemplateDto(dto);

    try {
      const template = await this.repository.createTemplate({
        name: dto.name,
        description: dto.description,
        asset: dto.asset,
        assetIssuer: dto.assetIssuer,
        amount: dto.amount,
        cronExpression: dto.cronExpression,
        timezone: dto.timezone,
        variables: dto.variables,
        createdBy,
        organizationId: dto.organizationId,
        previewScope,
      });

      this.logger.log(`Created recurring link template: ${template.id}`);

      // Emit event
      this.eventEmitter.emit('template.created', {
        templateId: template.id,
        name: template.name,
        createdBy,
      });

      return this.mapTemplateToResponseDto(template);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error creating template: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
      throw new BadRequestException(`Failed to create template: ${errorMessage}`);
    }
  }

  /**
   * Get template by ID with versions and recent executions
   */
  async getTemplateById(id: string): Promise<RecurringLinkTemplateResponseDto> {
    const template = await this.repository.findTemplateById(id);
    if (!template) {
      throw new NotFoundException(`Template not found: ${id}`);
    }

    const versions = await this.repository.findVersionsByTemplateId(id);
    const executions = await this.repository.findExecutionsByTemplateId(id);

    const responseDto = this.mapTemplateToResponseDto(template);
    responseDto.versions = versions.map(v => this.mapVersionToResponseDto(v));
    responseDto.executions = executions.slice(0, 10).map(e => this.mapExecutionToResponseDto(e));

    return responseDto;
  }

  /**
   * Update template
   */
  async updateTemplate(
    id: string,
    dto: UpdateRecurringLinkTemplateDto,
  ): Promise<RecurringLinkTemplateResponseDto> {
    const existingTemplate = await this.repository.findTemplateById(id);
    if (!existingTemplate) {
      throw new NotFoundException(`Template not found: ${id}`);
    }

    this.validateUpdateTemplateDto(dto);

    try {
      const updatedTemplate = await this.repository.updateTemplate(id, {
        name: dto.name,
        description: dto.description,
        amount: dto.amount,
        cronExpression: dto.cronExpression,
        timezone: dto.timezone,
        variables: dto.variables,
        status: dto.status,
      });

      this.logger.log(`Updated template: ${id}`);

      // Emit event
      this.eventEmitter.emit('template.updated', {
        templateId: id,
        changes: dto,
      });

      return this.mapTemplateToResponseDto(updatedTemplate);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error updating template: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
      throw new BadRequestException(`Failed to update template: ${errorMessage}`);
    }
  }

  /**
   * Delete template
   */
  async deleteTemplate(id: string): Promise<void> {
    const template = await this.repository.findTemplateById(id);
    if (!template) {
      throw new NotFoundException(`Template not found: ${id}`);
    }

    // Check for pending executions
    const pendingExecutions = await this.repository.findExecutionsByTemplateId(id);
    const hasPendingExecutions = pendingExecutions.some(e => e.status === TemplateExecutionStatus.PENDING);

    if (hasPendingExecutions) {
      throw new ConflictException('Cannot delete template with pending executions');
    }

    await this.repository.deleteTemplate(id);

    this.logger.log(`Deleted template: ${id}`);

    // Emit event
    this.eventEmitter.emit('template.deleted', {
      templateId: id,
      name: template.name,
    });
  }

  /**
   * List templates with filtering and pagination
   */
  async listTemplates(
    query: QueryRecurringLinkTemplatesDto,
    previewScope?: string,
  ): Promise<{
    data: RecurringLinkTemplateResponseDto[];
    total: number;
    next_cursor: string | null;
    has_more: boolean;
    limit: number;
  }> {
    const result = await this.repository.listTemplates({
      ...query,
      previewScope,
    });

    const data = result.data.map(template => this.mapTemplateToResponseDto(template));

    return {
      data,
      total: result.total,
      next_cursor: result.next_cursor,
      has_more: result.has_more,
      limit: query.limit ?? 20,
    };
  }

  // ---------------------------------------------------------------------------
  // Template Version Management
  // ---------------------------------------------------------------------------

  /**
   * Create a new template version
   */
  async createTemplateVersion(
    templateId: string,
    dto: CreateTemplateVersionDto,
    createdBy: string,
    previewScope?: string,
  ): Promise<TemplateVersionResponseDto> {
    const template = await this.repository.findTemplateById(templateId);
    if (!template) {
      throw new NotFoundException(`Template not found: ${templateId}`);
    }

    this.validateCreateVersionDto(dto);

    try {
      const version = await this.repository.createTemplateVersion({
        templateId,
        usernameTemplate: dto.usernameTemplate,
        destinationTemplate: dto.destinationTemplate,
        amountTemplate: dto.amountTemplate,
        memoTemplate: dto.memoTemplate,
        referenceIdTemplate: dto.referenceIdTemplate,
        frequencyTemplate: dto.frequencyTemplate,
        startDateTemplate: dto.startDateTemplate,
        endDateTemplate: dto.endDateTemplate,
        totalPeriodsTemplate: dto.totalPeriodsTemplate,
        changeNotes: dto.changeNotes,
        createdBy,
        previewScope,
      });

      this.logger.log(`Created template version: ${version.id} for template: ${templateId}`);

      // Emit event
      this.eventEmitter.emit('template.version.created', {
        templateId,
        versionId: version.id,
        versionNumber: version.version_number,
        createdBy,
      });

      return this.mapVersionToResponseDto(version);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error creating template version: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
      throw new BadRequestException(`Failed to create template version: ${errorMessage}`);
    }
  }

  /**
   * Update template version
   */
  async updateTemplateVersion(
    versionId: string,
    dto: UpdateTemplateVersionDto,
  ): Promise<TemplateVersionResponseDto> {
    const version = await this.repository.findTemplateVersionById(versionId);
    if (!version) {
      throw new NotFoundException(`Template version not found: ${versionId}`);
    }

    if (version.status === TemplateVersionStatus.ACTIVE && dto.status !== TemplateVersionStatus.ACTIVE) {
      throw new BadRequestException('Cannot modify active template version content. Create a new version instead.');
    }

    this.validateUpdateVersionDto(dto);

    try {
      const updatedVersion = await this.repository.updateTemplateVersion(versionId, {
        usernameTemplate: dto.usernameTemplate,
        destinationTemplate: dto.destinationTemplate,
        amountTemplate: dto.amountTemplate,
        memoTemplate: dto.memoTemplate,
        referenceIdTemplate: dto.referenceIdTemplate,
        frequencyTemplate: dto.frequencyTemplate,
        startDateTemplate: dto.startDateTemplate,
        endDateTemplate: dto.endDateTemplate,
        totalPeriodsTemplate: dto.totalPeriodsTemplate,
        status: dto.status,
        changeNotes: dto.changeNotes,
      });

      this.logger.log(`Updated template version: ${versionId}`);

      // Emit event
      this.eventEmitter.emit('template.version.updated', {
        templateId: version.template_id,
        versionId,
        changes: dto,
      });

      return this.mapVersionToResponseDto(updatedVersion);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error updating template version: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
      throw new BadRequestException(`Failed to update template version: ${errorMessage}`);
    }
  }

  /**
   * Activate a template version
   */
  async activateTemplateVersion(
    templateId: string,
    versionId: string,
  ): Promise<TemplateVersionResponseDto> {
    const version = await this.repository.findTemplateVersionById(versionId);
    if (!version || version.template_id !== templateId) {
      throw new NotFoundException(`Template version not found: ${versionId}`);
    }

    try {
      const activatedVersion = await this.repository.activateTemplateVersion(templateId, versionId);

      this.logger.log(`Activated template version: ${versionId} for template: ${templateId}`);

      // Emit event
      this.eventEmitter.emit('template.version.activated', {
        templateId,
        versionId,
        versionNumber: version.version_number,
      });

      return this.mapVersionToResponseDto(activatedVersion);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error activating template version: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
      throw new BadRequestException(`Failed to activate template version: ${errorMessage}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Template Execution and Rendering
  // ---------------------------------------------------------------------------

  /**
   * Preview template rendering with variable data
   */
  async previewTemplate(
    templateId: string,
    dto: PreviewTemplateDto,
    versionId?: string,
  ): Promise<TemplatePreviewResponseDto> {
    const template = await this.repository.findTemplateById(templateId);
    if (!template) {
      throw new NotFoundException(`Template not found: ${templateId}`);
    }

    let version: DbRecurringLinkTemplateVersion | null;
    if (versionId) {
      version = await this.repository.findTemplateVersionById(versionId);
      if (!version || version.template_id !== templateId) {
        throw new NotFoundException(`Template version not found: ${versionId}`);
      }
    } else {
      version = await this.repository.findActiveVersionForTemplate(templateId);
      if (!version) {
        throw new NotFoundException(`No active version found for template: ${templateId}`);
      }
    }

    // Validate variable data
    this.validateVariableData(template.variables, dto.variableData);

    // Render all template fields
    const renderedFields = this.renderTemplateVersion(version, dto.variableData);

    return {
      ...renderedFields,
      templateVersionId: version.id,
    };
  }

  /**
   * Execute template to generate a recurring payment link
   */
  async executeTemplate(
    templateId: string,
    dto: ExecuteTemplateDto,
    previewScope?: string,
  ): Promise<TemplateExecutionResponseDto> {
    const template = await this.repository.findTemplateById(templateId);
    if (!template) {
      throw new NotFoundException(`Template not found: ${templateId}`);
    }

    if (template.status !== TemplateStatus.ACTIVE) {
      throw new BadRequestException('Template is not active');
    }

    let version: DbRecurringLinkTemplateVersion | null;
    if (dto.templateVersionId) {
      version = await this.repository.findTemplateVersionById(dto.templateVersionId);
      if (!version || version.template_id !== templateId) {
        throw new NotFoundException(`Template version not found: ${dto.templateVersionId}`);
      }
    } else {
      version = await this.repository.findActiveVersionForTemplate(templateId);
      if (!version) {
        throw new NotFoundException(`No active version found for template: ${templateId}`);
      }
    }

    // Validate variable data
    this.validateVariableData(template.variables, dto.variableData);

    try {
      // Create execution record
      const execution = await this.repository.createExecution({
        templateId,
        templateVersionId: version.id,
        scheduledAt: new Date(),
        variableData: dto.variableData,
        previewScope,
      });

      // Queue background job to generate the recurring payment link
      const job = await this.jobQueueService.enqueue('template-execution', {
        executionId: execution.id,
        templateId,
        versionId: version.id,
        variableData: dto.variableData,
        previewScope,
      });

      // Update execution with job ID
      await this.repository.updateExecutionStatus(execution.id, TemplateExecutionStatus.PENDING, {
        // Job reference will be handled by the job processor
      });

      this.logger.log(`Queued template execution: ${execution.id} for template: ${templateId}`);

      // Emit event
      this.eventEmitter.emit('template.execution.queued', {
        executionId: execution.id,
        templateId,
        versionId: version.id,
        jobId: job.id,
      });

      return this.mapExecutionToResponseDto(execution);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error executing template: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
      throw new BadRequestException(`Failed to execute template: ${errorMessage}`);
    }
  }

  /**
   * Process template execution (called by background job)
   */
  async processTemplateExecution(executionId: string): Promise<void> {
    const execution = await this.repository.findExecutionById(executionId);
    if (!execution) {
      throw new NotFoundException(`Execution not found: ${executionId}`);
    }

    const template = await this.repository.findTemplateById(execution.template_id);
    if (!template) {
      throw new NotFoundException(`Template not found: ${execution.template_id}`);
    }

    const version = await this.repository.findTemplateVersionById(execution.template_version_id);
    if (!version) {
      throw new NotFoundException(`Template version not found: ${execution.template_version_id}`);
    }

    try {
      // Render the template
      const renderedFields = this.renderTemplateVersion(version, execution.variable_data);

      // Create the recurring payment link DTO
      const recurringLinkDto: CreateRecurringPaymentLinkDto = {
        username: renderedFields.username,
        destination: renderedFields.destination,
        amount: parseFloat(renderedFields.amount),
        asset: template.asset,
        assetIssuer: template.asset_issuer || undefined,
        frequency: this.parseFrequency(renderedFields.frequency),
        startDate: renderedFields.startDate,
        endDate: renderedFields.endDate,
        totalPeriods: renderedFields.totalPeriods ? parseInt(renderedFields.totalPeriods) : undefined,
        memo: renderedFields.memo,
        referenceId: renderedFields.referenceId,
        privacyEnabled: false, // Could be configurable in future versions
      };

      // Create the recurring payment link
      const recurringLink = await this.recurringPaymentsService.createRecurringLink(
        recurringLinkDto,
        execution.preview_scope || undefined,
      );

      // Update execution as successful
      await this.repository.updateExecutionStatus(execution.id, TemplateExecutionStatus.SUCCESS, {
        executedAt: new Date(),
        recurringLinkId: recurringLink.id,
      });

      this.logger.log(`Successfully processed template execution: ${executionId}, created recurring link: ${recurringLink.id}`);

      // Emit event
      this.eventEmitter.emit('template.execution.success', {
        executionId,
        templateId: template.id,
        recurringLinkId: recurringLink.id,
      });

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error processing template execution: ${errorMessage}`, error instanceof Error ? error.stack : undefined);

      // Update execution as failed
      await this.repository.updateExecutionStatus(execution.id, TemplateExecutionStatus.FAILED, {
        errorMessage,
        retryCount: execution.retry_count + 1,
        lastRetryAt: new Date(),
      });

      // Emit event
      this.eventEmitter.emit('template.execution.failed', {
        executionId,
        templateId: template.id,
        error: errorMessage,
      });

      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Template Rendering Engine
  // ---------------------------------------------------------------------------

  /**
   * Render template with variable substitution
   */
  private render(template: string, data: Record<string, unknown>): string {
    if (!template) return '';
    
    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string): string => {
      const value = data[key];
      return typeof value === 'string' || typeof value === 'number' 
        ? String(value) 
        : '';
    });
  }

  /**
   * Render all fields of a template version
   */
  private renderTemplateVersion(
    version: DbRecurringLinkTemplateVersion,
    variableData: Record<string, any>,
  ): TemplatePreviewResponseDto {
    return {
      username: version.username_template ? this.render(version.username_template, variableData) : undefined,
      destination: version.destination_template ? this.render(version.destination_template, variableData) : undefined,
      amount: this.render(version.amount_template, variableData),
      memo: version.memo_template ? this.render(version.memo_template, variableData) : undefined,
      referenceId: version.reference_id_template ? this.render(version.reference_id_template, variableData) : undefined,
      frequency: this.render(version.frequency_template, variableData),
      startDate: version.start_date_template ? this.render(version.start_date_template, variableData) : undefined,
      endDate: version.end_date_template ? this.render(version.end_date_template, variableData) : undefined,
      totalPeriods: version.total_periods_template ? this.render(version.total_periods_template, variableData) : undefined,
      templateVersionId: version.id,
    };
  }

  // ---------------------------------------------------------------------------
  // Validation Methods
  // ---------------------------------------------------------------------------

  private validateCreateTemplateDto(dto: CreateRecurringLinkTemplateDto): void {
    if (!dto.name?.trim()) {
      throw new BadRequestException('Template name is required');
    }

    if (!dto.asset?.trim()) {
      throw new BadRequestException('Asset is required');
    }

    if (dto.amount <= 0) {
      throw new BadRequestException('Amount must be positive');
    }

    if (!this.isValidCronExpression(dto.cronExpression)) {
      throw new BadRequestException('Invalid cron expression');
    }

    if (!dto.variables || dto.variables.length === 0) {
      throw new BadRequestException('At least one variable is required');
    }

    // Validate timezone
    try {
      Intl.DateTimeFormat(undefined, { timeZone: dto.timezone });
    } catch {
      throw new BadRequestException('Invalid timezone');
    }
  }

  private validateUpdateTemplateDto(dto: UpdateRecurringLinkTemplateDto): void {
    if (dto.name !== undefined && !dto.name?.trim()) {
      throw new BadRequestException('Template name cannot be empty');
    }

    if (dto.amount !== undefined && dto.amount <= 0) {
      throw new BadRequestException('Amount must be positive');
    }

    if (dto.cronExpression !== undefined && !this.isValidCronExpression(dto.cronExpression)) {
      throw new BadRequestException('Invalid cron expression');
    }

    if (dto.timezone !== undefined) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: dto.timezone });
      } catch {
        throw new BadRequestException('Invalid timezone');
      }
    }

    if (dto.variables !== undefined && dto.variables.length === 0) {
      throw new BadRequestException('At least one variable is required');
    }
  }

  private validateCreateVersionDto(dto: CreateTemplateVersionDto): void {
    if (!dto.amountTemplate?.trim()) {
      throw new BadRequestException('Amount template is required');
    }

    if (!dto.frequencyTemplate?.trim()) {
      throw new BadRequestException('Frequency template is required');
    }

    if (!dto.usernameTemplate?.trim() && !dto.destinationTemplate?.trim()) {
      throw new BadRequestException('Either username template or destination template is required');
    }
  }

  private validateUpdateVersionDto(dto: UpdateTemplateVersionDto): void {
    if (dto.amountTemplate !== undefined && !dto.amountTemplate?.trim()) {
      throw new BadRequestException('Amount template cannot be empty');
    }

    if (dto.frequencyTemplate !== undefined && !dto.frequencyTemplate?.trim()) {
      throw new BadRequestException('Frequency template cannot be empty');
    }
  }

  private validateVariableData(templateVariables: any, variableData: Record<string, any>): void {
    const requiredVariables = Array.isArray(templateVariables) ? templateVariables : JSON.parse(templateVariables || '[]');
    
    for (const variable of requiredVariables) {
      if (!(variable in variableData)) {
        throw new BadRequestException(`Missing required variable: ${variable}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Utility Methods
  // ---------------------------------------------------------------------------

  private isValidCronExpression(cron: string): boolean {
    const parts = cron.trim().split(/\s+/);
    return parts.length === 5; // Basic validation - in production use a proper cron parser
  }

  private parseFrequency(frequency: string): FrequencyType {
    const normalizedFreq = frequency.toLowerCase();
    switch (normalizedFreq) {
      case 'daily': return FrequencyType.DAILY;
      case 'weekly': return FrequencyType.WEEKLY;
      case 'monthly': return FrequencyType.MONTHLY;
      case 'yearly': return FrequencyType.YEARLY;
      default:
        throw new BadRequestException(`Invalid frequency: ${frequency}`);
    }
  }

  /**
   * Get template execution history (public method for controller)
   */
  async getTemplateExecutionHistory(templateId: string): Promise<TemplateExecutionResponseDto[]> {
    const template = await this.repository.findTemplateById(templateId);
    if (!template) {
      throw new NotFoundException(`Template not found: ${templateId}`);
    }

    const executions = await this.repository.findExecutionsByTemplateId(templateId);
    return executions.map(e => this.mapExecutionToResponseDto(e));
  }

  // ---------------------------------------------------------------------------
  // Mapping Methods
  // ---------------------------------------------------------------------------

  private mapTemplateToResponseDto(template: DbRecurringLinkTemplate): RecurringLinkTemplateResponseDto {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      asset: template.asset,
      assetIssuer: template.asset_issuer,
      amount: template.amount,
      cronExpression: template.cron_expression,
      timezone: template.timezone,
      variables: Array.isArray(template.variables) ? template.variables : JSON.parse(template.variables || '[]'),
      status: template.status,
      createdBy: template.created_by,
      organizationId: template.organization_id,
      createdAt: new Date(template.created_at),
      updatedAt: new Date(template.updated_at),
    };
  }

  private mapVersionToResponseDto(version: DbRecurringLinkTemplateVersion): TemplateVersionResponseDto {
    return {
      id: version.id,
      templateId: version.template_id,
      versionNumber: version.version_number,
      usernameTemplate: version.username_template,
      destinationTemplate: version.destination_template,
      amountTemplate: version.amount_template,
      memoTemplate: version.memo_template,
      referenceIdTemplate: version.reference_id_template,
      frequencyTemplate: version.frequency_template,
      startDateTemplate: version.start_date_template,
      endDateTemplate: version.end_date_template,
      totalPeriodsTemplate: version.total_periods_template,
      status: version.status,
      changeNotes: version.change_notes,
      createdBy: version.created_by,
      createdAt: new Date(version.created_at),
      updatedAt: new Date(version.updated_at),
    };
  }

  private mapExecutionToResponseDto(execution: DbRecurringLinkTemplateExecution): TemplateExecutionResponseDto {
    return {
      id: execution.id,
      templateId: execution.template_id,
      templateVersionId: execution.template_version_id,
      scheduledAt: new Date(execution.scheduled_at),
      executedAt: execution.executed_at ? new Date(execution.executed_at) : undefined,
      variableData: typeof execution.variable_data === 'string' 
        ? JSON.parse(execution.variable_data) 
        : execution.variable_data,
      recurringLinkId: execution.recurring_link_id,
      status: execution.status,
      errorMessage: execution.error_message,
      retryCount: execution.retry_count,
      jobId: execution.job_id,
      createdAt: new Date(execution.created_at),
    };
  }
}