import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { RecurringPaymentsService } from './recurring-payments.service';
import { RecurringLinkTemplateService } from './recurring-link-template.service';
import {
  CreateRecurringPaymentLinkDto,
  UpdateRecurringPaymentLinkDto,
  RecurringPaymentLinkResponseDto,
  ListRecurringPaymentsResponseDto,
  QueryRecurringPaymentsDto,
  RecurringStatus,
  RecurringPaymentExecutionDto,
} from './dto/recurring-payment.dto';
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
  QueryRecurringLinkTemplatesDto,
  TemplateStatus,
} from './dto/recurring-link-template.dto';

@ApiTags('recurring-payments')
@Controller('links/recurring')
export class RecurringPaymentsController {
  constructor(
    private readonly service: RecurringPaymentsService,
    private readonly templateService: RecurringLinkTemplateService,
  ) {}

  // ---------------------------------------------------------------------------
  // CRUD Operations
  // ---------------------------------------------------------------------------

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new recurring payment link',
    description: 'Creates a subscription-style payment link with specified frequency and duration',
  })
  @ApiResponse({
    status: 201,
    description: 'Recurring payment link created successfully',
    type: RecurringPaymentLinkResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid input parameters',
  })
  async createRecurringLink(
    @Body() dto: CreateRecurringPaymentLinkDto,
  ): Promise<{ success: boolean; data: RecurringPaymentLinkResponseDto }> {
    const result = await this.service.createRecurringLink(dto);
    return {
      success: true,
      data: result,
    };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get recurring payment link by ID',
    description: 'Retrieves details of a specific recurring payment link including execution history',
  })
  @ApiParam({ name: 'id', description: 'Recurring payment link ID' })
  @ApiResponse({
    status: 200,
    description: 'Recurring payment link retrieved successfully',
    type: RecurringPaymentLinkResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Recurring payment link not found',
  })
  async getRecurringLink(
    @Param('id') id: string,
  ): Promise<{ success: boolean; data: RecurringPaymentLinkResponseDto }> {
    const result = await this.service.getRecurringLinkById(id);
    return {
      success: true,
      data: result,
    };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List recurring payment links',
    description: 'Lists all recurring payment links with optional filtering',
  })
  @ApiQuery({ name: 'status', required: false, enum: RecurringStatus })
  @ApiQuery({ name: 'username', required: false })
  @ApiQuery({ name: 'destination', required: false })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque pagination cursor' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (1-100)' })
  @ApiResponse({
    status: 200,
    description: 'Recurring payment links listed successfully',
    type: ListRecurringPaymentsResponseDto,
  })
  async listRecurringLinks(
    @Query() query: QueryRecurringPaymentsDto,
  ): Promise<{ success: boolean; data: RecurringPaymentLinkResponseDto[]; total: number; next_cursor: string | null; has_more: boolean; limit: number }> {
    const result = await this.service.listRecurringLinks(query);
    return {
      success: true,
      ...result,
    };
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update recurring payment link',
    description: 'Updates an existing recurring payment link',
  })
  @ApiParam({ name: 'id', description: 'Recurring payment link ID' })
  @ApiResponse({
    status: 200,
    description: 'Recurring payment link updated successfully',
    type: RecurringPaymentLinkResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid update parameters or link cannot be updated',
  })
  @ApiResponse({
    status: 404,
    description: 'Recurring payment link not found',
  })
  async updateRecurringLink(
    @Param('id') id: string,
    @Body() dto: UpdateRecurringPaymentLinkDto,
  ): Promise<{ success: boolean; data: RecurringPaymentLinkResponseDto }> {
    const result = await this.service.updateRecurringLink(id, dto);
    return {
      success: true,
      data: result,
    };
  }

  // ---------------------------------------------------------------------------
  // Status Management
  // ---------------------------------------------------------------------------

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel recurring payment link',
    description: 'Cancels a recurring payment link, stopping all future payments',
  })
  @ApiParam({ name: 'id', description: 'Recurring payment link ID' })
  @ApiResponse({
    status: 200,
    description: 'Recurring payment link cancelled successfully',
    type: RecurringPaymentLinkResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Link is already cancelled',
  })
  @ApiResponse({
    status: 404,
    description: 'Recurring payment link not found',
  })
  async cancelRecurringLink(
    @Param('id') id: string,
  ): Promise<{ success: boolean; data: RecurringPaymentLinkResponseDto }> {
    const result = await this.service.cancelRecurringLink(id);
    return {
      success: true,
      data: result,
    };
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pause recurring payment link',
    description: 'Temporarily suspends a recurring payment link',
  })
  @ApiParam({ name: 'id', description: 'Recurring payment link ID' })
  @ApiResponse({
    status: 200,
    description: 'Recurring payment link paused successfully',
    type: RecurringPaymentLinkResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Link is not active',
  })
  @ApiResponse({
    status: 404,
    description: 'Recurring payment link not found',
  })
  async pauseRecurringLink(
    @Param('id') id: string,
  ): Promise<{ success: boolean; data: RecurringPaymentLinkResponseDto }> {
    const result = await this.service.pauseRecurringLink(id);
    return {
      success: true,
      data: result,
    };
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resume recurring payment link',
    description: 'Resumes a previously paused recurring payment link',
  })
  @ApiParam({ name: 'id', description: 'Recurring payment link ID' })
  @ApiResponse({
    status: 200,
    description: 'Recurring payment link resumed successfully',
    type: RecurringPaymentLinkResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Link is not paused',
  })
  @ApiResponse({
    status: 404,
    description: 'Recurring payment link not found',
  })
  async resumeRecurringLink(
    @Param('id') id: string,
  ): Promise<{ success: boolean; data: RecurringPaymentLinkResponseDto }> {
    const result = await this.service.resumeRecurringLink(id);
    return {
      success: true,
      data: result,
    };
  }

  // ---------------------------------------------------------------------------
  // Execution History
  // ---------------------------------------------------------------------------

  @Get(':id/executions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get execution history',
    description: 'Retrieves the execution history for a recurring payment link',
  })
  @ApiParam({ name: 'id', description: 'Recurring payment link ID' })
  @ApiResponse({
    status: 200,
    description: 'Execution history retrieved successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Recurring payment link not found',
  })
  async getExecutionHistory(
    @Param('id') id: string,
  ): Promise<{ success: boolean; data: RecurringPaymentExecutionDto[] }> {
    const executions = await this.service.getExecutionHistory(id);
    return {
      success: true,
      data: executions,
    };
  }

  // ===========================================================================
  // TEMPLATE MANAGEMENT ENDPOINTS
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // Template CRUD Operations
  // ---------------------------------------------------------------------------

  @Post('templates')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new recurring link template',
    description: 'Creates a template for generating recurring payment links with variable substitution and cron scheduling',
  })
  @ApiResponse({
    status: 201,
    description: 'Template created successfully',
    type: RecurringLinkTemplateResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid template parameters',
  })
  async createTemplate(
    @Body() dto: CreateRecurringLinkTemplateDto,
  ): Promise<{ success: boolean; data: RecurringLinkTemplateResponseDto }> {
    // TODO: Get createdBy from authentication context
    const createdBy = 'system'; // Temporary placeholder
    const result = await this.templateService.createTemplate(dto, createdBy);
    return {
      success: true,
      data: result,
    };
  }

  @Get('templates/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get template by ID',
    description: 'Retrieves a template with its versions and recent executions',
  })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({
    status: 200,
    description: 'Template retrieved successfully',
    type: RecurringLinkTemplateResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Template not found',
  })
  async getTemplate(
    @Param('id') id: string,
  ): Promise<{ success: boolean; data: RecurringLinkTemplateResponseDto }> {
    const result = await this.templateService.getTemplateById(id);
    return {
      success: true,
      data: result,
    };
  }

  @Get('templates')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List recurring link templates',
    description: 'Lists templates with filtering and pagination support',
  })
  @ApiQuery({ name: 'status', required: false, enum: TemplateStatus })
  @ApiQuery({ name: 'createdBy', required: false })
  @ApiQuery({ name: 'organizationId', required: false })
  @ApiQuery({ name: 'asset', required: false })
  @ApiQuery({ name: 'nameSearch', required: false })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque pagination cursor' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (1-100)' })
  @ApiResponse({
    status: 200,
    description: 'Templates listed successfully',
  })
  async listTemplates(
    @Query() query: QueryRecurringLinkTemplatesDto,
  ): Promise<{
    success: boolean;
    data: RecurringLinkTemplateResponseDto[];
    total: number;
    next_cursor: string | null;
    has_more: boolean;
    limit: number;
  }> {
    const result = await this.templateService.listTemplates(query);
    return {
      success: true,
      ...result,
    };
  }

  @Patch('templates/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update template',
    description: 'Updates an existing template configuration',
  })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({
    status: 200,
    description: 'Template updated successfully',
    type: RecurringLinkTemplateResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid update parameters',
  })
  @ApiResponse({
    status: 404,
    description: 'Template not found',
  })
  async updateTemplate(
    @Param('id') id: string,
    @Body() dto: UpdateRecurringLinkTemplateDto,
  ): Promise<{ success: boolean; data: RecurringLinkTemplateResponseDto }> {
    const result = await this.templateService.updateTemplate(id, dto);
    return {
      success: true,
      data: result,
    };
  }

  @Delete('templates/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete template',
    description: 'Deletes a template and all its versions',
  })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({
    status: 204,
    description: 'Template deleted successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Template not found',
  })
  @ApiResponse({
    status: 409,
    description: 'Template has pending executions',
  })
  async deleteTemplate(@Param('id') id: string): Promise<void> {
    await this.templateService.deleteTemplate(id);
  }

  // ---------------------------------------------------------------------------
  // Template Version Management
  // ---------------------------------------------------------------------------

  @Post('templates/:id/versions')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create template version',
    description: 'Creates a new version for an existing template',
  })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({
    status: 201,
    description: 'Template version created successfully',
    type: TemplateVersionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid version parameters',
  })
  @ApiResponse({
    status: 404,
    description: 'Template not found',
  })
  async createTemplateVersion(
    @Param('id') templateId: string,
    @Body() dto: CreateTemplateVersionDto,
  ): Promise<{ success: boolean; data: TemplateVersionResponseDto }> {
    // TODO: Get createdBy from authentication context
    const createdBy = 'system'; // Temporary placeholder
    const result = await this.templateService.createTemplateVersion(templateId, dto, createdBy);
    return {
      success: true,
      data: result,
    };
  }

  @Patch('templates/:templateId/versions/:versionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update template version',
    description: 'Updates an existing template version (only draft versions can be modified)',
  })
  @ApiParam({ name: 'templateId', description: 'Template ID' })
  @ApiParam({ name: 'versionId', description: 'Version ID' })
  @ApiResponse({
    status: 200,
    description: 'Template version updated successfully',
    type: TemplateVersionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid update parameters or version is not in draft state',
  })
  @ApiResponse({
    status: 404,
    description: 'Template version not found',
  })
  async updateTemplateVersion(
    @Param('templateId') templateId: string,
    @Param('versionId') versionId: string,
    @Body() dto: UpdateTemplateVersionDto,
  ): Promise<{ success: boolean; data: TemplateVersionResponseDto }> {
    const result = await this.templateService.updateTemplateVersion(versionId, dto);
    return {
      success: true,
      data: result,
    };
  }

  @Post('templates/:templateId/versions/:versionId/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Activate template version',
    description: 'Sets a template version as active (deactivates current active version)',
  })
  @ApiParam({ name: 'templateId', description: 'Template ID' })
  @ApiParam({ name: 'versionId', description: 'Version ID to activate' })
  @ApiResponse({
    status: 200,
    description: 'Template version activated successfully',
    type: TemplateVersionResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Template or version not found',
  })
  async activateTemplateVersion(
    @Param('templateId') templateId: string,
    @Param('versionId') versionId: string,
  ): Promise<{ success: boolean; data: TemplateVersionResponseDto }> {
    const result = await this.templateService.activateTemplateVersion(templateId, versionId);
    return {
      success: true,
      data: result,
    };
  }

  // ---------------------------------------------------------------------------
  // Template Execution and Preview
  // ---------------------------------------------------------------------------

  @Post('templates/:id/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview template rendering',
    description: 'Renders template with provided variable data to preview the output',
  })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiQuery({ name: 'versionId', required: false, description: 'Specific version to preview (uses active if not provided)' })
  @ApiResponse({
    status: 200,
    description: 'Template preview generated successfully',
    type: TemplatePreviewResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid variable data',
  })
  @ApiResponse({
    status: 404,
    description: 'Template not found',
  })
  async previewTemplate(
    @Param('id') templateId: string,
    @Query('versionId') versionId: string | undefined,
    @Body() dto: PreviewTemplateDto,
  ): Promise<{ success: boolean; data: TemplatePreviewResponseDto }> {
    const result = await this.templateService.previewTemplate(templateId, dto, versionId);
    return {
      success: true,
      data: result,
    };
  }

  @Post('templates/:id/execute')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Execute template',
    description: 'Executes a template to generate a recurring payment link with provided variable data',
  })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({
    status: 202,
    description: 'Template execution queued successfully',
    type: TemplateExecutionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid variable data or template not active',
  })
  @ApiResponse({
    status: 404,
    description: 'Template not found',
  })
  async executeTemplate(
    @Param('id') templateId: string,
    @Body() dto: ExecuteTemplateDto,
  ): Promise<{ success: boolean; data: TemplateExecutionResponseDto }> {
    const result = await this.templateService.executeTemplate(templateId, dto);
    return {
      success: true,
      data: result,
    };
  }

  // ---------------------------------------------------------------------------
  // Template Execution History
  // ---------------------------------------------------------------------------

  @Get('templates/:id/executions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get template execution history',
    description: 'Retrieves the execution history for a template',
  })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({
    status: 200,
    description: 'Execution history retrieved successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Template not found',
  })
  async getTemplateExecutionHistory(
    @Param('id') templateId: string,
  ): Promise<{ success: boolean; data: TemplateExecutionResponseDto[] }> {
    const executions = await this.templateService.getTemplateExecutionHistory(templateId);
    return {
      success: true,
      data: executions,
    };
  }
}
