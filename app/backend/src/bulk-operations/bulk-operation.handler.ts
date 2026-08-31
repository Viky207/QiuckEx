import { Injectable } from '@nestjs/common';
import { CancellationToken, Job, JobHandler } from '../job-queue/types';
import { BulkOperationPayload } from '../job-queue/types';
import { BulkOperationRepository } from './bulk-operation.repository';

export const BULK_OPERATION_EXECUTORS = Symbol('BULK_OPERATION_EXECUTORS');
export type BulkOperationExecutor = (
  item: unknown,
  payload: Record<string, unknown>,
) => Promise<void>;

@Injectable()
export class BulkOperationHandler implements JobHandler<BulkOperationPayload> {
  private readonly executors = new Map<string, BulkOperationExecutor>();

  constructor(private readonly repository: BulkOperationRepository) {}

  registerExecutor(operation: string, executor: BulkOperationExecutor): void {
    this.executors.set(operation, executor);
  }

  async validate(payload: BulkOperationPayload): Promise<void> {
    if (!payload?.operationId) throw new Error('operationId is required');
  }

  async execute(job: Job<BulkOperationPayload>, cancellationToken: CancellationToken): Promise<void> {
    const operation = await this.repository.getOperation(job.payload.operationId);
    if (!operation) throw new Error(`Bulk operation not found: ${job.payload.operationId}`);
    const failedItems: Array<{ item: unknown; error: string }> = [];
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    await this.repository.updateProgress(job.payload.operationId,
      { total: operation.total, processed, succeeded, failed, currentItem: null }, failedItems, 'running');

    while (true) {
      cancellationToken.throwIfCancelled();
      const next = await this.repository.claimNextItem(job.payload.operationId);
      if (!next) break;
      try {
        await this.executeItem(operation.operation, next.item, operation.payload);
        await this.repository.completeItem(next.id, true);
        succeeded++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.repository.completeItem(next.id, false, message);
        failedItems.push({ item: next.item, error: message });
        failed++;
      }
      processed++;
      await this.repository.updateProgress(job.payload.operationId,
        { total: operation.total, processed, succeeded, failed, currentItem: next.item }, failedItems, 'running');
    }
    await this.repository.updateProgress(job.payload.operationId,
      { total: operation.total, processed, succeeded, failed, currentItem: null }, failedItems,
      failed > 0 ? 'completed_with_errors' : 'completed');
  }

  async onFailure(job: Job<BulkOperationPayload>, error: Error): Promise<void> {
    await this.repository.updateProgress(job.payload.operationId,
      { total: 0, processed: 0, succeeded: 0, failed: 0, currentItem: null },
      [{ item: null, error: error.message }], 'failed');
  }

  private async executeItem(operation: string, item: unknown, payload: Record<string, unknown>): Promise<void> {
    const executor = this.executors.get(operation);
    if (!executor) throw new Error(`Unsupported bulk operation: ${operation}`);
    await executor(item, payload);
  }
}