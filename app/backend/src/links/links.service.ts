import { Injectable, Logger, Optional } from '@nestjs/common';
import { LinkConstraints, AssetCode, MemoType } from './constants';
import { LinkMetadataRequestDto, LinkMetadataResponseDto } from '../dto';
import { LinkValidationError, LinkErrorCode } from './errors';
import {
  PathPreviewService,
  type PathPreviewRow,
} from '../stellar/path-preview.service';
import { PrivacyService } from '../privacy/privacy.service';

/**
 * Canonical asset identity.
 *
 * Asset codes alone are ambiguous: two assets may share the same code but be
 * issued by different accounts. Persistence and validation therefore key on the
 * full identity tuple (network, asset type, code, issuer). The native asset is
 * always represented as `{ network, type: 'native', code: 'XLM', issuer: null }`.
 */
export interface AssetIdentity {
  network: string;
  type: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
  code: string;
  issuer: string | null;
}

export const DEFAULT_ASSET_NETWORK = 'public';

@Injectable()
export class LinksService {
  private readonly logger = new Logger(LinksService.name);

  constructor(
    @Optional() private readonly pathPreviewService?: PathPreviewService,
    @Optional() private readonly privacyService?: PrivacyService,
  ) {}

  /**
   * Reconcile an observed receipt status against the canonical status at the
   * service boundary. Out-of-order observations cannot regress canonical state;
   * conflicts are surfaced as a typed result and logged without personal data.
   */
  reconcileReceiptStatus(
    current: ReceiptStatus,
    observed: ReceiptStatus,
    referenceId?: string | null,
  ): ReceiptTransitionResult {
    const result = reconcileReceiptStatus(current, observed);

    if (result.conflict) {
      this.logger.warn(
        `Receipt status conflict: observed '${result.observedStatus}' would regress canonical '${result.previousStatus}'` +
          (referenceId ? ` (ref: ${this.maskReferenceId(referenceId)})` : ''),
      );
    }

    return result;
  }

  /**
   * Apply an observed receipt status, throwing a typed error on conflict.
   * Duplicate observations are idempotent and return the canonical status.
   */
  applyReceiptStatus(
    current: ReceiptStatus,
    observed: ReceiptStatus,
    referenceId?: string | null,
  ): ReceiptStatus {
    const result = this.reconcileReceiptStatus(current, observed, referenceId);

    if (result.conflict) {
      throw new ReceiptTransitionConflictError(
        result.previousStatus,
        result.observedStatus,
      );
    }

    return result.status;
  }

  private maskReferenceId(referenceId: string): string {
    const trimmed = referenceId.trim();
    if (trimmed.length <= 4) {
      return '****';
    }
    return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
  }

  async generateMetadata(request: LinkMetadataRequestDto): Promise<LinkMetadataResponseDto> {
    const amt = this.validateAmount(request.amount);

    const { memo, memoType } = this.validateMemo(request.memo, request.memoType);

    const asset = this.validateAsset(request.asset);
    const privacy = request.privacy ?? false;
    const expiresAt = this.calculateExpiration(request.expirationDays);

    // Validate new optional fields (handles undefined/null gracefully)
    const username = this.validateUsername(request.username);
    const destination = this.validateDestination(request.destination);
    const referenceId = this.validateReferenceId(request.referenceId);

    // Normalize asset symbol to canonical form
    const normalizedAsset = this.normalizeAssetSymbol(asset);

    // Validate and normalise acceptedAssets
    const acceptedAssets = this.validateAcceptedAssets(
      request.acceptedAssets,
      asset,
    );

    const canonical = this.generateCanonicalFormat(
      amt,
      normalizedAsset,
      memo,
      username,
      destination,
      referenceId,
      acceptedAssets,
    );

    const warnings: string[] = [];
    let normalized = false;

    if (request.amount.toString() !== amt) {
      warnings.push('Amount was normalized to 7 decimal places');
      normalized = true;
    }

    if (memo && request.memo !== memo) {
      warnings.push('Memo was trimmed and sanitized');
      normalized = true;
    }

    if (normalizedAsset !== (request.asset ?? LinkConstraints.ASSET.DEFAULT)) {
      warnings.push(
        `Asset symbol '${request.asset ?? LinkConstraints.ASSET.DEFAULT}' normalized to '${normalizedAsset}'`,
      );
      normalized = true;
    }

    // Additional metadata fields for frontend
    const additionalMetadata = this.deriveAdditionalMetadata(request, asset);
    const stealthRecipientEnvelope =
      request.privacy &&
      request.recipientViewPublicKeyPem &&
      destination &&
      this.privacyService
        ? this.privacyService.encryptRecipientForViewKey(
            destination,
            request.recipientViewPublicKeyPem,
          )
        : undefined;

    // Compute swap options for accepted assets that differ from the destination asset
    let swapOptions: PathPreviewRow[] | null = null;
    if (acceptedAssets) {
      swapOptions = await this.buildSwapOptions(amt, normalizedAsset, acceptedAssets);
    }

    return {
      amount: amt,
      memo,
      memoType,
      asset: normalizedAsset,
      privacy,
      expiresAt,
      canonical,
      username,
      destination,
      referenceId,
      acceptedAssets: acceptedAssets
        ? acceptedAssets.map((a) => this.serializeAssetIdentity(a))
        : null,
      swapOptions,
      metadata: {
        normalized,
        warnings: warnings.length > 0 ? warnings : undefined,
        stealthRecipientEnvelope,
        assetIdentity: this.serializeAssetIdentity(asset),
        ...additionalMetadata,
      },
    };
  }

