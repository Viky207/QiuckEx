import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { 
  IsEnum, 
  IsNumber, 
  IsOptional, 
  IsString, 
  Min, 
  IsBoolean, 
  IsArray, 
  IsObject, 
  ValidateNested,
  ArrayNotEmpty,
  Matches
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum TemplateStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ARCHIVED = 'archived',
}

export enum TemplateVersionStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

export enum TemplateExecutionStatus {
  PENDING = 'pending',
  SUCCESS = 'success',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

// ---------------------------------------------------------------------------
// Variable Data DTOs
// ---------------------------------------------------------------------------

/**
 * DTO for template variable data
 */
export class TemplateVariableDataDto {
  @ApiPropertyOptional({
    description: 'Amount value for {{amount}} variable',
    example: '100.50',
  })
  @IsString()
  @IsOptional()
  amount?: string;

  @ApiPropertyOptional({
    description: 'Memo value for {{memo}} variable',
    example: 'Invoice payment for services',
  })
  @IsString()
  @IsOptional()
  memo?: string;

  @ApiPropertyOptional({
    description: 'Invoice ID value for {{invoice_id}} variable',
    example: 'INV-2024-001',
  })
  @IsString()
  @IsOptional()
  invoice_id?: string;

  // Allow additional properties for custom variables
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

/**
 * DTO for creating a new recurring link template
 */
export class CreateRecurringLinkTemplateDto {
  @ApiProperty({
    description: 'Template name',
    example: 'Monthly Invoice Template',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @Transform(({ value }) => value?.trim())
  name!: string;

  @ApiPropertyOptional({
    description: 'Template description',
    example: 'Generates monthly recurring payment links for client invoices',
    maxLength: 1000,
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  description?: string;

  @ApiProperty({
    description: 'Asset code (XLM, USDC, etc.)',
    example: 'XLM',
  })
  @IsString()
  asset!: string;

  @ApiPropertyOptional({
    description: 'Asset issuer address (for non-native assets)',
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2K34P4D5NXJ6Z4GJ5B7G',
  })
  @IsString()
  @IsOptional()
  assetIssuer?: string;

  @ApiProperty({
    description: 'Default amount (can be overridden by {{amount}} variable)',
    example: 100,
    minimum: 0.0000001,
  })
  @IsNumber()
  @Min(0.0000001)
  amount!: number;

  @ApiProperty({
    description: 'Cron expression for scheduling (5-field format: minute hour day month weekday)',
    example: '0 9 1 * *', // First day of every month at 9 AM
  })
  @IsString()
  @Matches(/^[0-9*/,-]+\s+[0-9*/,-]+\s+[0-9*/,-]+\s+[0-9*/,-]+\s+[0-9*/,-]+$/, {
    message: 'Invalid cron expression format. Expected: minute hour day month weekday',
  })
  cronExpression!: string;

  @ApiProperty({
    description: 'IANA timezone identifier',
    example: 'America/New_York',
    default: 'UTC',
  })
  @IsString()
  timezone!: string;

  @ApiProperty({
    description: 'Array of variable names used in templates',
    example: ['amount', 'memo', 'invoice_id'],
    isArray: true,
    type: String,
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  variables!: string[];

  @ApiPropertyOptional({
    description: 'Organization ID for multi-tenant support',
    example: 'org_123456',
  })
  @IsString()
  @IsOptional()
  organizationId?: string;
}

/**
 * DTO for updating an existing recurring link template
 */
export class UpdateRecurringLinkTemplateDto {
  @ApiPropertyOptional({
    description: 'Template name',
    example: 'Updated Monthly Invoice Template',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  name?: string;

  @ApiPropertyOptional({
    description: 'Template description',
    maxLength: 1000,
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  description?: string;

  @ApiPropertyOptional({
    description: 'Default amount',
    minimum: 0.0000001,
  })
  @IsNumber()
  @Min(0.0000001)
  @IsOptional()
  amount?: number;

  @ApiPropertyOptional({
    description: 'Cron expression for scheduling',
    example: '0 10 15 * *', // 15th of every month at 10 AM
  })
  @IsString()
  @IsOptional()
  @Matches(/^[0-9*/,-]+\s+[0-9*/,-]+\s+[0-9*/,-]+\s+[0-9*/,-]+\s+[0-9*/,-]+$/, {
    message: 'Invalid cron expression format. Expected: minute hour day month weekday',
  })
  cronExpression?: string;

  @ApiPropertyOptional({
    description: 'IANA timezone identifier',
    example: 'Europe/London',
  })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({
    description: 'Array of variable names used in templates',
    example: ['amount', 'memo', 'invoice_id', 'customer_name'],
    isArray: true,
    type: String,
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  variables?: string[];

  @ApiPropertyOptional({
    description: 'Template status',
    enum: TemplateStatus,
  })
  @IsEnum(TemplateStatus)
  @IsOptional()
  status?: TemplateStatus;
}

/**
 * DTO for creating a new template version
 */
export class CreateTemplateVersionDto {
  @ApiPropertyOptional({
    description: 'Username template with {{variables}} (e.g., "user-{{invoice_id}}")',
    example: 'client-{{invoice_id}}',
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  usernameTemplate?: string;

  @ApiPropertyOptional({
    description: 'Destination template with {{variables}}',
    example: 'GDEST...{{customer_id}}...XAMPLE',
    maxLength: 56,
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  destinationTemplate?: string;

  @ApiProperty({
    description: 'Amount template (can use {{amount}} variable or static value)',
    example: '{{amount}}',
  })
  @IsString()
  amountTemplate!: string;

  @ApiPropertyOptional({
    description: 'Memo template with {{variables}}',
    example: 'Invoice {{invoice_id}} - {{memo}}',
    maxLength: 28,
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  memoTemplate?: string;

  @ApiPropertyOptional({
    description: 'Reference ID template with {{variables}}',
    example: 'REF-{{invoice_id}}',
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  referenceIdTemplate?: string;

  @ApiProperty({
    description: 'Frequency template (can use variables or static value)',
    example: 'monthly',
    default: 'monthly',
  })
  @IsString()
  frequencyTemplate!: string;

  @ApiPropertyOptional({
    description: 'Start date template (can use variables for dynamic dates)',
    example: '{{start_date}}',
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  startDateTemplate?: string;

  @ApiPropertyOptional({
    description: 'End date template (can use variables for dynamic dates)',
    example: '{{end_date}}',
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  endDateTemplate?: string;

  @ApiPropertyOptional({
    description: 'Total periods template (can use variables)',
    example: '{{total_periods}}',
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  totalPeriodsTemplate?: string;

  @ApiPropertyOptional({
    description: 'Change notes for this version',
    example: 'Updated memo template to include customer name',
    maxLength: 1000,
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  changeNotes?: string;
}

/**
 * DTO for updating a template version
 */
export class UpdateTemplateVersionDto {
  @ApiPropertyOptional({
    description: 'Username template with {{variables}}',
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  usernameTemplate?: string;

  @ApiPropertyOptional({
    description: 'Destination template with {{variables}}',
    maxLength: 56,
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  destinationTemplate?: string;

  @ApiPropertyOptional({
    description: 'Amount template',
  })
  @IsString()
  @IsOptional()
  amountTemplate?: string;

  @ApiPropertyOptional({
    description: 'Memo template with {{variables}}',
    maxLength: 28,
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  memoTemplate?: string;

  @ApiPropertyOptional({
    description: 'Reference ID template with {{variables}}',
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  referenceIdTemplate?: string;

  @ApiPropertyOptional({
    description: 'Frequency template',
  })
  @IsString()
  @IsOptional()
  frequencyTemplate?: string;

  @ApiPropertyOptional({
    description: 'Start date template',
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  startDateTemplate?: string;

  @ApiPropertyOptional({
    description: 'End date template',
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  endDateTemplate?: string;

  @ApiPropertyOptional({
    description: 'Total periods template',
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  totalPeriodsTemplate?: string;

  @ApiPropertyOptional({
    description: 'Version status',
    enum: TemplateVersionStatus,
  })
  @IsEnum(TemplateVersionStatus)
  @IsOptional()
  status?: TemplateVersionStatus;

  @ApiPropertyOptional({
    description: 'Change notes for this version',
    maxLength: 1000,
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.trim())
  changeNotes?: string;
}

/**
 * DTO for executing a template with variable data
 */
export class ExecuteTemplateDto {
  @ApiProperty({
    description: 'Variable data for template substitution',
    example: {
      amount: '150.00',
      memo: 'Q1 2024 Services',
      invoice_id: 'INV-2024-Q1-001',
    },
  })
  @IsObject()
  @ValidateNested()
  @Type(() => TemplateVariableDataDto)
  variableData!: TemplateVariableDataDto;

  @ApiPropertyOptional({
    description: 'Template version ID to execute (uses active version if not provided)',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString()
  @IsOptional()
  templateVersionId?: string;
}

/**
 * DTO for previewing template rendering
 */
export class PreviewTemplateDto {
  @ApiProperty({
    description: 'Variable data for template preview',
    example: {
      amount: '99.99',
      memo: 'Test Invoice',
      invoice_id: 'TEST-001',
    },
  })
  @IsObject()
  @ValidateNested()
  @Type(() => TemplateVariableDataDto)
  variableData!: TemplateVariableDataDto;
}

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

/**
 * DTO for template version response
 */
export class TemplateVersionResponseDto {
  @ApiProperty({ description: 'Template version ID' })
  id!: string;

  @ApiProperty({ description: 'Template ID' })
  templateId!: string;

  @ApiProperty({ description: 'Version number' })
  versionNumber!: number;

  @ApiPropertyOptional({ description: 'Username template' })
  usernameTemplate?: string;

  @ApiPropertyOptional({ description: 'Destination template' })
  destinationTemplate?: string;

  @ApiProperty({ description: 'Amount template' })
  amountTemplate!: string;

  @ApiPropertyOptional({ description: 'Memo template' })
  memoTemplate?: string;

  @ApiPropertyOptional({ description: 'Reference ID template' })
  referenceIdTemplate?: string;

  @ApiProperty({ description: 'Frequency template' })
  frequencyTemplate!: string;

  @ApiPropertyOptional({ description: 'Start date template' })
  startDateTemplate?: string;

  @ApiPropertyOptional({ description: 'End date template' })
  endDateTemplate?: string;

  @ApiPropertyOptional({ description: 'Total periods template' })
  totalPeriodsTemplate?: string;

  @ApiProperty({ description: 'Version status', enum: TemplateVersionStatus })
  status!: TemplateVersionStatus;

  @ApiPropertyOptional({ description: 'Change notes' })
  changeNotes?: string;

  @ApiProperty({ description: 'Created by user/API' })
  createdBy!: string;

  @ApiProperty({ description: 'Created timestamp' })
  createdAt!: Date;

  @ApiProperty({ description: 'Updated timestamp' })
  updatedAt!: Date;
}

/**
 * DTO for template execution response
 */
export class TemplateExecutionResponseDto {
  @ApiProperty({ description: 'Execution ID' })
  id!: string;

  @ApiProperty({ description: 'Template ID' })
  templateId!: string;

  @ApiProperty({ description: 'Template version ID' })
  templateVersionId!: string;

  @ApiProperty({ description: 'Scheduled execution time' })
  scheduledAt!: Date;

  @ApiPropertyOptional({ description: 'Actual execution time' })
  executedAt?: Date;

  @ApiProperty({ description: 'Variable data used for execution' })
  variableData!: Record<string, any>;

  @ApiPropertyOptional({ description: 'Generated recurring link ID' })
  recurringLinkId?: string;

  @ApiProperty({ description: 'Execution status', enum: TemplateExecutionStatus })
  status!: TemplateExecutionStatus;

  @ApiPropertyOptional({ description: 'Error message if execution failed' })
  errorMessage?: string;

  @ApiProperty({ description: 'Retry count' })
  retryCount!: number;

  @ApiPropertyOptional({ description: 'Job ID for background processing' })
  jobId?: string;

  @ApiProperty({ description: 'Created timestamp' })
  createdAt!: Date;
}

/**
 * DTO for recurring link template response
 */
export class RecurringLinkTemplateResponseDto {
  @ApiProperty({ description: 'Template ID' })
  id!: string;

  @ApiProperty({ description: 'Template name' })
  name!: string;

  @ApiPropertyOptional({ description: 'Template description' })
  description?: string;

  @ApiProperty({ description: 'Asset code' })
  asset!: string;

  @ApiPropertyOptional({ description: 'Asset issuer' })
  assetIssuer?: string;

  @ApiProperty({ description: 'Default amount' })
  amount!: number;

  @ApiProperty({ description: 'Cron expression' })
  cronExpression!: string;

  @ApiProperty({ description: 'Timezone' })
  timezone!: string;

  @ApiProperty({ description: 'Variable names', isArray: true, type: String })
  variables!: string[];

  @ApiProperty({ description: 'Template status', enum: TemplateStatus })
  status!: TemplateStatus;

  @ApiProperty({ description: 'Created by user/API' })
  createdBy!: string;

  @ApiPropertyOptional({ description: 'Organization ID' })
  organizationId?: string;

  @ApiProperty({ description: 'Created timestamp' })
  createdAt!: Date;

  @ApiProperty({ description: 'Updated timestamp' })
  updatedAt!: Date;

  @ApiPropertyOptional({ 
    description: 'Template versions',
    type: [TemplateVersionResponseDto],
  })
  versions?: TemplateVersionResponseDto[];

  @ApiPropertyOptional({ 
    description: 'Recent executions',
    type: [TemplateExecutionResponseDto],
  })
  executions?: TemplateExecutionResponseDto[];
}

/**
 * DTO for template preview result
 */
export class TemplatePreviewResponseDto {
  @ApiPropertyOptional({ description: 'Rendered username' })
  username?: string;

  @ApiPropertyOptional({ description: 'Rendered destination' })
  destination?: string;

  @ApiProperty({ description: 'Rendered amount' })
  amount!: string;

  @ApiPropertyOptional({ description: 'Rendered memo' })
  memo?: string;

  @ApiPropertyOptional({ description: 'Rendered reference ID' })
  referenceId?: string;

  @ApiProperty({ description: 'Rendered frequency' })
  frequency!: string;

  @ApiPropertyOptional({ description: 'Rendered start date' })
  startDate?: string;

  @ApiPropertyOptional({ description: 'Rendered end date' })
  endDate?: string;

  @ApiPropertyOptional({ description: 'Rendered total periods' })
  totalPeriods?: string;

  @ApiProperty({ description: 'Template version ID used for rendering' })
  templateVersionId!: string;
}

// ---------------------------------------------------------------------------
// Query Parameter DTOs
// ---------------------------------------------------------------------------

/**
 * DTO for querying recurring link templates
 */
export class QueryRecurringLinkTemplatesDto {
  @ApiPropertyOptional({
    description: 'Filter by template status',
    enum: TemplateStatus,
  })
  @IsEnum(TemplateStatus)
  @IsOptional()
  status?: TemplateStatus;

  @ApiPropertyOptional({
    description: 'Filter by created by user/API',
  })
  @IsString()
  @IsOptional()
  createdBy?: string;

  @ApiPropertyOptional({
    description: 'Filter by organization ID',
  })
  @IsString()
  @IsOptional()
  organizationId?: string;

  @ApiPropertyOptional({
    description: 'Filter by asset code',
  })
  @IsString()
  @IsOptional()
  asset?: string;

  @ApiPropertyOptional({
    description: 'Search template names (case-insensitive)',
  })
  @IsString()
  @IsOptional()
  nameSearch?: string;

  @ApiPropertyOptional({
    description: 'Opaque cursor for pagination',
  })
  @IsString()
  @IsOptional()
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Items per page (1-100)',
    example: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  @IsOptional()
  limit?: number;
}