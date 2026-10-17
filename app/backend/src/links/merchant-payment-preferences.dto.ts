import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsString, Min } from 'class-validator';
import { IsStellarPublicKey } from '../dto/validators';
import { LinkConstraints, AssetCode } from './constants';

const SUPPORTED_ASSETS = LinkConstraints.ASSET.WHITELIST;

export class SaveMerchantPaymentPreferencesDto {
  @ApiProperty({ example: 'G...' })
  @IsString()
  @IsStellarPublicKey()
  publicKey!: string;

  @ApiProperty({ minimum: 0, example: 0 })
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiProperty({ enum: SUPPORTED_ASSETS, isArray: true, minItems: 1, maxItems: 8 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsIn(SUPPORTED_ASSETS, { each: true })
  acceptedAssets!: AssetCode[];

  @ApiProperty({ enum: SUPPORTED_ASSETS })
  @IsIn(SUPPORTED_ASSETS)
  settlementAsset!: AssetCode;

  @ApiProperty({ example: 1792252800000 })
  @IsInt()
  @Min(0)
  signedAt!: number;

  @ApiProperty({ description: 'Base64 Ed25519 signature over the documented canonical preferences message' })
  @IsString()
  signature!: string;
}