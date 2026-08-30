import { getQuickexApiBase } from "@/lib/api";
import type { WalletId } from "./detectWallets";

export class WalletUserDeniedError extends Error {
  constructor(message = "User denied the wallet request.") {
    super(message);
    this.name = "WalletUserDeniedError";
  }
}

interface WalletAdapter {
  connect(): Promise<string>;
  signTransaction(xdr: string): Promise<string>;
}

function getGlobal(key: string): any {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as Record<string, unknown>)[key];
}

function isUserDenied(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error ?? "").toLowerCase();
  return (
    message.includes("denied") ||
    message.includes("declined") ||
    message.includes("rejected") ||
    message.includes("user cancel")
  );
}

function getAdapter(walletId: WalletId): WalletAdapter {
  switch (walletId) {
    case "freighter": {
      const api = getGlobal("freighterApi") ?? getGlobal("freighter");
      if (!api) throw new Error("Freighter is not installed.");
      return {
        connect: async () => {
          const result = await api.requestAccess?.();
          return result?.address ?? (await api.getPublicKey?.());
        },
        signTransaction: async (xdr: string) => {
          const result = await api.signTransaction(xdr);
          return typeof result === "string" ? result : result?.signedTxXdr;
        },
      };
    }
    case "lobstr": {
      const api = getGlobal("lobstrApi") ?? getGlobal("lobstr");
      if (!api) throw new Error("Lobstr is not installed.");
      return {
        connect: async () => api.connect(),
        signTransaction: async (xdr: string) => api.signTransaction(xdr),
      };
    }
    case "xbull": {
      const api = getGlobal("xBullSDK") ?? getGlobal("xBull");
      if (!api) throw new Error("xBull is not installed.");
      return {
        connect: async () => {
          const result = await api.connect();
          return Array.isArray(result) ? result[0] : result?.publicKey ?? result;
        },
        signTransaction: async (xdr: string) => api.sign({ xdr }),
      };
    }
    default:
      throw new Error(`Unsupported wallet: ${walletId}`);
  }
}

export async function connectWallet(walletId: WalletId): Promise<string> {
  try {
    const adapter = getAdapter(walletId);
    return await adapter.connect();
  } catch (error) {
    if (isUserDenied(error)) throw new WalletUserDeniedError();
    throw error;
  }
}

export async function fetchUnsignedXdr(params: {
  publicKey: string;
  [key: string]: unknown;
}): Promise<string> {
  const res = await fetch(`${getQuickexApiBase()}/transactions/compose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error(`Failed to compose transaction (${res.status})`);
  }
  const data = await res.json();
  return data.xdr ?? data.unsignedXdr;
}

export async function signXdr(walletId: WalletId, xdr: string): Promise<string> {
  try {
    const adapter = getAdapter(walletId);
    return await adapter.signTransaction(xdr);
  } catch (error) {
    if (isUserDenied(error)) throw new WalletUserDeniedError();
    throw error;
  }
}

export async function submitSignedXdr(signedXdr: string): Promise<unknown> {
  const res = await fetch(`${getQuickexApiBase()}/transactions/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signedXdr }),
  });
  if (!res.ok) {
    throw new Error(`Failed to submit transaction (${res.status})`);
  }
  return res.json();
}

/**
 * Full connect -> compose -> sign -> submit pipeline for a real wallet.
 */
export async function signAndSubmitTransaction(
  walletId: WalletId,
  composeParams: { publicKey?: string; [key: string]: unknown } = {}
): Promise<unknown> {
  const publicKey = composeParams.publicKey ?? (await connectWallet(walletId));
  const xdr = await fetchUnsignedXdr({ ...composeParams, publicKey });
  const signedXdr = await signXdr(walletId, xdr);
  return submitSignedXdr(signedXdr);
}
