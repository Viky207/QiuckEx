import { createHash } from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { MetricsService } from '../metrics/metrics.service';
import { LinkConstraints, AssetCode } from './constants';
import { MerchantPaymentPreferencesRepository } from './merchant-payment-preferences.repository';

export const MERCHANT_PAYMENT_PREFERENCES_FLAG = 'merchant.payment_preferences';
export const MERCHANT_PREFERENCES_SIGNATURE_TTL_MS = 5 * 60 * 1000;

export type MerchantPaymentPreferences = {
  publicKey: string;
  acceptedAssets: AssetCode[];
  settlementAsset: AssetCode;
  version: number;
};

export type SaveMerchantPaymentPreferences = {
  publicKey: string;
  acceptedAssets: AssetCode[];
  settlementAsset: AssetCode;
  expectedVersion: number;
  signedAt: number;
  signature: string;
};

export class MerchantPaymentPreferencesError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MerchantPaymentPreferencesError';
  }
}

export function merchantPreferencesSigningMessage(
  input: Omit<SaveMerchantPaymentPreferences, 'signature' | 'version'>,
): string {
  const acceptedAssets = [...input.acceptedAssets].sort();
  const payloadHash = createHash('sha256')
    .update(JSON.stringify({ acceptedAssets, settlementAsset: input.settlementAsset }))
    .digest('hex');
  return [
    'QuickEx merchant payment preferences',
    input.publicKey,
    String(input.expectedVersion),
    String(input.signedAt),
    payloadHash,
  ].join('\n');
}

@Injectable()
export class MerchantPaymentPreferencesService {
  private readonly logger = new Logger(MerchantPaymentPreferencesService.name);

  constructor(
    private readonly repository: MerchantPaymentPreferencesRepository,
    private readonly config: AppConfigService,
    private readonly featureFlags: FeatureFlagsService,
    private readonly metrics: MetricsService,
  ) {}

  async get(publicKey: string): Promise<MerchantPaymentPreferences> {
    const startedAt = Date.now();
    try {
      await this.assertAvailable();
      this.validatePublicKey(publicKey);
      const preferences = await this.repository.get(publicKey);
      this.metrics.recordMerchantPaymentPreferencesRequest('read', 'success');
      this.logger.log({
        event: 'merchant_payment_preferences.read',
        status: 'success',
        version: preferences.version,
        latencyMs: Date.now() - startedAt,
      });
      return preferences;
    } catch (error) {
      this.recordFailure(error, 'read', startedAt);
      if (error instanceof MerchantPaymentPreferencesError) throw error;
      throw new MerchantPaymentPreferencesError(
        'MERCHANT_PREFERENCES_DEPENDENCY_FAILURE',
        'Merchant preferences are temporarily unavailable',
        503,
      );
    } finally {
      this.metrics.recordExternalCall(
        'merchant_payment_preferences',
        'read',
        (Date.now() - startedAt) / 1000,
      );
    }
  }

  async save(
    input: SaveMerchantPaymentPreferences,
    idempotencyKey?: string,
  ): Promise<MerchantPaymentPreferences> {
    const startedAt = Date.now();
    try {
      await this.assertAvailable();
      this.validate(input, idempotencyKey);
      this.verifySignature(input);

      const acceptedAssets = [...new Set(input.acceptedAssets)].sort() as AssetCode[];
      const semanticPayload = {
        acceptedAssets,
        settlementAsset: input.settlementAsset,
      };
      const payloadHash = createHash('sha256')
        .update(JSON.stringify(semanticPayload))
        .digest('hex');
      const replay = await this.repository.findReplay(
        input.publicKey,
        idempotencyKey!,
        payloadHash,
      );
      if (replay?.status === 'conflict') {
        throw new MerchantPaymentPreferencesError(
          'MERCHANT_PREFERENCES_CONFLICT',
          'Idempotency key was reused with a different wallet or payload',
          409,
        );
      }
      if (replay?.status === 'replayed' && replay.preferences) {
        this.metrics.recordMerchantPaymentPreferencesRequest('save', 'replayed');
        this.logger.log({
          event: 'merchant_payment_preferences.saved',
          status: 'replayed',
          version: replay.preferences.version,
          latencyMs: Date.now() - startedAt,
        });
        return replay.preferences;
      }
      if (Math.abs(Date.now() - input.signedAt) > MERCHANT_PREFERENCES_SIGNATURE_TTL_MS) {
        throw new MerchantPaymentPreferencesError(
          'MERCHANT_PREFERENCES_EXPIRED',
          'The wallet authorization has expired; sign the preferences again',
          410,
        );
      }
      const result = await this.repository.save(
        {
          publicKey: input.publicKey,
          expectedVersion: input.expectedVersion,
          acceptedAssets,
          settlementAsset: input.settlementAsset,
        },
        idempotencyKey!,
        payloadHash,
      );
      if (result.status === 'conflict') {
        throw new MerchantPaymentPreferencesError(
          'MERCHANT_PREFERENCES_CONFLICT',
          'Preferences changed or the idempotency key was reused with a different payload',
          409,
        );
      }
      this.logger.log({
        event: 'merchant_payment_preferences.saved',
        status: result.replayed ? 'replayed' : 'success',
        version: result.preferences.version,
        latencyMs: Date.now() - startedAt,
      });
      this.metrics.recordMerchantPaymentPreferencesRequest(
        'save',
        result.replayed ? 'replayed' : 'success',
      );
      return result.preferences;
    } catch (error) {
      this.recordFailure(error, 'save', startedAt);
      if (error instanceof MerchantPaymentPreferencesError) throw error;
      throw new MerchantPaymentPreferencesError(
        'MERCHANT_PREFERENCES_DEPENDENCY_FAILURE',
        'Merchant preferences are temporarily unavailable',
        503,
      );
    } finally {
      this.metrics.recordExternalCall(
        'merchant_payment_preferences',
        'save',
        (Date.now() - startedAt) / 1000,
      );
    }
  }

