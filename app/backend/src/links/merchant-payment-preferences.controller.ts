import {
  Controller,
  Get,
  Headers,
  HttpException,
  ServiceUnavailableException,
  Query,
  Put,
  Body,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { MerchantPaymentPreferencesError, MerchantPaymentPreferencesService } from './merchant-payment-preferences.service';
import { SaveMerchantPaymentPreferencesDto } from './merchant-payment-preferences.dto';

@ApiTags('merchant-payment-preferences')
@Controller('merchant/payment-preferences')
export class MerchantPaymentPreferencesController {
  constructor(private readonly preferences: MerchantPaymentPreferencesService) {}

  @Get()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Read a merchant wallet payment preference snapshot' })
  @ApiQuery({ name: 'publicKey', required: true, description: 'Merchant Stellar public key' })
  async get(@Query('publicKey') publicKey: string) {
    try {
      return { preferences: await this.preferences.get(publicKey) };
    } catch (error) {
      this.rethrow(error);
    }
  }

  @Put()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Save wallet-authorized accepted asset and settlement preferences' })
  async save(
    @Body() body: SaveMerchantPaymentPreferencesDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    try {
      return {
        preferences: await this.preferences.save(body, idempotencyKey),
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  private rethrow(error: unknown): never {
    if (error instanceof MerchantPaymentPreferencesError) {
      throw new HttpException(
        { code: error.code, message: error.message },
        error.status,
      );
    }
    throw new ServiceUnavailableException({
      code: 'MERCHANT_PREFERENCES_DEPENDENCY_FAILURE',
      message: 'Merchant preferences are temporarily unavailable',
    });
  }
}