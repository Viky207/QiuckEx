import AsyncStorage from "@react-native-async-storage/async-storage";
import type { StellarNetwork, WalletType } from "../types/wallet";

export type WalletNetwork = StellarNetwork;

export interface WalletSession {
  publicKey: string;
  network: WalletNetwork;
  walletType: WalletType;
  connectedAt: number;
  /** ISO-8601 timestamp when the session was last confirmed active */
  lastConfirmedAt: string;
  /** Environment the session was created in (production/staging/testnet/branch-preview) */
  environmentId?: string;
  /** Build tag from when the session was created */
  buildTag?: string;
}

/**
 * Reason a session was deemed invalid and could not be restored.
 */
export type SessionInvalidReason =
  | "expired"
  | "environment_mismatch"
  | "corrupted"
  | "none";

const WALLET_SESSION_KEY = "quickex.wallet.session.v3";
const LAST_WALLET_TYPE_KEY = "quickex.wallet.lastType";

/**
 * Maximum age for a session to be considered restorable (7 days).
 * After this the user must re-connect explicitly.
 */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidWalletType(value: unknown): value is WalletType {
  return (
    typeof value === "string" &&
    ["freighter", "lobstr", "xbull", "albedo", "demo"].includes(value)
  );
}

function isValidNetwork(value: unknown): value is WalletNetwork {
  return value === "testnet" || value === "mainnet";
}

export function isValidStellarPublicKey(value: unknown): value is string {
  return typeof value === "string" && /^G[A-Z2-7]{55}$/.test(value);
}

// ── Session CRUD ─────────────────────────────────────────────────────────────

