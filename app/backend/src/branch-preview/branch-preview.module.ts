import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BranchPreviewController } from './branch-preview.controller';
import { BranchPreviewService } from './branch-preview.service';
import { BranchPreviewAutoExpiryService } from './branch-preview-auto-expiry.service';
import { BranchPreviewStaleCleanupService } from './branch-preview-stale-cleanup.service';
import { BranchPreviewCache } from './branch-preview.cache';
import { BranchPreviewRepository } from './branch-preview.repository';
import { AuditModule } from '../audit/audit.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';

@Module({
  imports: [ScheduleModule.forRoot(), AuditModule, SupabaseModule, ApiKeysModule],
  controllers: [BranchPreviewController],
  providers: [
    BranchPreviewService,
    BranchPreviewAutoExpiryService,
    BranchPreviewStaleCleanupService,
    BranchPreviewCache,
    BranchPreviewRepository,
  ],
  exports: [BranchPreviewService, BranchPreviewAutoExpiryService],
})
export class BranchPreviewModule {}