  /**
   * Serialize an identity to the canonical `NETWORK:CODE:ISSUER` form used in
   * persistence and the canonical link format. Native assets omit the issuer.
   */
  private serializeAssetIdentity(identity: AssetIdentity): string {
    if (identity.type === 'native') {
      return identity.code;
    }
    return `${identity.network}:${identity.code}:${identity.issuer ?? ''}`;
  }

  private validateAmount(amount: number): string {
    if (typeof amount !== 'number' || isNaN(amount)) {
      throw new LinkValidationError(
        LinkErrorCode.INVALID_AMOUNT,
        'Amount must be a valid number',
        'amount',
      );
    }

    if (amount < LinkConstraints.AMOUNT.MIN) {
      throw new LinkValidationError(
        LinkErrorCode.AMOUNT_TOO_LOW,
        `Amount must be at least ${LinkConstraints.AMOUNT.MIN} XLM`,
        'amount',
      );
    }

    if (amount > LinkConstraints.AMOUNT.MAX) {
      throw new LinkValidationError(
        LinkErrorCode.AMOUNT_TOO_HIGH,
        `Amount cannot exceed ${LinkConstraints.AMOUNT.MAX} XLM`,
        'amount',
      );
    }

    return this.formatAmount(amount);
  }

  private formatAmount(amount: number): string {
    return amount.toFixed(LinkConstraints.AMOUNT.DECIMALS);
  }

