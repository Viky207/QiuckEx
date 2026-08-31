/**
 * Detection helpers for supported browser-injected Stellar wallets.
 */

export type WalletId = "freighter" | "lobstr" | "xbull";

export interface DetectedWallet {
  id: WalletId;
  name: string;
  available: boolean;
}

function hasGlobal(key: string): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as unknown as Record<string, unknown>)[key]);
}

export function detectWallets(): DetectedWallet[] {
  return [
    {
      id: "freighter",
      name: "Freighter",
      // Freighter injects `freighterApi` (via @stellar/freighter-api) or `window.freighter`.
      available: hasGlobal("freighterApi") || hasGlobal("freighter"),
    },
    {
      id: "lobstr",
      name: "Lobstr",
      available: hasGlobal("lobstrApi") || hasGlobal("lobstr"),
    },
    {
      id: "xbull",
      name: "xBull",
      available: hasGlobal("xBullSDK") || hasGlobal("xBull"),
    },
  ];
}

export function getAvailableWallets(): DetectedWallet[] {
  return detectWallets().filter((wallet) => wallet.available);
}
