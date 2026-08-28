import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

import { IsStellarPublicKey, IsUsername } from '../validators';

/** Payload for a time-bound, wallet-signed username claim. */
export class ClaimUsernameDto {
  @ApiProperty({ example: 'alice_123', minLength: 3, maxLength: 32 })
  @IsString()
  @IsNotEmpty()
  @IsUsername()
  username!: string;

  @ApiProperty({
    description: 'Unix milliseconds followed by a base64 Ed25519 signature, separated by a dot',
    example: '1735689600000.MEUCIG...=',
  })
  @IsString()
  @IsNotEmpty()
  signature!: string;

  @ApiProperty({ example: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJ5HIAJTGKIN2ER7LBNVKOCCWN' })
  @IsString()
  @IsNotEmpty()
  @IsStellarPublicKey()
  publicKey!: string;
}