  private validateMemo(
    memo?: string,
    memoType?: string,
  ): { memo: string | null; memoType: MemoType } {
    if (!memo || memo.trim() === '') {
      return {
        memo: null,
        memoType: LinkConstraints.MEMO.DEFAULT_TYPE,
      };
    }

    let sanitized = memo.trim();
    sanitized = sanitized.replace(/[<>"']/g, '');

    if (sanitized.length === 0) {
      return {
        memo: null,
        memoType: LinkConstraints.MEMO.DEFAULT_TYPE,
      };
    }

    if (sanitized.length > LinkConstraints.MEMO.MAX_LENGTH) {
      throw new LinkValidationError(
        LinkErrorCode.MEMO_TOO_LONG,
        `Memo cannot exceed ${LinkConstraints.MEMO.MAX_LENGTH} characters`,
        'memo',
      );
    }

    const validatedMemoType = (memoType || LinkConstraints.MEMO.DEFAULT_TYPE) as MemoType;
    if (!LinkConstraints.MEMO.ALLOWED_TYPES.includes(validatedMemoType)) {
      throw new LinkValidationError(
        LinkErrorCode.INVALID_MEMO_TYPE,
        'Memo type must be one of: text, id, hash, return',
        'memoType',
      );
    }

    return {
      memo: sanitized,
      memoType: validatedMemoType,
    };
  }

  private validateUsername(username?: string | null): string | null {
    if (!username || username.trim() === '') {
      return null;
    }

    const trimmed = username.trim().toLowerCase();

    if (trimmed.length < 3) {
      throw new LinkValidationError(
        LinkErrorCode.INVALID_USERNAME,
        'Username must be at least 3 characters long',
        'username',
      );
    }

    if (trimmed.length > 32) {
      throw new LinkValidationError(
        LinkErrorCode.INVALID_USERNAME,
        'Username cannot exceed 32 characters',
        'username',
      );
    }

    if (!/^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$|^[a-z0-9]{1,2}$/.test(trimmed)) {
      throw new LinkValidationError(
        LinkErrorCode.INVALID_USERNAME,
        'Username must be lowercase alphanumeric characters, may include hyphens and underscores, but cannot start or end with special characters',
        'username',
      );
    }

    const reservedWords = ['admin', 'system', 'root', 'quickex', 'null', 'undefined'];
    if (reservedWords.includes(trimmed)) {
      throw new LinkValidationError(
        LinkErrorCode.USERNAME_RESERVED,
        'Username is reserved and cannot be used',
        'username',
      );
    }

    return trimmed;
  }

  private validateDestination(destination?: string | null): string | null {
    if (!destination || destination.trim() === '') {
      return null;
    }

    const trimmed = destination.trim();

    if (!/^G[ABCDEFGHIJKLMNOPQRSTUVWXYZ234567]{55}$/.test(trimmed)) {
      throw new LinkValidationError(
        LinkErrorCode.INVALID_DESTINATION,
        'Destination must be a valid Stellar public key (starts with G, 56 characters)',
        'destination',
      );
    }

    return trimmed;
  }

  private validateReferenceId(referenceId?: string | null): string | null {
    if (!referenceId || referenceId.trim() === '') {
      return null;
    }

    const trimmed = referenceId.trim();

    if (trimmed.length > 64) {
      throw new LinkValidationError(
        LinkErrorCode.INVALID_REFERENCE_ID,
        'Reference ID cannot exceed 64 characters',
        'referenceId',
      );
    }

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) {
      throw new LinkValidationError(
        LinkErrorCode.INVALID_REFERENCE_ID,
        'Reference ID must be 1-64 alphanumeric characters, hyphens, or underscores',
        'referenceId',
      );
    }

    return trimmed;
  }

  private calculateExpiration(days?: number): Date | null {
    if (!days) return null;

    if (days < 1 || days > LinkConstraints.LINK.MAX_EXPIRATION_DAYS) {
      throw new LinkValidationError(
        LinkErrorCode.INVALID_EXPIRATION,
        'Expiration must be between 1 and 365 days',
        'expirationDays',
      );
    }

    const expiration = new Date();
    expiration.setDate(expiration.getDate() + days);
    return expiration;
  }

  /**
   * Parse an asset string into its canonical identity.
   *
   * Accepted forms:
   * - `XLM` / `native` -> native asset (issuer null)
   * - `CODE` -> whitelisted asset resolved to its canonical issuer
   * - `CODE:ISSUER` -> explicit issuer, must match the canonical issuer for
   *   whitelisted codes (prevents conflating same-code assets from other issuers)
   * - `NETWORK:CODE` / `NETWORK:CODE:ISSUER` -> explicit network override
   */
  private parseAssetIdentity(
    asset: string | undefined,
    field: string = 'asset',
  ): AssetIdentity {
    const raw = (asset ?? LinkConstraints.ASSET.DEFAULT).trim();
    if (raw === '') {
      throw new LinkValidationError(
        LinkErrorCode.ASSET_NOT_WHITELISTED,
        `Asset is not supported. Supported assets: ${LinkConstraints.ASSET.WHITELIST.join(', ')}`,
        field,
      );
    }

    const parts = raw.split(':').map((p) => p.trim());
    let network = DEFAULT_ASSET_NETWORK;
    let code: string;
    let issuer: string | null = null;

    if (parts.length === 1) {
      code = parts[0];
    } else if (parts.length === 2) {
      // Either NETWORK:CODE or CODE:ISSUER
      if (this.isKnownNetwork(parts[0])) {
        network = parts[0];
        code = parts[1];
      } else {
        code = parts[0];
        issuer = parts[1];
      }
    } else if (parts.length === 3) {
      network = parts[0];
      code = parts[1];
      issuer = parts[2];
    } else {
      throw new LinkValidationError(
        LinkErrorCode.ASSET_NOT_WHITELISTED,
        `Invalid asset identifier '${raw}'`,
        field,
      );
    }

    if (code.toUpperCase() === 'XLM' || code.toLowerCase() === 'native') {
      if (issuer) {
        throw new LinkValidationError(
          LinkErrorCode.ASSET_NOT_WHITELISTED,
          'Native asset XLM cannot have an issuer',
          field,
        );
      }
      return { network, type: 'native', code: 'XLM', issuer: null };
    }

    if (!LinkConstraints.ASSET.WHITELIST.includes(code as AssetCode)) {
      throw new LinkValidationError(
        LinkErrorCode.ASSET_NOT_WHITELISTED,
        `Asset is not supported. Supported assets: ${LinkConstraints.ASSET.WHITELIST.join(', ')}`,
        field,
      );
    }

    const canonicalIssuer = this.getAssetIssuer(code);
    if (issuer && canonicalIssuer && issuer !== canonicalIssuer) {
      throw new LinkValidationError(
        LinkErrorCode.ASSET_NOT_WHITELISTED,
        `Asset '${code}' is not supported for issuer '${issuer}'`,
        field,
      );
    }

    return {
      network,
      type: code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
      code,
      issuer: issuer ?? canonicalIssuer,
    };
  }

  private isKnownNetwork(value: string): boolean {
    return ['public', 'testnet', 'futurenet'].includes(value.toLowerCase());
  }

  private assetIdentityKey(identity: AssetIdentity): string {
    return [
      identity.network,
      identity.type,
      identity.code,
      identity.issuer ?? '',
    ].join(':');
  }

  private validateAsset(asset?: string): AssetIdentity {
    return this.parseAssetIdentity(asset, 'asset');
  }

  private normalizeAssetSymbol(asset: AssetIdentity): string {
    return asset.code;
  }

  private validateAcceptedAssets(
    assets: string[] | undefined,
    destinationAsset: AssetIdentity,
  ): AssetIdentity[] | null {
    if (!assets || assets.length === 0) {
      return null;
    }

    const identities = assets.map((a) =>
      this.parseAssetIdentity(a, 'acceptedAssets'),
    );

    // Ensure the destination asset is always included, deduplicating on the
    // full identity so same-code assets from different issuers stay distinct.
    const byKey = new Map<string, AssetIdentity>();
    for (const identity of [...identities, destinationAsset]) {
      byKey.set(this.assetIdentityKey(identity), identity);
    }
    return Array.from(byKey.values());
  }

  private async buildSwapOptions(
    destinationAmount: string,
    destinationAsset: AssetIdentity,
    acceptedAssets: AssetIdentity[],
  ): Promise<PathPreviewRow[]> {
    if (!this.pathPreviewService) {
      return [];
    }

    const destinationKey = this.assetIdentityKey(destinationAsset);
    const swapSourceAssets = acceptedAssets
      .filter((a) => this.assetIdentityKey(a) !== destinationKey)
      .map((a) => ({ code: a.code, issuer: a.issuer ?? undefined }));

    if (swapSourceAssets.length === 0) {
      return [];
    }

    try {
      const result = await this.pathPreviewService.previewPaths({
        destinationAmount,
        destinationAsset: {
          code: destinationAsset.code,
          issuer: destinationAsset.issuer ?? undefined,
        },
        sourceAssets: swapSourceAssets,
      });
      return result.paths;
    } catch (err) {
      this.logger.warn(
        'Swap path preview failed; returning empty swap options',
        err,
      );
      return [];
    }
  }

  private generateCanonicalFormat(
    amount: string,
    asset: string,
    memo: string | null,
    username?: string | null,
    destination?: string | null,
    referenceId?: string | null,
    acceptedAssets?: AssetIdentity[] | null,
  ): string {
    const params = new URLSearchParams();
    params.set('amount', amount);
    params.set('asset', asset);

    if (memo) params.set('memo', memo);
    if (username) params.set('username', username);
    if (destination) params.set('destination', destination);
    if (referenceId) params.set('ref', referenceId);
    if (acceptedAssets && acceptedAssets.length > 0) {
      params.set(
        'acceptedAssets',
        acceptedAssets.map((a) => this.serializeAssetIdentity(a)).join(','),
      );
    }

    return params.toString();
  }

  private deriveAdditionalMetadata(request: LinkMetadataRequestDto, asset: AssetIdentity): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};

