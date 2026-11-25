import { Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { LinkState } from "../links/link-state-machine";
import { PaymentLinkStatusDto } from "../dto/link/payment-link-status.dto";
import { HorizonService } from "../transactions/horizon.service";
import { SupabaseService } from "../supabase/supabase.service";
import { LinksService } from "../links/links.service";
import { PathPreviewService } from "../stellar/path-preview.service";

import { LinkMetadataResponseDto } from "../dto/link/link-metadata-response.dto";

/**
 * Canonical asset identity used for payment-link validation and persistence.
 *
 * Asset codes alone are not unique on Stellar: two assets may share the same
 * code while being issued by different issuers. The canonical identity is
 * therefore composed of the network, asset type, code and issuer. The native
 * asset is represented canonically as `{ type: "native" }` with no code or
 * issuer, so it can never collide with an issued asset.
 */
export interface CanonicalAssetIdentity {
  network: string;
  type: "native" | "credit_alphanum4" | "credit_alphanum12";
  code: string | null;
  issuer: string | null;
}

const NATIVE_ASSET_CODE = "XLM";
const DEFAULT_NETWORK = "public";

/**
 * Build a canonical asset identity from a loosely-typed asset descriptor.
 *
 * Accepts either a plain code string (legacy callers) or an object carrying
 * `code`/`issuer`/`type`/`network` fields. Native assets (XLM or an explicit
 * `native` type) are always normalized to the canonical native representation.
 */
export function toCanonicalAssetIdentity(
  asset: unknown,
  network: string = DEFAULT_NETWORK,
): CanonicalAssetIdentity {
  const normalizedNetwork = (network || DEFAULT_NETWORK).toLowerCase();

  if (asset === null || asset === undefined) {
    return {
      network: normalizedNetwork,
      type: "native",
      code: null,
      issuer: null,
    };
  }

  if (typeof asset === "string") {
    const trimmed = asset.trim();
    if (!trimmed || trimmed.toUpperCase() === NATIVE_ASSET_CODE) {
      return {
        network: normalizedNetwork,
        type: "native",
        code: null,
        issuer: null,
      };
    }

    // A bare code without an issuer cannot be resolved to a unique asset.
    // Treat it as an alphanumeric asset with an unknown issuer so that it
    // never matches an issued asset that carries a real issuer.
    return {
      network: normalizedNetwork,
      type: trimmed.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
      code: trimmed,
      issuer: null,
    };
  }

  if (typeof asset === "object") {
    const record = asset as Record<string, unknown>;
    const rawType =
      typeof record.type === "string" ? record.type.toLowerCase() : undefined;
    const rawCode =
      typeof record.code === "string" ? record.code.trim() : undefined;
    const rawIssuer =
      typeof record.issuer === "string" ? record.issuer.trim() : undefined;
    const assetNetwork =
      typeof record.network === "string" ? record.network : normalizedNetwork;

    if (
      rawType === "native" ||
      (!rawIssuer && (!rawCode || rawCode.toUpperCase() === NATIVE_ASSET_CODE))
    ) {
      return {
        network: assetNetwork.toLowerCase(),
        type: "native",
        code: null,
        issuer: null,
      };
    }

    const code = rawCode ?? "";
    return {
      network: assetNetwork.toLowerCase(),
      type:
        rawType === "credit_alphanum4" || rawType === "credit_alphanum12"
          ? rawType
          : code.length <= 4
            ? "credit_alphanum4"
            : "credit_alphanum12",
      code,
      issuer: rawIssuer ?? null,
    };
  }

  return {
    network: normalizedNetwork,
    type: "native",
    code: null,
    issuer: null,
  };
}

/**
 * Compare two asset descriptors by canonical identity.
 *
 * Duplicate codes from distinct issuers compare as different assets, while
 * native assets compare equal regardless of how they were expressed
 * (e.g. "XLM", "native", `{ type: "native" }`).
 */
export function isSameAssetIdentity(
  a: unknown,
  b: unknown,
  network: string = DEFAULT_NETWORK,
): boolean {
  const left = toCanonicalAssetIdentity(a, network);
  const right = toCanonicalAssetIdentity(b, network);

  return (
    left.network === right.network &&
    left.type === right.type &&
    left.code === right.code &&
    left.issuer === right.issuer
  );
}

/**
 * Stable string key for persisting/looking up an asset identity.
 */
export function canonicalAssetKey(
  asset: unknown,
  network: string = DEFAULT_NETWORK,
): string {
  const identity = toCanonicalAssetIdentity(asset, network);
  return [
    identity.network,
    identity.type,
    identity.code ?? "",
    identity.issuer ?? "",
  ].join(":");
}

@Injectable()
export class PaymentLinkService {
  private readonly logger = new Logger(PaymentLinkService.name);
  private readonly DEFAULT_EXPIRY_DAYS = 30;

  constructor(
    private readonly horizonService: HorizonService,
    private readonly supabaseService: SupabaseService,
    private readonly linksService: LinksService,
    @Optional() private readonly pathPreviewService?: PathPreviewService,
  ) {}

  /**
   * Get the current state of a payment link
   * Payment links are stateless URLs, so we determine state by:
   * 1. Checking if the username exists
   * 2. Checking if a matching payment has been made
   * 3. Checking if the link has expired
   */
  async getPaymentLinkStatus(params: {
    username: string;
    amount: number;
    asset?: string;
    memo?: string;
    acceptedAssets?: string[];
    network?: string;
  }): Promise<PaymentLinkStatusDto> {
    const {
      username,
      amount,
      asset = "XLM",
      memo,
      acceptedAssets,
      network = DEFAULT_NETWORK,
    } = params;

    // Normalize the requested asset to its canonical identity before any
    // validation or persistence so code-only collisions cannot occur.
    const requestedAssetIdentity = toCanonicalAssetIdentity(asset, network);
    const canonicalAsset = this.serializeAssetIdentity(requestedAssetIdentity);

    // 1. Get username record to find destination public key
    const usernameRecord = await this.getUsernameRecord(username);
    const destinationPublicKey = usernameRecord.public_key;

    // 2. Generate metadata to get canonical format and swap options
    const metadata = await this.linksService.generateMetadata({
      amount,
      asset: canonicalAsset,
      username,
      memo,
      acceptedAssets,
      expirationDays: this.DEFAULT_EXPIRY_DAYS,
    });

    // 3. Check if payment has been made using canonical asset identity
    const paymentInfo = await this.checkIfPaymentMade(
      destinationPublicKey,
      metadata.amount,
      metadata.asset,
      metadata.memo,
      network,
    );

    // 4. Determine link state
    const state = this.determineLinkState(metadata, paymentInfo);

    // 5. Build swap options if acceptedAssets provided
    const swapOptions = metadata.swapOptions || null;

    // 6. Build user-friendly message and available actions
    const { userMessage, availableActions } = this.buildUserContext(state);

    return {
      state,
      username: metadata.username || username,
      amount: metadata.amount,
      asset: metadata.asset,
      memo: metadata.memo,
      destinationPublicKey,
      expiresAt: metadata.expiresAt,
      transactionHash: paymentInfo?.transactionHash || null,
      paidAt: paymentInfo?.paidAt || null,
      swapOptions,
      acceptsMultipleAssets: !!acceptedAssets && acceptedAssets.length > 0,
      acceptedAssets: metadata.acceptedAssets || null,
      userMessage,
      availableActions,
    };
  }

  /**
   * Get username record from database
   */
  private async getUsernameRecord(
    username: string,
  ): Promise<{ public_key: string }> {
    const { data, error } = await this.supabaseService
      .getClient()
      .from("usernames")
      .select("public_key")
      .eq("username", username.toLowerCase())
      .single();

    if (error || !data) {
      throw new NotFoundException(`Username '${username}' not found`);
    }

    return data;
  }

  /**
   * Check if a matching payment has been made on-chain
   * Looks for recent payments to the destination with matching amount and memo
   */
  private async checkIfPaymentMade(
    destinationPublicKey: string,
    amount: string,
    asset: string,
    memo: string | null,
    network: string = DEFAULT_NETWORK,
  ): Promise<{ transactionHash: string; paidAt: Date } | null> {
    try {
      // Get recent payments to this account
      const payments = await this.horizonService.getPayments(
        destinationPublicKey,
        undefined,
        50, // Check last 50 payments
      );

      // Find a matching payment
      const matchingPayment = payments.items.find((payment) => {
        // Check amount (allow small floating point differences)
        const paymentAmount = parseFloat(payment.amount);
        const expectedAmount = parseFloat(amount);
        const amountMatches =
          Math.abs(paymentAmount - expectedAmount) < 0.0000001;

        // Check asset by canonical identity (network + type + code + issuer)
        // so that duplicate codes from distinct issuers stay distinct and
        // native assets match regardless of representation.
        const assetMatches = isSameAssetIdentity(
          this.extractPaymentAsset(payment),
          asset,
          network,
        );

        // Check memo if provided
        const memoMatches = !memo || payment.memo === memo;

        return amountMatches && assetMatches && memoMatches;
      });

      if (matchingPayment) {
        return {
          transactionHash: matchingPayment.txHash,
          paidAt: new Date(matchingPayment.timestamp),
        };
      }

      return null;
    } catch (error) {
      this.logger.error(`Failed to check payment status: ${error}`);
      // If we can't check Horizon, assume payment not made
      return null;
    }
  }

  /**
   * Extract a canonicalizable asset descriptor from a Horizon payment record.
   */
  private extractPaymentAsset(payment: {
    asset?: string;
    assetType?: string;
    assetCode?: string;
    assetIssuer?: string;
  }): unknown {
    if (payment.assetType === "native") {
      return { type: "native" };
    }

    if (payment.assetCode || payment.assetIssuer) {
      return {
        type: payment.assetType,
        code: payment.assetCode,
        issuer: payment.assetIssuer,
      };
    }

    return payment.asset;
  }

  /**
   * Serialize a canonical asset identity into the string form persisted in
   * link metadata, keeping native assets in their canonical representation.
   */
  private serializeAssetIdentity(identity: CanonicalAssetIdentity): string {
    if (identity.type === "native") {
      return NATIVE_ASSET_CODE;
    }

    return canonicalAssetKey(identity, identity.network);
  }

  /**
   * Determine the current state of the payment link
   */
  private determineLinkState(
    metadata: LinkMetadataResponseDto,
    paymentInfo: { transactionHash: string; paidAt: Date } | null,
  ): LinkState {
    // If payment has been made, link is PAID
    if (paymentInfo) {
      return LinkState.PAID;
    }

    // Check if link has expired
    if (metadata.expiresAt && new Date(metadata.expiresAt) < new Date()) {
      return LinkState.EXPIRED;
    }

    // Otherwise, link is ACTIVE
    return LinkState.ACTIVE;
  }

  /**
   * Build user-friendly message and available actions based on state
   */
  private buildUserContext(state: LinkState): {
    userMessage: string;
    availableActions: string[];
  } {
    switch (state) {
      case LinkState.ACTIVE:
        return {
          userMessage:
            "This payment link is active and ready to receive payment",
          availableActions: ["pay", "share"],
        };

      case LinkState.EXPIRED:
        return {
          userMessage:
            "This payment link has expired. Please request a new payment link.",
          availableActions: [],
        };

      case LinkState.PAID:
        return {
          userMessage: "Payment completed successfully!",
          availableActions: ["view_transaction"],
        };

      case LinkState.REFUNDED:
        return {
          userMessage: "This payment has been refunded.",
          availableActions: [],
        };

      default:
        return {
          userMessage: "Unknown payment link state",
          availableActions: [],
        };
    }
  }
}