  private recordFailure(error: unknown, operation: 'read' | 'save', startedAt: number): void {
    const code = error instanceof MerchantPaymentPreferencesError
      ? error.code
      : 'MERCHANT_PREFERENCES_DEPENDENCY_FAILURE';
    this.logger.warn({
      event: 'merchant_payment_preferences.failed',
      operation,
      code,
      latencyMs: Date.now() - startedAt,
    });
    this.metrics.recordError('merchant_payment_preferences', code);
    this.metrics.recordMerchantPaymentPreferencesRequest(operation, 'failure', code);
  }

  private async assertAvailable(): Promise<void> {
    if (!this.config.isTestnet) {
      throw new MerchantPaymentPreferencesError(
        'MERCHANT_PREFERENCES_DISABLED',
        'Merchant payment preferences are not enabled on this network',
        503,
      );
    }
    const flag = await this.featureFlags.evaluateFlagFresh(
      MERCHANT_PAYMENT_PREFERENCES_FLAG,
    );
    if (!flag.enabled) {
      throw new MerchantPaymentPreferencesError(
        'MERCHANT_PREFERENCES_DISABLED',
        'Merchant payment preferences are currently disabled',
        503,
      );
    }
  }

  private validate(input: SaveMerchantPaymentPreferences, idempotencyKey?: string): void {
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
      throw new MerchantPaymentPreferencesError(
        'MERCHANT_PREFERENCES_MALFORMED',
        'A valid Idempotency-Key header is required',
        400,
      );
    }
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0 ||
      !Number.isSafeInteger(input.signedAt)
    ) {
      throw new MerchantPaymentPreferencesError(
        'MERCHANT_PREFERENCES_MALFORMED',
        'Preference version or signing timestamp is malformed',
        400,
      );
    }
    if (!Array.isArray(input.acceptedAssets) || input.acceptedAssets.length < 1 || input.acceptedAssets.length > 8) {
      throw new MerchantPaymentPreferencesError(
        'MERCHANT_PREFERENCES_MALFORMED',
        'Select between 1 and 8 accepted assets',
        400,
      );
    }
    if (new Set(input.acceptedAssets).size !== input.acceptedAssets.length) {
      throw new MerchantPaymentPreferencesError(
        'MERCHANT_PREFERENCES_MALFORMED',
        'Accepted assets must not contain duplicates',
        400,
      );
    }
    const supportedAssets = LinkConstraints.ASSET.WHITELIST as readonly string[];
    if (
      input.acceptedAssets.some((asset) => !supportedAssets.includes(asset)) ||
      !supportedAssets.includes(input.settlementAsset) ||
      !input.acceptedAssets.includes(input.settlementAsset)
    ) {
      throw new MerchantPaymentPreferencesError(
        'MERCHANT_PREFERENCES_MALFORMED',
        'Assets must be supported and the settlement asset must be accepted',
        400,
      );
    }
    this.validatePublicKey(input.publicKey);
  }

  private validatePublicKey(publicKey: string): void {
    try {
      Keypair.fromPublicKey(publicKey);
    } catch {
      throw new MerchantPaymentPreferencesError(
        'MERCHANT_PREFERENCES_MALFORMED',
        'A valid Stellar public key is required',
        400,
      );
    }
  }

  private verifySignature(input: SaveMerchantPaymentPreferences): void {
    try {
      const signature = Buffer.from(input.signature, 'base64');
      const verified = Keypair.fromPublicKey(input.publicKey).verify(
        Buffer.from(merchantPreferencesSigningMessage(input), 'utf8'),
        signature,
      );
      if (verified) return;
    } catch {
      // Return a stable authorization error for malformed keys and signatures.
    }
    throw new MerchantPaymentPreferencesError(
      'MERCHANT_PREFERENCES_UNAUTHORIZED',
      'Wallet authorization is invalid',
      401,
    );
  }
}