    // Asset type and issuer, derived from the canonical identity
    metadata.assetType = asset.type;
    metadata.assetIssuer = asset.issuer;
    metadata.assetNetwork = asset.network;

    // Link type classification
    if (request.privacy) {
      metadata.linkType = 'private';
    } else if (request.username) {
      metadata.linkType = 'username';
    } else {
      metadata.linkType = 'standard';
    }

    // Expiration metadata
    if (request.expirationDays) {
      metadata.expiresInDays = request.expirationDays;
      metadata.isExpiring = true;
    } else {
      metadata.isExpiring = false;
    }

    // Security level
    metadata.securityLevel = this.calculateSecurityLevel(request);

    // Currency display info
    metadata.currencySymbol = this.getCurrencySymbol(asset.code);
    metadata.trustScore = this.getTrustScore(asset.code);

    return metadata;
  }

  private getAssetIssuer(asset: string): string | null {
    const issuers: Record<string, string> = {
      USDC: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      AQUA: 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA',
      yXLM: 'GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55',
    };

    return issuers[asset] || null;
  }

  private getCurrencySymbol(asset: string): string {
    const symbols: Record<string, string> = {
      XLM: '₳',
      USDC: '$',
      AQUA: 'A',
      yXLM: 'y',
    };

    return symbols[asset] || asset;
  }

  private getTrustScore(asset: string): number {
    const scores: Record<string, number> = {
      XLM: 100,
      USDC: 95,
      AQUA: 85,
      yXLM: 80,
    };

    return scores[asset] || 50;
  }

  private calculateSecurityLevel(request: LinkMetadataRequestDto): 'low' | 'medium' | 'high' {
    let score = 0;

    if (request.memo) score += 1;
    if (request.expirationDays) score += 1;
    if (request.privacy) score += 1;
    if (request.destination) score += 1;

    if (score >= 3) return 'high';
    if (score >= 1) return 'medium';
    return 'low';
  }
}