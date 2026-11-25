export type LinkDraft = {
  id: string;
  amount: string;
  asset: string;
  destination: string;
  memo: string;
  createdAt: string;
};

export type VerifiedAssetLike = {
  code: string;
  verified?: boolean;
};

export const MAX_MEMO_LENGTH = 28;
export const MAX_STELLAR_DECIMALS = 7;
export const MAX_STELLAR_AMOUNT = 922337203685.4775807;
export const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;
export const ASSET_CODE_REGEX = /^[A-Z0-9]{1,12}$/;
export const DRAFT_LINKS_STORAGE_KEY = 'quickex:draft-links';

/**
 * Validate an amount input against Stellar payment limits and precision.
 * Stellar amounts must be positive, finite, at most 7 decimal places,
 * and not exceed the max 64-bit signed int in stroops (922337203685.4775807).
 */
export function validateAmountInput(value: string): {
  valid: boolean;
  message?: string;
} {
  const trimmed = value.trim();

  if (!trimmed) {
    return { valid: false, message: 'Amount must be greater than 0.' };
  }

  const amount = Number(trimmed);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      valid: false,
      message:
        trimmed === '0' || Number(trimmed) === 0
          ? 'Amount must be greater than 0.'
          : 'Enter a valid number.',
    };
  }

  const parts = trimmed.split('.');
  if (parts.length > 2) {
    return { valid: false, message: 'Enter a valid number.' };
  }
  if (parts[1] && parts[1].length > MAX_STELLAR_DECIMALS) {
    return {
      valid: false,
      message: `Amount exceeds maximum precision of ${MAX_STELLAR_DECIMALS} decimal places.`,
    };
  }

  if (amount > MAX_STELLAR_AMOUNT) {
    return {
      valid: false,
      message: 'Amount exceeds maximum allowable Stellar payment limit.',
    };
  }

  return { valid: true };
}

/**
 * Validates a Stellar memo string according to protocol limits (MEMO_TEXT <= 28 bytes).
 * Counts UTF-8 encoded bytes to ensure multi-byte characters do not overflow on-chain.
 */
export function validateMemoInput(memo: string): {
  valid: boolean;
  message?: string;
  byteLength: number;
} {
  if (!memo) {
    return { valid: true, byteLength: 0 };
  }

  const byteLength = new TextEncoder().encode(memo).length;
  if (byteLength > MAX_MEMO_LENGTH) {
    return {
      valid: false,
      byteLength,
      message: `Memo exceeds maximum limit of ${MAX_MEMO_LENGTH} bytes (current: ${byteLength} bytes).`,
    };
  }

  return { valid: true, byteLength };
}

/**
 * Validates a Stellar asset code (1-12 alphanumeric characters, or native XLM).
 */
export function validateAssetCode(asset: string): {
  valid: boolean;
  message?: string;
  normalized?: string;
} {
  const trimmed = asset.trim().toUpperCase();
  if (!trimmed) {
    return { valid: false, message: 'Asset code is required.' };
  }

  if (!ASSET_CODE_REGEX.test(trimmed)) {
    return {
      valid: false,
      message: 'Asset code must be 1-12 uppercase alphanumeric characters.',
    };
  }

  return { valid: true, normalized: trimmed };
}

export interface PaymentLinkPreviewParams {
  amount: string;
  asset: string;
  memo?: string;
  destination?: string;
  username?: string;
}

export interface PaymentLinkPreviewValidationResult {
  valid: boolean;
  errors: Record<string, string>;
  warnings: string[];
}

/**
 * Comprehensive payment-link preview validator for assets, amounts, memo limits, and recipient.
 * Ensures the preview payload is valid and adheres to all self-custody and protocol constraints.
 */
export function validatePaymentLinkPreview(
  params: PaymentLinkPreviewParams,
): PaymentLinkPreviewValidationResult {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];

  // 1. Validate Amount
  const amountValidation = validateAmountInput(params.amount);
  if (!amountValidation.valid && amountValidation.message) {
    errors.amount = amountValidation.message;
  }

  // 2. Validate Asset
  const assetValidation = validateAssetCode(params.asset);
  if (!assetValidation.valid && assetValidation.message) {
    errors.asset = assetValidation.message;
  }

  // 3. Validate Memo Limits
  if (params.memo) {
    const memoValidation = validateMemoInput(params.memo);
    if (!memoValidation.valid && memoValidation.message) {
      errors.memo = memoValidation.message;
    }
  }

  // 4. Validate Recipient (username or destination)
  const trimmedDest = params.destination?.trim() ?? '';
  const trimmedUser = params.username?.trim() ?? '';

  if (!trimmedDest && !trimmedUser) {
    errors.recipient = 'Recipient username or Stellar destination address is required.';
  } else if (trimmedDest && !STELLAR_ADDRESS_REGEX.test(trimmedDest)) {
    errors.destination = 'Destination must be a valid Stellar public key (56 characters starting with G).';
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    warnings,
  };
}

