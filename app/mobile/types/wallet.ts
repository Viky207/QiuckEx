export type StellarNetwork = "testnet" | "mainnet";

/** Supported wallet providers */
export type WalletType = "freighter" | "lobstr" | "xbull" | "albedo" | "demo";

/** Edge-case errors that can occur during wallet operations */
export type WalletErrorCode =
  | "wallet_locked"
  | "wrong_network"
  | "signature_rejected"
  | "connection_failed"
  | "session_expired"
  | "wallet_not_found"
  | "session_environment_mismatch"
  | "session_corrupted";

export interface WalletError {
  code: WalletErrorCode;
  message: string;
  recoverable: boolean;
}

export interface WalletState {
  connected: boolean;
  publicKey?: string;
  network: StellarNetwork;
  walletType?: WalletType;
  connectedAt?: number;
  error?: WalletError;
  isRestoring?: boolean;
}

/** Shape returned by the wallet context / useWallet hook */
export interface WalletContextValue {
  wallet: WalletState;
  connect: (walletType: WalletType, network?: StellarNetwork) => Promise<void>;
  disconnect: () => Promise<void>;
  switchAccount: (newPublicKey: string) => Promise<void>;
  switchNetwork: (network: StellarNetwork) => Promise<void>;
  clearError: () => void;
}

/**
 * Wallet operations whose support can vary between connection paths.
 *
 * - `classic_payment_signing`: signing classic Stellar transactions
 *   (e.g. payments, trustlines) via the wallet's transaction signing API.
 * - `soroban_auth_entry_signing`: signing Soroban authorization entries
 *   (`SorobanAuthorizationEntry`) for contract invocations. This is a
 *   distinct capability from classic payment signing; a wallet may support
 *   one without the other.
 * - `network_switch`: switching the active network (testnet/mainnet) from
 *   within the wallet session.
 * - `account_switch`: switching the active account/public key from within
 *   the wallet session.
 */
export type WalletCapability =
  | "classic_payment_signing"
  | "soroban_auth_entry_signing"
  | "network_switch"
  | "account_switch";

/** Support level for a single capability on a single connection path. */
export type WalletCapabilitySupport = "supported" | "unsupported" | "degraded";

/** Per-capability support detail for a wallet connection path. */
export interface WalletCapabilityEntry {
  /** Support level observed/derived from capability probes. */
  support: WalletCapabilitySupport;
  /**
   * Networks on which the capability is available. When omitted, the
   * capability is available on all supported networks.
   */
  networks?: StellarNetwork[];
  /**
   * Human-readable description of the degraded behavior when
   * `support` is `"degraded"`. Undefined for fully supported or
   * unsupported capabilities.
   */
  degradedBehavior?: string;
}

/** Capability matrix keyed by wallet type (connection path). */
export type WalletCapabilityMatrix = Record<
  WalletType,
  Record<WalletCapability, WalletCapabilityEntry>
>;

/**
 * Documented wallet capability compatibility matrix.
 *
 * Derived from runtime capability probes: each entry reflects what the
 * connection path can actually do, distinguishing classic payment signing
 * from Soroban auth-entry signing. Where a capability is only partially
 * available, the entry is marked `"degraded"` and describes the fallback.
 */
export function getWalletCapabilityMatrix(): WalletCapabilityMatrix {
  return {
    freighter: {
      classic_payment_signing: { support: "supported" },
      soroban_auth_entry_signing: { support: "supported" },
      network_switch: { support: "supported" },
      account_switch: { support: "supported" },
    },
    lobstr: {
      classic_payment_signing: { support: "supported" },
      soroban_auth_entry_signing: {
        support: "unsupported",
        degradedBehavior:
          "Soroban auth-entry signing is not available; contract invocations requiring auth entries cannot be signed.",
      },
      network_switch: {
        support: "degraded",
        degradedBehavior:
          "Network is fixed by the wallet app; switching requires reconnecting with the desired network.",
      },
      account_switch: { support: "supported" },
    },
    xbull: {
      classic_payment_signing: { support: "supported" },
      soroban_auth_entry_signing: { support: "supported" },
      network_switch: { support: "supported" },
      account_switch: {
        support: "degraded",
        degradedBehavior:
          "Account switching requires a full reconnect; the session is re-established with the new public key.",
      },
    },
    albedo: {
      classic_payment_signing: { support: "supported" },
      soroban_auth_entry_signing: {
        support: "degraded",
        degradedBehavior:
          "Auth-entry signing is supported only on testnet; mainnet contract invocations requiring auth entries are rejected.",
        networks: ["testnet"],
      },
      network_switch: { support: "supported" },
      account_switch: { support: "supported" },
    },
    demo: {
      classic_payment_signing: { support: "supported" },
      soroban_auth_entry_signing: { support: "supported" },
      network_switch: { support: "supported" },
      account_switch: { support: "supported" },
    },
  };
}