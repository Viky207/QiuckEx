import { Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.service';
import {
  TemplateStatus,
  TemplateVersionStatus,
  TemplateExecutionStatus,
} from './dto/recurring-link-template.dto';
import { CursorPayload, clampLimit, paginateResult, decodeCursor } from '../common/pagination/cursor.util';

// ---------------------------------------------------------------------------
// Database type mappings
// ---------------------------------------------------------------------------

export type DbRecurringLinkTemplate = {
  id: string;
  name: string;
  description: string | null;
  asset: string;
  asset_issuer: string | null;
  amount: number;
  cron_expression: string;
  timezone: string;
  variables: any; // JSONB array
  created_by: string;
  organization_id: string | null;
  status: TemplateStatus;
  preview_scope: string | null;
  created_at: string;
  updated_at: string;
};

export type DbRecurringLinkTemplateVersion = {
  id: string;
  template_id: string;
  version_number: number;
  username_template: string | null;
  destination_template: string | null;
  amount_template: string;
  memo_template: string | null;
  reference_id_template: string | null;
  frequency_template: string;
  start_date_template: string | null;
  end_date_template: string | null;
  total_periods_template: string | null;
  status: TemplateVersionStatus;
  change_notes: string | null;
  created_by: string;
  preview_scope: string | null;
  created_at: string;
  updated_at: string;
};

export type DbRecurringLinkTemplateExecution = {
  id: string;
  template_id: string;
  template_version_id: string;
  scheduled_at: string;
  executed_at: string | null;
  variable_data: any; // JSONB object
  recurring_link_id: string | null;
  status: TemplateExecutionStatus;
  error_message: string | null;
  retry_count: number;
  last_retry_at: string | null;
  job_id: string | null;
  preview_scope: string | null;
  created_at: string;
};

@Injectable()
export class RecurringLinkTemplateRepository {
  private readonly logger = new Logger(RecurringLinkTemplateRepository.name);
  private readonly supabase: SupabaseClient;

  constructor(private readonly supabaseService: SupabaseService) {
    this.supabase = this.supabaseService.getClient();
  }

  // ---------------------------------------------------------------------------
  // Template CRUD Operations
  // ---------------------------------------------------------------------------

  async createTemplate(template: {
    name: string;
    description?: string;
    asset: string;
    assetIssuer?: string;
    amount: number;
    cronExpression: string;
    timezone: string;
    variables: string[];
    createdBy: string;
    organizationId?: string;
    previewScope?: string;
  }): Promise<DbRecurringLinkTemplate> {
    const insertData: Record<string, unknown> = {
      name: template.name,
      description: template.description || null,
      asset: template.asset,
      asset_issuer: template.assetIssuer || null,
      amount: template.amount,
      cron_expression: template.cronExpression,
      timezone: template.timezone,
      variables: JSON.stringify(template.variables),
      created_by: template.createdBy,
      organization_id: template.organizationId || null,
      status: TemplateStatus.ACTIVE,
    };

    if (template.previewScope) {
      insertData.preview_scope = template.previewScope;
    }

    const { data, error } = await this.supabase
      .from('recurring_link_templates')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      this.logger.error(`Error creating recurring link template: ${error.message}`, error.stack);
      throw error;
    }

    return data as DbRecurringLinkTemplate;
  }

  async findTemplateById(id: string): Promise<DbRecurringLinkTemplate | null> {
    const { data, error } = await this.supabase
      .from('recurring_link_templates')
      .select('*')
      .eq('id', id)
      .single();

    if (error && error.code !== 'PGRST116') {
      this.logger.error(`Error finding template: ${error.message}`, error.stack);
      throw error;
    }

    return data as DbRecurringLinkTemplate | null;
  }

  async updateTemplate(
    id: string,
    updates: {
      name?: string;
      description?: string;
      amount?: number;
      cronExpression?: string;
      timezone?: string;
      variables?: string[];
      status?: TemplateStatus;
    },
  ): Promise<DbRecurringLinkTemplate> {
    const updateData: Record<string, unknown> = {};

    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.description !== undefined) updateData.description = updates.description;
    if (updates.amount !== undefined) updateData.amount = updates.amount;
    if (updates.cronExpression !== undefined) updateData.cron_expression = updates.cronExpression;
    if (updates.timezone !== undefined) updateData.timezone = updates.timezone;
    if (updates.variables !== undefined) updateData.variables = JSON.stringify(updates.variables);
    if (updates.status !== undefined) updateData.status = updates.status;

    const { data, error } = await this.supabase
      .from('recurring_link_templates')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      this.logger.error(`Error updating template: ${error.message}`, error.stack);
      throw error;
    }

    return data as DbRecurringLinkTemplate;
  }

  async deleteTemplate(id: string): Promise<void> {
    const { error } = await this.supabase
      .from('recurring_link_templates')
      .delete()
      .eq('id', id);

    if (error) {
      this.logger.error(`Error deleting template: ${error.message}`, error.stack);
      throw error;
    }
  }

  async listTemplates(params: {
    status?: TemplateStatus;
    createdBy?: string;
    organizationId?: string;
    asset?: string;
    nameSearch?: string;
    cursor?: string;
    limit?: number;
    previewScope?: string;
  }): Promise<{
    data: DbRecurringLinkTemplate[];
    next_cursor: string | null;
    has_more: boolean;
    total: number;
  }> {
    const { status, createdBy, organizationId, asset, nameSearch, cursor: cursorStr, limit, previewScope } = params;
    const effectiveLimit = clampLimit(limit);

    // Decode cursor
    const decodedCursor: CursorPayload | null = cursorStr ? decodeCursor(cursorStr) : null;

    let query = this.supabase
      .from('recurring_link_templates')
      .select('*', { count: 'exact' });

    if (previewScope) {
      query = query.eq('preview_scope', previewScope);
    } else {
      query = query.is('preview_scope', null);
    }

    if (status) {
      query = query.eq('status', status);
    }

    if (createdBy) {
      query = query.eq('created_by', createdBy);
    }

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    if (asset) {
      query = query.eq('asset', asset);
    }

    if (nameSearch) {
      query = query.ilike('name', `%${nameSearch}%`);
    }

    // Apply cursor filter for deterministic ordering
    if (decodedCursor) {
      query = query
        .or(`created_at.lt.${decodedCursor.pk},and(created_at.eq.${decodedCursor.pk},id.gt.${decodedCursor.id})`)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true });
    } else {
      query = query
        .order('created_at', { ascending: false })
        .order('id', { ascending: true });
    }

    // Fetch one extra row to determine if there's a next page
    query = query.limit(effectiveLimit + 1);

    const { data, error, count } = await query;

    if (error) {
      this.logger.error(`Error listing templates: ${error.message}`, error.stack);
      throw error;
    }

    return paginateResult({
      data: data as DbRecurringLinkTemplate[],
      count: count || 0,
      limit: effectiveLimit,
      getPrimarySortValue: (row) => row.created_at,
      getId: (row) => row.id,
    });
  }

  // ---------------------------------------------------------------------------
  // Template Version CRUD Operations
  // ---------------------------------------------------------------------------

  async createTemplateVersion(version: {
    templateId: string;
    usernameTemplate?: string;
    destinationTemplate?: string;
    amountTemplate: string;
    memoTemplate?: string;
    referenceIdTemplate?: string;
    frequencyTemplate: string;
    startDateTemplate?: string;
    endDateTemplate?: string;
    totalPeriodsTemplate?: string;
    changeNotes?: string;
    createdBy: string;
    previewScope?: string;
  }): Promise<DbRecurringLinkTemplateVersion> {
    // Get the next version number
    const { data: existingVersions, error: versionError } = await this.supabase
      .from('recurring_link_template_versions')
      .select('version_number')
      .eq('template_id', version.templateId)
      .order('version_number', { ascending: false })
      .limit(1);

    if (versionError) {
      this.logger.error(`Error getting version number: ${versionError.message}`, versionError.stack);
      throw versionError;
    }

    const nextVersionNumber = existingVersions.length > 0 ? existingVersions[0].version_number + 1 : 1;

    const insertData: Record<string, unknown> = {
      template_id: version.templateId,
      version_number: nextVersionNumber,
      username_template: version.usernameTemplate || null,
      destination_template: version.destinationTemplate || null,
      amount_template: version.amountTemplate,
      memo_template: version.memoTemplate || null,
      reference_id_template: version.referenceIdTemplate || null,
      frequency_template: version.frequencyTemplate,
      start_date_template: version.startDateTemplate || null,
      end_date_template: version.endDateTemplate || null,
      total_periods_template: version.totalPeriodsTemplate || null,
      status: TemplateVersionStatus.DRAFT,
      change_notes: version.changeNotes || null,
      created_by: version.createdBy,
    };

    if (version.previewScope) {
      insertData.preview_scope = version.previewScope;
    }

    const { data, error } = await this.supabase
      .from('recurring_link_template_versions')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      this.logger.error(`Error creating template version: ${error.message}`, error.stack);
      throw error;
    }

    return data as DbRecurringLinkTemplateVersion;
  }

  async findTemplateVersionById(id: string): Promise<DbRecurringLinkTemplateVersion | null> {
    const { data, error } = await this.supabase
      .from('recurring_link_template_versions')
      .select('*')
      .eq('id', id)
      .single();

    if (error && error.code !== 'PGRST116') {
      this.logger.error(`Error finding template version: ${error.message}`, error.stack);
      throw error;
    }

    return data as DbRecurringLinkTemplateVersion | null;
  }

  async findActiveVersionForTemplate(templateId: string): Promise<DbRecurringLinkTemplateVersion | null> {
    const { data, error } = await this.supabase
      .from('recurring_link_template_versions')
      .select('*')
      .eq('template_id', templateId)
      .eq('status', TemplateVersionStatus.ACTIVE)
      .single();

    if (error && error.code !== 'PGRST116') {
      this.logger.error(`Error finding active template version: ${error.message}`, error.stack);
      throw error;
    }

    return data as DbRecurringLinkTemplateVersion | null;
  }

  async findVersionsByTemplateId(templateId: string): Promise<DbRecurringLinkTemplateVersion[]> {
    const { data, error } = await this.supabase
      .from('recurring_link_template_versions')
      .select('*')
      .eq('template_id', templateId)
      .order('version_number', { ascending: false });

    if (error) {
      this.logger.error(`Error finding template versions: ${error.message}`, error.stack);
      throw error;
    }

    return data as DbRecurringLinkTemplateVersion[];
  }

  async updateTemplateVersion(
    id: string,
    updates: {
      usernameTemplate?: string;
      destinationTemplate?: string;
      amountTemplate?: string;
      memoTemplate?: string;
      referenceIdTemplate?: string;
      frequencyTemplate?: string;
      startDateTemplate?: string;
      endDateTemplate?: string;
      totalPeriodsTemplate?: string;
      status?: TemplateVersionStatus;
      changeNotes?: string;
    },
  ): Promise<DbRecurringLinkTemplateVersion> {
    const updateData: Record<string, unknown> = {};

    if (updates.usernameTemplate !== undefined) updateData.username_template = updates.usernameTemplate;
    if (updates.destinationTemplate !== undefined) updateData.destination_template = updates.destinationTemplate;
    if (updates.amountTemplate !== undefined) updateData.amount_template = updates.amountTemplate;
    if (updates.memoTemplate !== undefined) updateData.memo_template = updates.memoTemplate;
    if (updates.referenceIdTemplate !== undefined) updateData.reference_id_template = updates.referenceIdTemplate;
    if (updates.frequencyTemplate !== undefined) updateData.frequency_template = updates.frequencyTemplate;
    if (updates.startDateTemplate !== undefined) updateData.start_date_template = updates.startDateTemplate;
    if (updates.endDateTemplate !== undefined) updateData.end_date_template = updates.endDateTemplate;
    if (updates.totalPeriodsTemplate !== undefined) updateData.total_periods_template = updates.totalPeriodsTemplate;
    if (updates.status !== undefined) updateData.status = updates.status;
    if (updates.changeNotes !== undefined) updateData.change_notes = updates.changeNotes;

    const { data, error } = await this.supabase
      .from('recurring_link_template_versions')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      this.logger.error(`Error updating template version: ${error.message}`, error.stack);
      throw error;
    }

    return data as DbRecurringLinkTemplateVersion;
  }

  async activateTemplateVersion(
    templateId: string,
    versionId: string,
  ): Promise<DbRecurringLinkTemplateVersion> {
    // Use a transaction to ensure only one active version per template
    const { data, error } = await this.supabase.rpc('activate_template_version', {
      template_id_param: templateId,
      version_id_param: versionId,
    });

    if (error) {
      this.logger.error(`Error activating template version: ${error.message}`, error.stack);
      throw error;
    }

    // Fetch and return the activated version
    return await this.findTemplateVersionById(versionId) as DbRecurringLinkTemplateVersion;
  }

  // ---------------------------------------------------------------------------
  // Template Execution Operations
  // ---------------------------------------------------------------------------

  async createExecution(execution: {
    templateId: string;
    templateVersionId: string;
    scheduledAt: Date;
    variableData: Record<string, any>;
    jobId?: string;
    previewScope?: string;
  }): Promise<DbRecurringLinkTemplateExecution> {
    const insertData: Record<string, unknown> = {
      template_id: execution.templateId,
      template_version_id: execution.templateVersionId,
      scheduled_at: execution.scheduledAt.toISOString(),
      variable_data: JSON.stringify(execution.variableData),
      status: TemplateExecutionStatus.PENDING,
      retry_count: 0,
      job_id: execution.jobId || null,
    };

    if (execution.previewScope) {
      insertData.preview_scope = execution.previewScope;
    }

    const { data, error } = await this.supabase
      .from('recurring_link_template_executions')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      this.logger.error(`Error creating template execution: ${error.message}`, error.stack);
      throw error;
    }

    return data as DbRecurringLinkTemplateExecution;
  }

  async findExecutionById(id: string): Promise<DbRecurringLinkTemplateExecution | null> {
    const { data, error } = await this.supabase
      .from('recurring_link_template_executions')
      .select('*')
      .eq('id', id)
      .single();

    if (error && error.code !== 'PGRST116') {
      this.logger.error(`Error finding template execution: ${error.message}`, error.stack);
      throw error;
    }

    return data as DbRecurringLinkTemplateExecution | null;
  }

  async findExecutionsByTemplateId(templateId: string): Promise<DbRecurringLinkTemplateExecution[]> {
    const { data, error } = await this.supabase
      .from('recurring_link_template_executions')
      .select('*')
      .eq('template_id', templateId)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`Error finding template executions: ${error.message}`, error.stack);
      throw error;
    }

    return data as DbRecurringLinkTemplateExecution[];
  }

  async updateExecutionStatus(
    id: string,
    status: TemplateExecutionStatus,
    updates?: {
      executedAt?: Date;
      recurringLinkId?: string;
      errorMessage?: string;
      retryCount?: number;
      lastRetryAt?: Date;
    },
  ): Promise<DbRecurringLinkTemplateExecution> {
    const updateData: Record<string, unknown> = {
      status,
    };

    if (updates?.executedAt) updateData.executed_at = updates.executedAt.toISOString();
    if (updates?.recurringLinkId) updateData.recurring_link_id = updates.recurringLinkId;
    if (updates?.errorMessage !== undefined) updateData.error_message = updates.errorMessage;
    if (updates?.retryCount !== undefined) updateData.retry_count = updates.retryCount;
    if (updates?.lastRetryAt) updateData.last_retry_at = updates.lastRetryAt.toISOString();

    const { data, error } = await this.supabase
      .from('recurring_link_template_executions')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      this.logger.error(`Error updating template execution: ${error.message}`, error.stack);
      throw error;
    }

    return data as DbRecurringLinkTemplateExecution;
  }

  async findPendingExecutions(previewScope?: string): Promise<DbRecurringLinkTemplateExecution[]> {
    let query = this.supabase
      .from('recurring_link_template_executions')
      .select('*')
      .eq('status', TemplateExecutionStatus.PENDING)
      .lte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true });

    if (previewScope) {
      query = query.eq('preview_scope', previewScope);
    } else {
      query = query.is('preview_scope', null);
    }

    const { data, error } = await query;

    if (error) {
      this.logger.error(`Error finding pending executions: ${error.message}`, error.stack);
      throw error;
    }

    return data as DbRecurringLinkTemplateExecution[];
  }

  // ---------------------------------------------------------------------------
  // Scheduler Operations
  // ---------------------------------------------------------------------------

  async findActiveTemplatesForScheduling(previewScope?: string): Promise<DbRecurringLinkTemplate[]> {
    let query = this.supabase
      .from('recurring_link_templates')
      .select('*')
      .eq('status', TemplateStatus.ACTIVE);

    if (previewScope) {
      query = query.eq('preview_scope', previewScope);
    } else {
      query = query.is('preview_scope', null);
    }

    const { data, error } = await query;

    if (error) {
      this.logger.error(`Error finding active templates: ${error.message}`, error.stack);
      throw error;
    }

    return data as DbRecurringLinkTemplate[];
  }
}