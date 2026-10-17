import { Keypair } from '@stellar/stellar-sdk';
import { MerchantPaymentPreferencesService, merchantPreferencesSigningMessage } from './merchant-payment-preferences.service';
import { LinkConstraints } from './constants';

describe('MerchantPaymentPreferencesService', () => {
  const keypair = Keypair.random();
  const repository = {
    get: jest.fn(),
    save: jest.fn(),
    findReplay: jest.fn().mockResolvedValue(null),
  };
  const config = { isTestnet: true };
  const featureFlags = { evaluateFlagFresh: jest.fn().mockResolvedValue({ enabled: true }) };
  const metrics = {
    recordError: jest.fn(),
    recordExternalCall: jest.fn(),
    recordMerchantPaymentPreferencesRequest: jest.fn(),
  };
  const service = new MerchantPaymentPreferencesService(
    repository as never,
    config as never,
    featureFlags as never,
    metrics as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    repository.findReplay.mockResolvedValue(null);
    featureFlags.evaluateFlagFresh.mockResolvedValue({ enabled: true });
    config.isTestnet = true;
  });

  function makeRequest(overrides: Record<string, unknown> = {}) {
    const request = {
      publicKey: keypair.publicKey(),
      expectedVersion: 0,
      acceptedAssets: ['XLM', 'USDC'] as Array<(typeof LinkConstraints.ASSET.WHITELIST)[number]>,
      settlementAsset: 'USDC' as (typeof LinkConstraints.ASSET.WHITELIST)[number],
      signedAt: Date.now(),
      signature: '',
      ...overrides,
    };
    request.signature = keypair.sign(Buffer.from(merchantPreferencesSigningMessage(request))).toString('base64');
    return request;
  }

  it('accepts a wallet-authorized preference update and records a versioned save', async () => {
    const preferences = {
      publicKey: keypair.publicKey(),
      acceptedAssets: ['USDC', 'XLM'],
      settlementAsset: 'USDC',
      version: 1,
    };
    repository.save.mockResolvedValue({ status: 'saved', preferences, replayed: false });

    await expect(service.save(makeRequest(), 'merchant-pref-key-0001')).resolves.toEqual(preferences);
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ acceptedAssets: ['USDC', 'XLM'], settlementAsset: 'USDC' }),
      'merchant-pref-key-0001',
      expect.any(String),
    );
  });

  it('returns the original result for an idempotent retry', async () => {
    const preferences = {
      publicKey: keypair.publicKey(),
      acceptedAssets: ['USDC', 'XLM'],
      settlementAsset: 'USDC',
      version: 1,
    };
    repository.findReplay.mockResolvedValue({ status: 'replayed', preferences });

    const expiredRetry = makeRequest({ signedAt: Date.now() - 10 * 60 * 1000 });
    await expect(service.save(expiredRetry, 'merchant-pref-key-0001')).resolves.toEqual(preferences);
    expect(metrics.recordMerchantPaymentPreferencesRequest).toHaveBeenCalledWith('save', 'replayed');
  });

  it('surfaces stale versions and key reuse as a stable conflict', async () => {
    repository.save.mockResolvedValue({ status: 'conflict', replayed: false });
    await expect(service.save(makeRequest(), 'merchant-pref-key-0001')).rejects.toMatchObject({
      code: 'MERCHANT_PREFERENCES_CONFLICT',
      status: 409,
    });
  });

  it('rejects unsupported assets before persistence', async () => {
    const request = makeRequest({ acceptedAssets: ['DOGE'], settlementAsset: 'DOGE' });
    await expect(service.save(request, 'merchant-pref-key-0001')).rejects.toMatchObject({
      code: 'MERCHANT_PREFERENCES_MALFORMED',
      status: 400,
    });
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('rejects duplicate accepted assets', async () => {
    const request = makeRequest({ acceptedAssets: ['XLM', 'XLM'] });
    await expect(service.save(request, 'merchant-pref-key-0001')).rejects.toMatchObject({
      code: 'MERCHANT_PREFERENCES_MALFORMED',
      status: 400,
    });
    expect(repository.findReplay).not.toHaveBeenCalled();
  });

  it('rejects a settlement asset that is not accepted', async () => {
    const request = makeRequest({ acceptedAssets: ['XLM'], settlementAsset: 'USDC' });
    await expect(service.save(request, 'merchant-pref-key-0001')).rejects.toMatchObject({
      code: 'MERCHANT_PREFERENCES_MALFORMED',
      status: 400,
    });
  });

  it('rejects expired and invalid wallet authorizations', async () => {
    const expired = makeRequest({ signedAt: Date.now() - 10 * 60 * 1000 });
    await expect(service.save(expired, 'merchant-pref-key-0001')).rejects.toMatchObject({
      code: 'MERCHANT_PREFERENCES_EXPIRED',
      status: 410,
    });

    const invalid = makeRequest();
    invalid.signature = Buffer.alloc(64).toString('base64');
    await expect(service.save(invalid, 'merchant-pref-key-0001')).rejects.toMatchObject({
      code: 'MERCHANT_PREFERENCES_UNAUTHORIZED',
      status: 401,
    });
  });

  it('requires an idempotency key and the testnet feature gate', async () => {
    await expect(service.save(makeRequest())).rejects.toMatchObject({
      code: 'MERCHANT_PREFERENCES_MALFORMED',
      status: 400,
    });

    featureFlags.evaluateFlagFresh.mockResolvedValueOnce({ enabled: false });
    await expect(service.get(keypair.publicKey())).rejects.toMatchObject({
      code: 'MERCHANT_PREFERENCES_DISABLED',
      status: 503,
    });
  });

  it('refuses mainnet even if the feature flag is enabled', async () => {
    config.isTestnet = false;
    await expect(service.get(keypair.publicKey())).rejects.toMatchObject({
      code: 'MERCHANT_PREFERENCES_DISABLED',
      status: 503,
    });
    expect(repository.get).not.toHaveBeenCalled();
    config.isTestnet = true;
  });

  it('returns a stable dependency error and recovers on a later read', async () => {
    repository.get
      .mockRejectedValueOnce(new Error('database details must not escape'))
      .mockResolvedValueOnce({
        publicKey: keypair.publicKey(),
        acceptedAssets: ['XLM'],
        settlementAsset: 'XLM',
        version: 0,
      });

    await expect(service.get(keypair.publicKey())).rejects.toMatchObject({
      code: 'MERCHANT_PREFERENCES_DEPENDENCY_FAILURE',
      status: 503,
    });
    await expect(service.get(keypair.publicKey())).resolves.toMatchObject({ version: 0 });
  });

  it('maps a failed preference write to a stable dependency error', async () => {
    repository.findReplay.mockResolvedValueOnce(null);
    repository.save.mockRejectedValueOnce(new Error('database detail must not escape'));
    await expect(service.save(makeRequest(), 'merchant-pref-key-0001')).rejects.toMatchObject({
      code: 'MERCHANT_PREFERENCES_DEPENDENCY_FAILURE',
      status: 503,
    });
  });
});