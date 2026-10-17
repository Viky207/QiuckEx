import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AssetCode } from './constants';
import { MerchantPaymentPreferences } from './merchant-payment-preferences.service';

type SavePreferencesInput = {
  publicKey: string;
  expectedVersion: number;
  acceptedAssets: AssetCode[];
  settlementAsset: AssetCode;
};

@Injectable()
export class MerchantPaymentPreferencesRepository {
  constructor(private readonly supabase: SupabaseService) {}

  async get(publicKey: string): Promise<MerchantPaymentPreferences> {
    const { data, error } = await this.supabase
      .getClient()
      .from('merchant_payment_preferences')
      .select('public_key, accepted_assets, settlement_asset, version')
      .eq('public_key', publicKey)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return {
        publicKey,
        acceptedAssets: ['XLM'],
        settlementAsset: 'XLM',
        version: 0,
      };
    }
    return {
      publicKey: data.public_key,
      acceptedAssets: data.accepted_assets as AssetCode[],
      settlementAsset: data.settlement_asset as AssetCode,
      version: data.version,
    };
  }

  async save(
    input: SavePreferencesInput,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<{
    status: 'saved' | 'replayed' | 'conflict';
    preferences: MerchantPaymentPreferences;
    replayed: boolean;
  }> {
    const idempotencyKeyHash = createHash('sha256')
      .update(idempotencyKey)
      .digest('hex');
    const { data, error } = await this.supabase.getClient().rpc(
      'save_merchant_payment_preferences',
      {
        p_public_key: input.publicKey,
        p_expected_version: input.expectedVersion,
        p_accepted_assets: input.acceptedAssets,
        p_settlement_asset: input.settlementAsset,
        p_idempotency_key_hash: idempotencyKeyHash,
        p_payload_hash: payloadHash,
      },
    );
    if (error) throw error;
    const result = data as {
      status: 'saved' | 'replayed' | 'conflict';
      preferences: {
        publicKey: string;
        acceptedAssets: AssetCode[];
        settlementAsset: AssetCode;
        version: number;
      };
    };
    if (result.status === 'conflict') {
      return { status: 'conflict', preferences: undefined as never, replayed: false };
    }
    return {
      status: result.status,
      preferences: result.preferences,
      replayed: result.status === 'replayed',
    };
  }

  async findReplay(
    publicKey: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<{
    status: 'replayed' | 'conflict';
    preferences?: MerchantPaymentPreferences;
  } | null> {
    const idempotencyKeyHash = createHash('sha256')
      .update(idempotencyKey)
      .digest('hex');
    const { data, error } = await this.supabase
      .getClient()
      .from('merchant_payment_preference_idempotency')
      .select('public_key, payload_hash, response, created_at')
      .eq('idempotency_key_hash', idempotencyKeyHash)
      .maybeSingle();
    if (error) throw error;
    if (!data || Date.now() - Date.parse(data.created_at) > 24 * 60 * 60 * 1000) {
      return null;
    }
    if (data.public_key !== publicKey || data.payload_hash !== payloadHash) {
      return { status: 'conflict' };
    }
    const stored = data.response as { preferences: MerchantPaymentPreferences };
    return { status: 'replayed', preferences: stored.preferences };
  }
}