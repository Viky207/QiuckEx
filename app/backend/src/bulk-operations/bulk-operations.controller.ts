import { Body, Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { RequireScopes } from '../auth/decorators/require-scopes.decorator';
import { BulkOperationsService } from './bulk-operations.service';
import { CreateBulkOperationDto } from './dto/bulk-operation.dto';

@ApiTags('Admin - Bulk Operations')
@ApiBearerAuth()
@UseGuards(ApiKeyGuard)
@Controller('admin/bulk/operations')
export class BulkOperationsController {
  constructor(private readonly service: BulkOperationsService) {}

  @Post()
  @RequireScopes('admin')
  @ApiOperation({ summary: 'Queue an asynchronous bulk operation' })
  create(@Body() request: CreateBulkOperationDto) {
    return this.service.enqueue(request);
  }

  @Get(':jobId')
  @RequireScopes('admin')
  @ApiOperation({ summary: 'Get bulk operation progress' })
  async status(@Param('jobId') jobId: string) {
    const status = await this.service.getStatus(jobId);
    if (!status) throw new NotFoundException(`Bulk operation not found: ${jobId}`);
    return status;
  }
}