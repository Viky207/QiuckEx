import { BadRequestException, Injectable } from '@nestjs/common';
import { JobQueueService } from '../job-queue/job-queue.service';
import { BulkOperationPayload, JobType } from '../job-queue/types';
import { BulkOperationRepository } from './bulk-operation.repository';
import { CreateBulkOperationDto } from './dto/bulk-operation.dto';

@Injectable()
export class BulkOperationsService {
  constructor(private readonly repository: BulkOperationRepository, private readonly queue: JobQueueService) {}

  async enqueue(request: CreateBulkOperationDto): Promise<{ jobId: string; status: 'queued' }> {
    const rawItems = request.filters.items ?? request.filters.ids;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new BadRequestException('filters.items or filters.ids must contain at least one item');
    }
    const operationId = await this.repository.create(request.operation, request.filters, request.payload, rawItems);
    const jobId = await this.queue.enqueue<BulkOperationPayload>(JobType.BULK_OPERATION, { operationId });
    await this.repository.attachJob(operationId, jobId);
    return { jobId, status: 'queued' };
  }

  getStatus(jobId: string) {
    return this.repository.getByJobId(jobId);
  }
}