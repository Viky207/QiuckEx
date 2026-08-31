import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class BulkOperationCleanup {
  constructor(private readonly supabase: SupabaseService) {}

  @Cron('0 3 * * *')
  async removeExpired(): Promise<void> {
    await this.supabase.getClient().rpc('cleanup_expired_bulk_operations');
  }
}