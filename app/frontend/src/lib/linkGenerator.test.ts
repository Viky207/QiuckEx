import { describe, expect, it } from 'vitest';
import {
  MAX_MEMO_LENGTH,
  getVerifiedAssetOptions,
  readDraftLinks,
  saveDraftLink,
  validateAmountInput,
} from './linkGenerator';

describe('validateAmountInput', () => {
  it('accepts positive numbers', () => {
    expect(validateAmountInput('12.5')).toEqual({ valid: true });
  });

  it('rejects empty, zero and invalid values', () => {
    expect(validateAmountInput('')).toEqual({
      valid: false,
      message: 'Amount must be greater than 0.',
    });
    expect(validateAmountInput('0')).toEqual({
      valid: false,
      message: 'Amount must be greater than 0.',
    });
    expect(validateAmountInput('abc')).toEqual({
      valid: false,
      message: 'Enter a valid number.',
    });
  });
});

describe('getVerifiedAssetOptions', () => {
  it('returns only verified assets and falls back to all assets when needed', () => {
    expect(
      getVerifiedAssetOptions([
        { code: 'USDC', verified: true },
        { code: 'XLM', verified: false },
        { code: 'EURC', verified: true },
      ]).map((asset) => asset.code),
    ).toEqual(['USDC', 'EURC']);

    expect(
      getVerifiedAssetOptions([
        { code: 'TEST', verified: false },
        { code: 'MOCK', verified: false },
      ]).map((asset) => asset.code),
    ).toEqual(['TEST', 'MOCK']);
  });
});

describe('draft storage', () => {
  it('saves and reads draft links in order', () => {
    const storage = {
      data: new Map<string, string>(),
      getItem(key: string) {
        return this.data.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        this.data.set(key, value);
      },
      removeItem(key: string) {
        this.data.delete(key);
      },
    } as Storage;

    const draft = {
      id: 'draft-1',
      amount: '25',
      asset: 'USDC',
      destination: 'GABC',
      memo: 'invoice-123',
      createdAt: '2026-08-30T00:00:00.000Z',
    };

    const saved = saveDraftLink(draft, storage);
    expect(saved[0]).toMatchObject(draft);
    expect(readDraftLinks(storage)).toHaveLength(1);
    expect(MAX_MEMO_LENGTH).toBeGreaterThan(0);
  });
});