export function getVerifiedAssetOptions<T extends VerifiedAssetLike>(assets: T[]): T[] {
  const verified = assets.filter((asset) => asset.verified !== false);
  if (verified.length > 0) {
    return verified;
  }
  return assets;
}

export type AssetIdentity = {
  code: string;
  issuer?: string | null;
  type?: string;
  verified?: boolean;
};

/**
 * Native XLM has no issuer and is never flagged unverified; a custom asset is
 * unverified only when the backend's verified-asset registry explicitly says so.
 */
export function isCustomAssetUnverified(asset: AssetIdentity): boolean {
  return asset.type !== 'native' && asset.verified === false;
}

/**
 * The full asset identity (code + issuer) a selection should resolve to, so two
 * issuers sharing a code are never conflated. Native assets have no issuer.
 */
export function toAssetIdentityRef(asset: AssetIdentity): { code: string; issuer?: string } {
  return asset.issuer ? { code: asset.code, issuer: asset.issuer } : { code: asset.code };
}

export function formatIssuerPreview(issuer: string): string {
  if (issuer.length <= 10) {
    return issuer;
  }
  return `${issuer.slice(0, 6)}…${issuer.slice(-4)}`;
}

export function readDraftLinks(storage: Storage): LinkDraft[] {
  try {
    const raw = storage.getItem(DRAFT_LINKS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as LinkDraft[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveDraftLink(draft: LinkDraft, storage: Storage): LinkDraft[] {
  const updates = [draft, ...readDraftLinks(storage)];
  const deduped = updates.filter(
    (item, index, arr) => arr.findIndex((candidate) => candidate.id === item.id) === index,
  );
  storage.setItem(DRAFT_LINKS_STORAGE_KEY, JSON.stringify(deduped.slice(0, 10)));
  return deduped.slice(0, 10);
}

/**
 * In-progress link-generator form draft: amount/asset/memo/display options only.
 * Never include a secret key or signed XDR here — this is persisted to localStorage.
 */
export type GeneratorFormDraft = {
  version: number;
  amount: string;
  asset: string;
  memo: string;
  displayOptions: {
    advancedOpen: boolean;
    slippagePct: string;
  };
  savedAt: string;
};

export const FORM_DRAFT_STORAGE_KEY = 'quickex:generator-form-draft';
export const FORM_DRAFT_VERSION = 1;

export function isFormDraftWorthSaving(
  draft: Pick<GeneratorFormDraft, 'amount' | 'memo'>,
): boolean {
  return Boolean(draft.amount.trim() || draft.memo.trim());
}

export function saveFormDraft(
  draft: Pick<GeneratorFormDraft, 'amount' | 'asset' | 'memo' | 'displayOptions'>,
  storage: Storage,
): void {
  const payload: GeneratorFormDraft = {
    ...draft,
    version: FORM_DRAFT_VERSION,
    savedAt: new Date().toISOString(),
  };
  storage.setItem(FORM_DRAFT_STORAGE_KEY, JSON.stringify(payload));
}

export function readFormDraft(storage: Storage): GeneratorFormDraft | null {
  try {
    const raw = storage.getItem(FORM_DRAFT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<GeneratorFormDraft> | null;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (parsed.version !== FORM_DRAFT_VERSION) {
      return null;
    }
    if (
      typeof parsed.amount !== 'string' ||
      typeof parsed.asset !== 'string' ||
      typeof parsed.memo !== 'string' ||
      !parsed.displayOptions ||
      typeof parsed.displayOptions.advancedOpen !== 'boolean' ||
      typeof parsed.displayOptions.slippagePct !== 'string'
    ) {
      return null;
    }
    return parsed as GeneratorFormDraft;
  } catch {
    return null;
  }
}

export function clearFormDraft(storage: Storage): void {
  storage.removeItem(FORM_DRAFT_STORAGE_KEY);
}
