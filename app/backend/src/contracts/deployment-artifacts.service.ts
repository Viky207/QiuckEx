import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash, randomUUID } from 'crypto';

import { AppConfigService } from '../config';
import { SupabaseService } from '../supabase/supabase.service';
import { AuditService } from '../audit/audit.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import {
  DeploymentArtifactResponseDto,
  DeploymentArtifactDownloadResponseDto,
  DeploymentArtifactType,
  UploadDeploymentArtifactDto,
} from './dto/deployment-artifact.dto';

/**
 * Thrown when a production promotion or traffic change is attempted while the
 * environment is under a deploy freeze. Validation-only workflows (build, test,
 * dry-run) are never gated and therefore never raise this error.
 */
export class DeployFrozenException extends ForbiddenException {
  constructor(
    readonly environment: string,
    readonly reason: string | null,
    readonly generation: number,
  ) {
    super({
      statusCode: 403,
      error: 'DeployFrozen',
      message: `Deployments are frozen for environment '${environment}'${
        reason ? `: ${reason}` : ''
      }`,
      environment,
      reason,
      generation,
    });
  }
}

export type DeploymentWorkflowKind = 'promotion' | 'traffic-change' | 'validation';

const GATED_WORKFLOW_KINDS: ReadonlySet<DeploymentWorkflowKind> = new Set([
  'promotion',
  'traffic-change',
]);

const RETENTION_DAYS = 180;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024; // 10MB

interface ArtifactRecord {
  id: string;
  deploymentId: string;
  network: string;
  artifactType: DeploymentArtifactType;
  content: string; // base64
  checksumSha256: string;
  sizeBytes: number;
  uploadedBy: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  retentionUntil: string;
}