export async function getWalletSession(): Promise<WalletSession | null> {
  try {
    const raw = await AsyncStorage.getItem(WALLET_SESSION_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<WalletSession>;

    if (
      !parsed.publicKey ||
      !isValidStellarPublicKey(parsed.publicKey) ||
      !isValidNetwork(parsed.network) ||
      !isValidWalletType(parsed.walletType) ||
      !parsed.connectedAt
    ) {
      // Corrupted session – clear it so the user starts fresh
      await clearWalletSession();
      return null;
    }

    return {
      publicKey: parsed.publicKey,
      network: parsed.network,
      walletType: parsed.walletType,
      connectedAt: parsed.connectedAt,
      lastConfirmedAt: parsed.lastConfirmedAt ?? new Date(parsed.connectedAt).toISOString(),
      environmentId: parsed.environmentId,
      buildTag: parsed.buildTag,
    };
  } catch {
    return null;
  }
}

export async function saveWalletSession(
  session: WalletSession,
  environmentId?: string,
  buildTag?: string,
): Promise<void> {
  const enriched: WalletSession = {
    ...session,
    environmentId: environmentId ?? session.environmentId,
    buildTag: buildTag ?? session.buildTag,
  };
  await AsyncStorage.setItem(WALLET_SESSION_KEY, JSON.stringify(enriched));
  await AsyncStorage.setItem(LAST_WALLET_TYPE_KEY, session.walletType);
}

export async function clearWalletSession(): Promise<void> {
  await AsyncStorage.removeItem(WALLET_SESSION_KEY);
}

/**
 * Safely resets an invalid session and returns the reason.
 * Unlike direct clear, this preserves diagnostic information so the UI
 * can explain to the user why their session was reset.
 */
export async function resetInvalidSession(
  currentEnvironmentId?: string,
): Promise<{ reason: SessionInvalidReason; session?: WalletSession }> {
  const session = await getWalletSession();
  if (!session) return { reason: "corrupted" };

  const result = getSessionInvalidReason(session, currentEnvironmentId);
  if (!result.invalid) return { reason: "none", session };

  await clearWalletSession();
  return { reason: result.reason, session };
}

export interface SessionRestoreResult {
  restored: boolean;
  reason: SessionInvalidReason;
  session: WalletSession | null;
}

/**
 * Restores the stored wallet session, verifying public key format, max-age,
 * and environment matching. Updates lastConfirmedAt on success.
 */
export async function restoreWalletSession(
  currentEnvironmentId?: string,
): Promise<SessionRestoreResult> {
  const session = await getWalletSession();
  if (!session) {
    return { restored: false, reason: "none", session: null };
  }

  if (!isValidStellarPublicKey(session.publicKey)) {
    await clearWalletSession();
    return { restored: false, reason: "corrupted", session: null };
  }

  const check = getSessionInvalidReason(session, currentEnvironmentId);
  if (check.invalid) {
    await clearWalletSession();
    return { restored: false, reason: check.reason, session };
  }

  const now = new Date().toISOString();
  session.lastConfirmedAt = now;
  await saveWalletSession(session);
  return { restored: true, reason: "none", session };
}

/**
 * Recovers or rolls back to a previous session snapshot if a subsequent operation fails.
 */
export async function rollbackSession(
  backupSession: WalletSession | null,
): Promise<void> {
  if (backupSession) {
    await saveWalletSession(backupSession);
  } else {
    await clearWalletSession();
  }
}

// ── Session Validation ───────────────────────────────────────────────────────

/**
 * Returns `true` when the stored session is within the max-age window and
 * safe to restore automatically.
 */
export function isSessionRestorable(session: WalletSession): boolean {
  const now = Date.now();
  const age = now - session.connectedAt;

  if (age > SESSION_MAX_AGE_MS) return false;

  // Also check the last-confirmed timestamp – if it's stale the user might
  // have changed wallets externally.
  try {
    const lastConfirmed = new Date(session.lastConfirmedAt).getTime();
    if (Number.isNaN(lastConfirmed)) return false;
    if (now - lastConfirmed > SESSION_MAX_AGE_MS) return false;
  } catch {
    return false;
  }

  return true;
}

/**
 * Returns the reason a session is invalid, or `"none"` if it is restorable.
 * This is more detailed than `isSessionRestorable` so the UI can surface
 * specific recovery instructions.
 */
export function getSessionInvalidReason(
  session: WalletSession | null,
  currentEnvironmentId?: string,
): { invalid: false } | { invalid: true; reason: SessionInvalidReason } {
  if (!session) return { invalid: true, reason: "corrupted" };

  const now = Date.now();
  const age = now - session.connectedAt;

  if (age > SESSION_MAX_AGE_MS) return { invalid: true, reason: "expired" };

  try {
    const lastConfirmed = new Date(session.lastConfirmedAt).getTime();
    if (Number.isNaN(lastConfirmed)) return { invalid: true, reason: "corrupted" };
    if (now - lastConfirmed > SESSION_MAX_AGE_MS) return { invalid: true, reason: "expired" };
  } catch {
    return { invalid: true, reason: "corrupted" };
  }

  if (
    currentEnvironmentId &&
    session.environmentId &&
    session.environmentId !== currentEnvironmentId
  ) {
    return { invalid: true, reason: "environment_mismatch" };
  }

  return { invalid: false };
}

/**
 * Checks whether the session was created in a different environment/branch
 * than the app is currently running in.
 */
export function isSessionEnvironmentMismatch(
  session: WalletSession,
  currentEnvironmentId: string,
): boolean {
  if (!session.environmentId) return false;
  return session.environmentId !== currentEnvironmentId;
}

/**
 * Call after a successful wallet interaction to bump the last-confirmed
 * timestamp, keeping the session alive.
 */
export async function touchSession(): Promise<void> {
  const session = await getWalletSession();
  if (!session) return;

  session.lastConfirmedAt = new Date().toISOString();
  await saveWalletSession(session);
}

// ── Last Wallet Type ─────────────────────────────────────────────────────────

export async function getLastWalletType(): Promise<WalletType | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_WALLET_TYPE_KEY);
    if (!raw) return null;
    return isValidWalletType(raw) ? raw : null;
  } catch {
    return null;
  }
}

// ── Wallet Capability Matrix ─────────────────────────────────────────────────

/**
 * A single wallet operation that a connection path may or may not support.
 * Classic payment signing and Soroban auth-entry signing are tracked as
 * distinct capabilities so consumers never conflate the two.
 */
export type WalletCapability =
  | "classic_payment_signing"
  | "soroban_auth_entry_signing"
  | "message_signing"
  | "network_switching";

/**
 * How a capability behaves when it is not fully supported.
 * - `supported`: fully available
 * - `degraded`: available with reduced guarantees (e.g. requires manual step)
 * - `unsupported`: not available on this connection path
 */
export type CapabilitySupport = "supported" | "degraded" | "unsupported";

export interface CapabilityProbeResult {
  capability: WalletCapability;
  support: CapabilitySupport;
  /** Human-readable note explaining any degradation or requirement */
  note?: string;
}

