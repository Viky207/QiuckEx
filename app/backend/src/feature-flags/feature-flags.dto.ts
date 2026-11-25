import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export interface FeatureFlagRecord {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  killSwitch: boolean;
  rolloutPercentage: number;
  allowedUsers: string[];
  environments: string[];
  metadata: Record<string, unknown>;
  updatedAt: string;
  updatedBy: string;
}

export interface FeatureFlagEvaluationContext {
  userId?: string;
  environment?: string;
}

export interface FeatureFlagEvaluationResult {
  key: string;
  enabled: boolean;
  reason:
    | 'enabled'
    | 'disabled'
    | 'kill-switch'
    | 'environment-mismatch'
    | 'allowlist-match'
    | 'rollout-match'
    | 'rollout-miss'
    | 'missing-user-context'
    | 'missing-flag';
  source: 'store' | 'bootstrap' | 'cache';
}

export interface FeatureFlagsListResponse {
  flags: FeatureFlagRecord[];
  source: 'store' | 'bootstrap' | 'cache';
  storeAvailable: boolean;
}

export class UpdateFeatureFlagDto {
  @ApiPropertyOptional({ description: 'Human-readable display name' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Feature flag description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Master enabled toggle' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Emergency kill switch' })
  @IsOptional()
  @IsBoolean()
  killSwitch?: boolean;

  @ApiPropertyOptional({ description: 'Deterministic rollout percentage', minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  rolloutPercentage?: number;

  @ApiPropertyOptional({ description: 'Explicit user allowlist', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  allowedUsers?: string[];

  @ApiPropertyOptional({ description: 'Allowed environments', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  environments?: string[];

  @ApiPropertyOptional({ description: 'Arbitrary flag metadata', type: Object })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class FeatureFlagQueryDto {
  @ApiPropertyOptional({ description: 'User identifier for deterministic rollout evaluation' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Runtime environment (defaults to server NODE_ENV)' })
  @IsOptional()
  @IsString()
  environment?: string;
}

export class EvaluateFeatureFlagResponseDto {
  @ApiProperty()
  key!: string;

  @ApiProperty()
  enabled!: boolean;

  @ApiProperty()
  reason!: string;

  @ApiProperty()
  source!: string;
}

// ── Snapshot DTOs (BE-96) ────────────────────────────────────────────────────

export class FeatureFlagSnapshotQueryDto {
  @ApiPropertyOptional({
    description:
      'Filter flags to those allowed in this environment. Defaults to all flags when omitted.',
  })
  @IsOptional()
  @IsString()
  environment?: string;
}

export class FeatureFlagSnapshotEntryDto {
  @ApiProperty({ example: 'bulk_link_generation' })
  key!: string;

  @ApiProperty({ example: 'Bulk Link Generation' })
  name!: string;

  @ApiProperty({ example: 'Controls new bulk payment-link creation requests.' })
  description!: string;

  @ApiProperty({ example: true })
  enabled!: boolean;

  @ApiProperty({ example: false })
  killSwitch!: boolean;

  @ApiProperty({ example: 100, minimum: 0, maximum: 100 })
  rolloutPercentage!: number;

  @ApiProperty({ type: [String], example: ['development', 'test', 'production'] })
  environments!: string[];

  @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
  updatedAt!: string;

  @ApiProperty({ example: 'bootstrap' })
  updatedBy!: string;

  @ApiProperty({
    description: 'Whether a preview scope override is active for this flag',
    example: false,
    required: false,
  })
  previewOverrideActive?: boolean;
}

export class FeatureFlagSnapshotMetadataDto {
  @ApiProperty({
    description: 'Source of the flag data',
    enum: ['store', 'bootstrap', 'cache'],
    example: 'bootstrap',
  })
  source!: 'store' | 'bootstrap' | 'cache';

  @ApiProperty({
    description: 'Whether the persistent flag store is reachable',
    example: true,
  })
  storeAvailable!: boolean;

  @ApiProperty({
    description: 'Environment used for filtering',
    example: 'test',
    required: false,
  })
  environment?: string;

  @ApiProperty({
    description: 'Number of flags returned (after sensitive flag exclusion)',
    example: 6,
  })
  flagCount!: number;

  @ApiProperty({
    description: 'Number of flags excluded as sensitive/internal',
    example: 0,
  })
  sensitiveFlagCount!: number;

  @ApiProperty({
    description: 'Timestamp of the snapshot',
    example: '2024-01-01T00:00:00.000Z',
  })
  timestamp!: string;

  @ApiProperty({
    description: 'Preview scope identifier when X-Preview-Scope header is present',
    example: 'pr-123',
    required: false,
  })
  previewScope?: string;

  @ApiProperty({
    description: 'Whether the preview scope is valid and not expired',
    example: true,
    required: false,
  })
  previewScopeValid?: boolean;
}

export class FeatureFlagSnapshotResponseDto {
  @ApiProperty({ type: FeatureFlagSnapshotMetadataDto })
  metadata!: FeatureFlagSnapshotMetadataDto;

  @ApiProperty({ type: [FeatureFlagSnapshotEntryDto] })
  flags!: FeatureFlagSnapshotEntryDto[];
}

// ── Deploy Freeze DTOs (#561) ────────────────────────────────────────────────

export class SetDeployFreezeDto {
  @ApiProperty({
    description: 'Reason for placing the environment under a deploy freeze',
    example: 'Incident INC-1234: payment provider degradation',
    maxLength: 500,
  })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class ClearDeployFreezeDto {
  @ApiPropertyOptional({
    description: 'Optional reason for clearing the deploy freeze',
    example: 'Incident resolved; resuming normal promotion',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class DeployFreezeOverrideDto {
  @ApiProperty({
    description: 'Reason justifying the authorized override of the deploy freeze',
    example: 'Emergency hotfix for security vulnerability',
    maxLength: 500,
  })
  @IsString()
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    description: 'Optional ticket or incident reference for audit trail',
    example: 'SEC-5678',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  ticketReference?: string;
}

export class DeployFreezeResponseDto {
  @ApiProperty({
    description: 'Whether the environment is currently under a deploy freeze',
    example: true,
  })
  frozen!: boolean;

  @ApiProperty({
    description: 'Reason recorded when the freeze was set',
    example: 'Incident INC-1234: payment provider degradation',
    required: false,
  })
  reason?: string;

  @ApiProperty({
    description: 'Actor who set the freeze',
    example: 'operator@example.com',
    required: false,
  })
  actor?: string;

  @ApiProperty({
    description: 'Timestamp when the freeze was set',
    example: '2024-01-01T00:00:00.000Z',
    required: false,
  })
  frozenAt?: string;

  @ApiProperty({
    description: 'Monotonic generation counter for the freeze state',
    example: 3,
  })
  generation!: number;
}