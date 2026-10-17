import { getQuickexApiBase } from '@/lib/api';

export const MERCHANT_PREFERENCE_ASSETS = ['XLM', 'USDC', 'AQUA', 'yXLM'] as const;
export type MerchantPreferenceAsset = typeof MERCHANT_PREFERENCE_ASSETS[number];

export type MerchantPaymentPreferences = {
  publicKey: string;
  acceptedAssets: MerchantPreferenceAsset[];
  settlementAsset: MerchantPreferenceAsset;
  version: number;
};

export class MerchantPreferencesRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'MerchantPreferencesRequestError';
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new MerchantPreferencesRequestError(
      typeof body.message === 'string' ? body.message : `Request failed (${response.status}).`,
      response.status,
      typeof body.code === 'string' ? body.code : undefined,
    );
  }
  return body as T;
}

export async function fetchMerchantPaymentPreferences(
  publicKey: string,
): Promise<MerchantPaymentPreferences> {
  const url = new URL(`${getQuickexApiBase()}/merchant/payment-preferences`);
  url.searchParams.set('publicKey', publicKey);
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const result = await parseResponse<{ preferences: MerchantPaymentPreferences }>(response);
  return result.preferences;
}

export async function signableMerchantPreferencesMessage(input: {
  publicKey: string;
  expectedVersion: number;
  signedAt: number;
  acceptedAssets: MerchantPreferenceAsset[];
  settlementAsset: MerchantPreferenceAsset;
}): Promise<string> {
  const acceptedAssets = [...input.acceptedAssets].sort();
  const payload = JSON.stringify({ acceptedAssets, settlementAsset: input.settlementAsset });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const payloadHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    'QuickEx merchant payment preferences',
    input.publicKey,
    String(input.expectedVersion),
    String(input.signedAt),
    payloadHash,
  ].join('\n');
}

export async function saveMerchantPaymentPreferences(
  input: {
    publicKey: string;
    expectedVersion: number;
    signedAt: number;
    acceptedAssets: MerchantPreferenceAsset[];
    settlementAsset: MerchantPreferenceAsset;
    signature: string;
  },
  idempotencyKey: string,
): Promise<MerchantPaymentPreferences> {
  const response = await fetch(`${getQuickexApiBase()}/merchant/payment-preferences`, {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(input),
  });
  const result = await parseResponse<{ preferences: MerchantPaymentPreferences }>(response);
  return result.preferences;
}