export interface WalletCapabilityMatrixEntry {
  walletType: WalletType;
  /** Networks on which this wallet can be used */
  networks: WalletNetwork[];
  capabilities: Record<WalletCapability, CapabilitySupport>;
  /** Notes keyed by capability for degraded/unsupported behaviors */
  notes: Partial<Record<WalletCapability, string>>;
}

const ALL_CAPABILITIES: WalletCapability[] = [
  "classic_payment_signing",
  "soroban_auth_entry_signing",
  "message_signing",
  "network_switching",
];

/**
 * Static capability probes per wallet type. These are derived from the
 * runtime discovery of each connection path and are the single source of
 * truth for the published compatibility matrix.
 */
const CAPABILITY_PROBES: Record<WalletType, CapabilityProbeResult[]> = {
  freighter: [
    { capability: "classic_payment_signing", support: "supported" },
    { capability: "soroban_auth_entry_signing", support: "supported" },
    { capability: "message_signing", support: "supported" },
    { capability: "network_switching", support: "supported" },
  ],
  lobstr: [
    { capability: "classic_payment_signing", support: "supported" },
    {
      capability: "soroban_auth_entry_signing",
      support: "unsupported",
      note: "Lobstr does not expose Soroban auth-entry signing; Soroban flows must use another wallet.",
    },
    { capability: "message_signing", support: "supported" },
    {
      capability: "network_switching",
      support: "degraded",
      note: "Network is fixed by the Lobstr app setting; switching requires the user to change it manually.",
    },
  ],
  xbull: [
    { capability: "classic_payment_signing", support: "supported" },
    { capability: "soroban_auth_entry_signing", support: "supported" },
    { capability: "message_signing", support: "supported" },
    { capability: "network_switching", support: "supported" },
  ],
  albedo: [
    { capability: "classic_payment_signing", support: "supported" },
    {
      capability: "soroban_auth_entry_signing",
      support: "degraded",
      note: "Albedo signs Soroban auth entries but requires an explicit user confirmation per entry.",
    },
    { capability: "message_signing", support: "supported" },
    { capability: "network_switching", support: "supported" },
  ],
  demo: [
    { capability: "classic_payment_signing", support: "supported" },
    { capability: "soroban_auth_entry_signing", support: "supported" },
    { capability: "message_signing", support: "supported" },
    { capability: "network_switching", support: "supported" },
  ],
};

const NETWORKS_BY_WALLET: Record<WalletType, WalletNetwork[]> = {
  freighter: ["testnet", "mainnet"],
  lobstr: ["testnet", "mainnet"],
  xbull: ["testnet", "mainnet"],
  albedo: ["testnet", "mainnet"],
  demo: ["testnet"],
};

/**
 * Builds the capability matrix entry for a wallet type from its probes.
 * Unknown wallet types yield an empty capability set (all `unsupported`)
 * rather than throwing, so callers can degrade gracefully.
 */
export function getWalletCapabilityMatrix(
  walletType: WalletType | string,
): WalletCapabilityMatrixEntry {
  const probes = isValidWalletType(walletType)
    ? CAPABILITY_PROBES[walletType]
    : undefined;

  const capabilities = {} as Record<WalletCapability, CapabilitySupport>;
  const notes: Partial<Record<WalletCapability, string>> = {};

  for (const capability of ALL_CAPABILITIES) {
    const probe = probes?.find((p) => p.capability === capability);
    capabilities[capability] = probe?.support ?? "unsupported";
    if (probe?.note) notes[capability] = probe.note;
  }

  return {
    walletType: isValidWalletType(walletType) ? walletType : ("demo" as WalletType),
    networks: isValidWalletType(walletType) ? NETWORKS_BY_WALLET[walletType] : [],
    capabilities,
    notes,
  };
}

/**
 * Returns whether a specific capability is available (fully or degraded)
 * for a wallet type. Unknown wallets always report `unsupported`.
 */
export function supportsCapability(
  walletType: WalletType | string,
  capability: WalletCapability,
): boolean {
  return getWalletCapabilityMatrix(walletType).capabilities[capability] !== "unsupported";
}

/**
 * Builds the full published compatibility matrix across all known wallets.
 */
export function buildCapabilityMatrix(): WalletCapabilityMatrixEntry[] {
  return (Object.keys(CAPABILITY_PROBES) as WalletType[]).map((walletType) =>
    getWalletCapabilityMatrix(walletType),
  );
}
