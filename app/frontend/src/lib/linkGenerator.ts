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
export const DRAFT_LINKS_STORAGE_KEY = 'quickex:draft-links';

export function validateAmountInput(value: string): {
  valid: true;
  normalized?: string;
} | {
  valid: false;
  message: string;
} {
  const trimmed = value.trim();

  if (!trimmed) {
    return { valid: false, message: 'Amount must be greater than 0.' };
  }

  const amount = Number(trimmed);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      valid: false,
      message: trimmed === '0' || Number(trimmed) === 0 ? 'Amount must be greater than 0.' : 'Enter a valid number.',
    };
  }

  return { valid: true, normalized: String(amount) };
}

export function getVerifiedAssetOptions<T extends VerifiedAssetLike>(assets: T[]): T[] {
  const verified = assets.filter((asset) => asset.verified !== false);
  if (verified.length > 0) {
    return verified;
  }
  return assets;
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
