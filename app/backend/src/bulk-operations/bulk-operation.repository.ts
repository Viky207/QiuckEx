import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { BulkOperationProgress, BulkOperationResponse } from './dto/bulk-operation.dto';

interface OperationRow {
  id: string;
  job_id: string | null;
  status: string;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  current_item: unknown;
  failed_items: Array<{ item: unknown; error: string }>;
}

@Injectable()
export class BulkOperationRepository {
  constructor(private readonly supabase: SupabaseService) {}

  async create(operation: string, filters: Record<string, unknown>, payload: Record<string, unknown>, items: unknown[]) {
    const { data, error } = await this.supabase.getClient()
      .from('bulk_operations')
      .insert({ operation, filters, payload, total: items.length, status: 'queued' })
      .select('id')
      .single();
    if (error) throw error;

    const rows = items.map((item, index) => ({ operation_id: data.id, item, item_index: index }));
    if (rows.length > 0) {
      const result = await this.supabase.getClient().from('bulk_operation_items').insert(rows);
      if (result.error) throw result.error;
    }
    return data.id as string;
  }

  async attachJob(operationId: string, jobId: string): Promise<void> {
    const { error } = await this.supabase.getClient().from('bulk_operations')
      .update({ job_id: jobId }).eq('id', operationId);
    if (error) throw error;
  }

  async get(operationId: string): Promise<BulkOperationResponse | null> {
    const { data, error } = await this.supabase.getClient().from('bulk_operations')
      .select('*').eq('id', operationId).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as OperationRow;
    return { jobId: row.job_id ?? '', status: row.status, total: row.total, processed: row.processed,
      succeeded: row.succeeded, failed: row.failed, currentItem: row.current_item ?? null,
      failedItems: row.failed_items ?? [] };
  }

  async getByJobId(jobId: string): Promise<BulkOperationResponse | null> {
    const { data, error } = await this.supabase.getClient().from('bulk_operations')
      .select('*').eq('job_id', jobId).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as OperationRow;
    return { jobId: row.job_id ?? jobId, status: row.status, total: row.total, processed: row.processed,
      succeeded: row.succeeded, failed: row.failed, currentItem: row.current_item ?? null,
      failedItems: row.failed_items ?? [] };
  }

  async getOperation(operationId: string): Promise<{ operation: string; payload: Record<string, unknown>; total: number } | null> {
    const { data, error } = await this.supabase.getClient().from('bulk_operations')
      .select('operation,payload,total').eq('id', operationId).maybeSingle();
    if (error) throw error;
    return data as { operation: string; payload: Record<string, unknown>; total: number } | null;
  }

  async claimNextItem(operationId: string): Promise<{ id: string; item: unknown } | null> {
    const { data, error } = await this.supabase.getClient().from('bulk_operation_items')
      .select('id,item').eq('operation_id', operationId).eq('status', 'pending')
      .order('item_index', { ascending: true }).limit(1).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return data as { id: string; item: unknown };
  }

  async updateProgress(operationId: string, progress: BulkOperationProgress, failedItems: Array<{ item: unknown; error: string }>, status: string): Promise<void> {
    const { error } = await this.supabase.getClient().from('bulk_operations').update({
      ...progress, current_item: progress.currentItem, failed_items: failedItems, status,
    }).eq('id', operationId);
    if (error) throw error;
  }

  async completeItem(itemId: string, succeeded: boolean, errorMessage?: string): Promise<void> {
    const { error } = await this.supabase.getClient().from('bulk_operation_items').update({
      status: succeeded ? 'succeeded' : 'failed', error: errorMessage ?? null, processed_at: new Date().toISOString(),
    }).eq('id', itemId);
    if (error) throw error;
  }
}