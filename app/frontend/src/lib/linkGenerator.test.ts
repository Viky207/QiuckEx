import { describe, expect, it } from 'vitest';
import {
  FORM_DRAFT_STORAGE_KEY,
  FORM_DRAFT_VERSION,
  MAX_MEMO_LENGTH,
  clearFormDraft,
  formatIssuerPreview,
  getVerifiedAssetOptions,
  isCustomAssetUnverified,
  isFormDraftWorthSaving,
  readDraftLinks,
  readFormDraft,
  saveDraftLink,
  saveFormDraft,
  toAssetIdentityRef,
  validateAmountInput,
  validateAssetCode,
  validateMemoInput,
  validatePaymentLinkPreview,
} from './linkGenerator';

function makeMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
  } as unknown as Storage;
}

describe('validateAmountInput', () => {
  it('accepts positive numbers', () => {
    expect(validateAmountInput('12.5')).toEqual({ valid: true });
    expect(validateAmountInput('0.0000001')).toEqual({ valid: true });
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

  it('rejects amounts exceeding 7 decimal places (Stellar stroop precision)', () => {
    const res = validateAmountInput('1.12345678');
    expect(res.valid).toBe(false);
    expect(res.message).toContain('7 decimal places');
  });

  it('rejects amounts exceeding Stellar max limits', () => {
    const res = validateAmountInput('9999999999999999999');
    expect(res.valid).toBe(false);
    expect(res.message).toContain('maximum');
  });
});

describe('validateMemoInput', () => {
  it('accepts empty memo', () => {
    expect(validateMemoInput('')).toEqual({ valid: true, byteLength: 0 });
  });

  it('accepts memos within 28 bytes', () => {
    const res = validateMemoInput('Order-12345');
    expect(res.valid).toBe(true);
    expect(res.byteLength).toBe(11);
  });

  it('rejects memos exceeding 28 bytes', () => {
    const longMemo = 'This is a memo that is definitely longer than 28 bytes';
    const res = validateMemoInput(longMemo);
    expect(res.valid).toBe(false);
    expect(res.message).toContain('exceeds maximum limit of 28 bytes');
  });

  it('accurately counts multi-byte UTF-8 characters', () => {
    // 🚀 is 4 bytes
    const emojiMemo = '🚀🚀🚀🚀🚀🚀🚀🚀'; // 8 emojis * 4 bytes = 32 bytes
    const res = validateMemoInput(emojiMemo);
    expect(res.valid).toBe(false);
    expect(res.byteLength).toBe(32);
  });
});

describe('validateAssetCode', () => {
  it('accepts valid asset codes', () => {
    expect(validateAssetCode('XLM')).toEqual({ valid: true, normalized: 'XLM' });
    expect(validateAssetCode('usdc')).toEqual({ valid: true, normalized: 'USDC' });
    expect(validateAssetCode('EURC123')).toEqual({ valid: true, normalized: 'EURC123' });
  });

  it('rejects invalid asset codes', () => {
    expect(validateAssetCode('')).toEqual({
      valid: false,
      message: 'Asset code is required.',
    });
    expect(validateAssetCode('TOOLONGASSETCODE123')).toEqual({
      valid: false,
      message: 'Asset code must be 1-12 uppercase alphanumeric characters.',
    });
    expect(validateAssetCode('BAD-CODE')).toEqual({
      valid: false,
      message: 'Asset code must be 1-12 uppercase alphanumeric characters.',
    });
  });
});

describe('validatePaymentLinkPreview', () => {
  it('validates a complete valid payment link preview', () => {
    const res = validatePaymentLinkPreview({
      amount: '25.50',
      asset: 'USDC',
      memo: 'Invoice 101',
      username: 'alice',
    });
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual({});
  });

  it('validates valid destination G-address', () => {
    const res = validatePaymentLinkPreview({
      amount: '10',
      asset: 'XLM',
      destination: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    });
    expect(res.valid).toBe(true);
  });

  it('rejects missing recipient', () => {
    const res = validatePaymentLinkPreview({
      amount: '10',
      asset: 'XLM',
    });
    expect(res.valid).toBe(false);
    expect(res.errors.recipient).toBeDefined();
  });

  it('collects multiple validation errors across amount, asset, and memo', () => {
    const res = validatePaymentLinkPreview({
      amount: '-5',
      asset: 'INVALID_ASSET_TOOLONG',
      memo: 'This memo is excessively long and will fail Stellar 28 byte limit',
      username: 'bob',
    });
    expect(res.valid).toBe(false);
    expect(res.errors.amount).toBeDefined();
    expect(res.errors.asset).toBeDefined();
    expect(res.errors.memo).toBeDefined();
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
    const storage = makeMemoryStorage();

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

describe('form draft storage', () => {
  const draftInput = {
    amount: '42.5',
    asset: 'USDC',
    memo: 'invoice-77',
    displayOptions: { advancedOpen: true, slippagePct: '0.75' },
  };

  it('saves and restores a valid draft', () => {
    const storage = makeMemoryStorage();
    saveFormDraft(draftInput, storage);

    const restored = readFormDraft(storage);
    expect(restored).toMatchObject(draftInput);
    expect(restored?.version).toBe(FORM_DRAFT_VERSION);
    expect(typeof restored?.savedAt).toBe('string');
  });

  it('never persists a secret key or signed XDR field', () => {
    const storage = makeMemoryStorage();
    saveFormDraft(draftInput, storage);

    const raw = storage.getItem(FORM_DRAFT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(raw).not.toMatch(/secret|xdr/i);
  });

  it('discards a malformed JSON draft instead of throwing', () => {
    const storage = makeMemoryStorage();
    storage.setItem(FORM_DRAFT_STORAGE_KEY, '{not valid json');

    expect(() => readFormDraft(storage)).not.toThrow();
    expect(readFormDraft(storage)).toBeNull();
  });

  it('discards a draft saved under an older/newer version', () => {
    const storage = makeMemoryStorage();
    storage.setItem(
      FORM_DRAFT_STORAGE_KEY,
      JSON.stringify({ ...draftInput, version: FORM_DRAFT_VERSION + 1, savedAt: new Date().toISOString() }),
    );

    expect(readFormDraft(storage)).toBeNull();
  });

  it('removes a saved draft on clear', () => {
    const storage = makeMemoryStorage();
    saveFormDraft(draftInput, storage);
    expect(readFormDraft(storage)).not.toBeNull();

    clearFormDraft(storage);
    expect(readFormDraft(storage)).toBeNull();
  });

  it('only considers a draft worth saving when amount or memo has content', () => {
    expect(isFormDraftWorthSaving({ amount: '', memo: '' })).toBe(false);
    expect(isFormDraftWorthSaving({ amount: '10', memo: '' })).toBe(true);
    expect(isFormDraftWorthSaving({ amount: '', memo: 'note' })).toBe(true);
  });
});

describe('asset issuer identity', () => {
  const issuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

  it('treats native XLM as verified regardless of the verified flag', () => {
    expect(isCustomAssetUnverified({ code: 'XLM', type: 'native', verified: false })).toBe(false);
  });

  it('flags a custom asset as unverified only when verified is explicitly false', () => {
    expect(
      isCustomAssetUnverified({ code: 'USDC', type: 'credit_alphanum4', issuer, verified: false }),
    ).toBe(true);
    expect(
      isCustomAssetUnverified({ code: 'USDC', type: 'credit_alphanum4', issuer, verified: true }),
    ).toBe(false);
  });

  it('resolves the full code+issuer identity for a custom asset selection', () => {
    expect(toAssetIdentityRef({ code: 'USDC', issuer })).toEqual({ code: 'USDC', issuer });
    expect(toAssetIdentityRef({ code: 'XLM' })).toEqual({ code: 'XLM' });
  });

  it('never conflates two distinct issuers sharing the same asset code', () => {
    const otherIssuer = 'GB6LBXYGVNTCBD4LYQMGZ3WR3CFX2X3WS5PK2XJEHW6R6FMHEB4XJFEX';
    const refA = toAssetIdentityRef({ code: 'USDC', issuer });
    const refB = toAssetIdentityRef({ code: 'USDC', issuer: otherIssuer });
    expect(refA).not.toEqual(refB);
  });

  it('shortens a long issuer address for display without losing the ends', () => {
    expect(formatIssuerPreview(issuer)).toBe(`${issuer.slice(0, 6)}…${issuer.slice(-4)}`);
    expect(formatIssuerPreview(issuer)).not.toBe(issuer);
    expect(formatIssuerPreview('GSHORT')).toBe('GSHORT');
  });
});
