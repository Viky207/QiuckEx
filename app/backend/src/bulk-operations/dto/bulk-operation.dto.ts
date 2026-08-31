import { IsObject, IsString } from 'class-validator';

export class CreateBulkOperationDto {
  @IsString()
  operation!: string;

  @IsObject()
  filters!: Record<string, unknown>;

  @IsObject()
  payload!: Record<string, unknown>;
}

export interface BulkOperationProgress {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  currentItem: unknown | null;
}

export interface BulkOperationResponse extends BulkOperationProgress {
  jobId: string;
  status: string;
  failedItems: Array<{ item: unknown; error: string }>;
}