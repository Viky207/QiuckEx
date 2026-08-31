import { Module, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JobQueueModule } from '../job-queue/job-queue.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { BulkOperationHandler } from './bulk-operation.handler';
import { BulkOperationRepository } from './bulk-operation.repository';
import { BulkOperationsController } from './bulk-operations.controller';
import { BulkOperationsService } from './bulk-operations.service';
import { JobRegistry } from '../job-queue/job-registry.service';
import { JobType } from '../job-queue/types';
import { BulkOperationCleanup } from './bulk-operation.cleanup';

@Module({
  imports: [SupabaseModule, AuthModule, JobQueueModule],
  controllers: [BulkOperationsController],
  providers: [BulkOperationRepository, BulkOperationsService, BulkOperationHandler, BulkOperationCleanup],
  exports: [BulkOperationRepository, BulkOperationsService, BulkOperationHandler],
})
export class BulkOperationsModule implements OnModuleInit {
  constructor(private readonly registry: JobRegistry, private readonly handler: BulkOperationHandler) {}

  onModuleInit(): void {
    this.registry.registerHandler(JobType.BULK_OPERATION, this.handler, {
      maxAttempts: 3,
      backoffStrategy: 'exponential',
      initialDelayMs: 1000,
      maxDelayMs: 60000,
      visibilityTimeoutMs: 300000,
    });
  }
}