@Injectable()
export class DeploymentArtifactsService {
  private readonly logger = new Logger(DeploymentArtifactsService.name);
  private readonly fallbackStore = new Map<string, ArtifactRecord>();

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly configService: AppConfigService,
    private readonly auditService: AuditService,
    private readonly featureFlagsService: FeatureFlagsService,
  ) {}

  /**
   * Asserts that the given environment is not under a deploy freeze before a
   * production traffic change or promotion. Validation-only workflows are not
   * gated and pass through untouched.
   *
   * @throws DeployFrozenException when the environment is frozen.
   */
  async assertPromotionAllowed(
    environment: string,
    workflowKind: DeploymentWorkflowKind = 'promotion',
  ): Promise<void> {
    if (!GATED_WORKFLOW_KINDS.has(workflowKind)) {
      return;
    }

    const freeze = await this.featureFlagsService.isFrozen(environment);
    if (freeze.frozen) {
      this.logger.warn(
        `Blocked ${workflowKind} for environment '${environment}' due to deploy freeze (generation ${freeze.generation})`,
      );
      throw new DeployFrozenException(environment, freeze.reason, freeze.generation);
    }
  }

  async upload(
    dto: UploadDeploymentArtifactDto,
    uploadedBy: string,
  ): Promise<DeploymentArtifactResponseDto> {
    // Uploading an artifact is a validation/build-time activity and is never gated
    // by the deploy freeze; only promotion and traffic changes are blocked.
    let buffer: Buffer;
    try {
      buffer = Buffer.from(dto.contentBase64, 'base64');
      if (buffer.length === 0) throw new Error('empty content');
    } catch {
      throw new BadRequestException('contentBase64 must be valid, non-empty base64 content');
    }

    if (buffer.length > MAX_ARTIFACT_BYTES) {
      throw new BadRequestException(
        `Artifact exceeds maximum size of ${MAX_ARTIFACT_BYTES} bytes`,
      );
    }

    const checksum = createHash('sha256').update(buffer).digest('hex');
    const now = new Date();
    const retentionUntil = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const record: ArtifactRecord = {
      id: randomUUID(),
      deploymentId: dto.deploymentId,
      network: dto.network ?? this.configService.network,
      artifactType: dto.artifactType,
      content: dto.contentBase64,
      checksumSha256: checksum,
      sizeBytes: buffer.length,
      uploadedBy,
      metadata: dto.metadata,
      createdAt: now.toISOString(),
      retentionUntil: retentionUntil.toISOString(),
    };

    await this.persist(record);

    await this.auditService.log(uploadedBy, 'deployment_artifact.uploaded', record.id, {
      deploymentId: record.deploymentId,
      artifactType: record.artifactType,
      sizeBytes: record.sizeBytes,
      checksumSha256: record.checksumSha256,
    });

    return this.toResponseDto(record);
  }

  async list(filters: {
    deploymentId?: string;
    artifactType?: DeploymentArtifactType;
  }): Promise<DeploymentArtifactResponseDto[]> {
    const records = await this.readRecords();
    return records
      .filter((r) => !filters.deploymentId || r.deploymentId === filters.deploymentId)
      .filter((r) => !filters.artifactType || r.artifactType === filters.artifactType)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((r) => this.toResponseDto(r));
  }

  async download(id: string): Promise<DeploymentArtifactDownloadResponseDto> {
    // Downloading an artifact is a validation/build-time activity and is never gated
    // by the deploy freeze.
    const records = await this.readRecords();
    const record = records.find((r) => r.id === id);
    if (!record) {
      throw new NotFoundException(`Deployment artifact ${id} not found`);
    }

    const freshChecksum = createHash('sha256')
      .update(Buffer.from(record.content, 'base64'))
      .digest('hex');

    return {
      ...this.toResponseDto(record),
      contentBase64: record.content,
      checksumValid: freshChecksum === record.checksumSha256,
    };
  }

  /**
   * Promotes a deployment artifact to the target environment. This is a
   * production traffic change and is blocked while the environment is frozen.
   */
  async promote(
    id: string,
    environment: string,
    promotedBy: string,
  ): Promise<DeploymentArtifactResponseDto> {
    await this.assertPromotionAllowed(environment, 'promotion');

    const records = await this.readRecords();
    const record = records.find((r) => r.id === id);
    if (!record) {
      throw new NotFoundException(`Deployment artifact ${id} not found`);
    }

    await this.auditService.log(promotedBy, 'deployment_artifact.promoted', record.id, {
      deploymentId: record.deploymentId,
      environment,
      checksumSha256: record.checksumSha256,
    });

    return this.toResponseDto(record);
  }

  /**
   * Retention sweeper: removes artifacts past their retention_until date.
   * Runs daily; safe to run concurrently across instances since deletes are idempotent.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupExpired(): Promise<number> {
    const now = new Date().toISOString();

    try {
      const client = this.supabaseService.getClient();
      const { data, error } = await client
        .from('deployment_artifacts')
        .delete()
        .lt('retention_until', now)
        .select('id');

      if (error) throw error;

      const deletedFromStore = data?.length ?? 0;
      if (deletedFromStore > 0) {
        this.logger.log(`Retention sweep removed ${deletedFromStore} expired deployment artifacts`);
      }
      return deletedFromStore;
    } catch (error) {
      let deletedFromFallback = 0;
      for (const [id, record] of this.fallbackStore.entries()) {
        if (record.retentionUntil < now) {
          this.fallbackStore.delete(id);
          deletedFromFallback += 1;
        }
      }
      if (deletedFromFallback > 0) {
        this.logger.warn(
          `Supabase unavailable during retention sweep, cleaned ${deletedFromFallback} from fallback store: ${
            (error as Error).message
          }`,
        );
      }
      return deletedFromFallback;
    }
  }

  private async persist(record: ArtifactRecord): Promise<void> {
    this.fallbackStore.set(record.id, record);

    try {
      const client = this.supabaseService.getClient();
      const { error } = await client.from('deployment_artifacts').insert({
        id: record.id,
        deployment_id: record.deploymentId,
        network: record.network,
        artifact_type: record.artifactType,
        content: record.content,
        content_encoding: 'base64',
        checksum_sha256: record.checksumSha256,
        size_bytes: record.sizeBytes,
        uploaded_by: record.uploadedBy,
        metadata: record.metadata ?? {},
        created_at: record.createdAt,
        retention_until: record.retentionUntil,
      });
      if (error) throw error;
    } catch (error) {
      this.logger.warn(
        `Failed to persist deployment artifact ${record.id} to Supabase, kept in fallback store only: ${
          (error as Error).message
        }`,
      );
    }
  }

  private async readRecords(): Promise<ArtifactRecord[]> {
    const fallback = Array.from(this.fallbackStore.values());

    try {
      const client = this.supabaseService.getClient();
      const { data, error } = await client
        .from('deployment_artifacts')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      if (!data || data.length === 0) return fallback;

      return data.map((row) => ({
        id: String(row.id),
        deploymentId: String(row.deployment_id),
        network: String(row.network),
        artifactType: row.artifact_type as DeploymentArtifactType,
        content: String(row.content),
        checksumSha256: String(row.checksum_sha256),
        sizeBytes: Number(row.size_bytes),
        uploadedBy: String(row.uploaded_by),
        metadata: (row.metadata as Record<string, unknown>) ?? {},
        createdAt: String(row.created_at),
        retentionUntil: String(row.retention_until),
      }));
    } catch (error) {
      this.logger.warn(
        `Falling back to in-memory deployment artifact store: ${(error as Error).message}`,
      );
      return fallback;
    }
  }

  private toResponseDto(record: ArtifactRecord): DeploymentArtifactResponseDto {
    return {
      id: record.id,
      deploymentId: record.deploymentId,
      network: record.network,
      artifactType: record.artifactType,
      checksumSha256: record.checksumSha256,
      sizeBytes: record.sizeBytes,
      uploadedBy: record.uploadedBy,
      metadata: record.metadata,
      createdAt: record.createdAt,
      retentionUntil: record.retentionUntil,
    };
  }
}
