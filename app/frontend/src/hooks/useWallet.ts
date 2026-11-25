import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import { EXPECTED_CHAIN_ID, EXPECTED_CHAIN_NAME } from '../config/chains';

export type WalletNetworkStatus = 'unknown' | 'connected' | 'mismatch' | 'disconnected';

export interface WalletNetworkMismatch {
  /** True when the wallet is connected but on a network other than the expected one. */
  isMismatch: boolean;
  /** Human-readable name of the network the app expects. */
  expectedNetworkName: string;
  /** Chain id the app expects. */
  expectedChainId: number;
  /** Chain id the wallet is currently on, if known. */
  currentChainId?: number;
  /** Guidance for changing the wallet network. */
  changeNetworkGuidance: string;
  /** Guidance for safely leaving the current operation. */
  leaveOperationGuidance: string;
}

export interface UseWalletResult {
  address?: `0x${string}`;
  isConnected: boolean;
  status: WalletNetworkStatus;
  /** Signing is blocked whenever the wallet is on a mismatched network. */
  canSign: boolean;
  mismatch: WalletNetworkMismatch;
  /** Retry wallet/network discovery (e.g. after the user changes networks). */
  retryDiscovery: () => void;
  /** Request a network switch; never assumes the app can change it automatically. */
  requestNetworkSwitch: () => void;
  isSwitching: boolean;
}

export function useWallet(): UseWalletResult {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const [discoveryNonce, setDiscoveryNonce] = useState(0);

  const isMismatch = isConnected && chainId !== EXPECTED_CHAIN_ID;

  const status: WalletNetworkStatus = useMemo(() => {
    if (!isConnected) return 'disconnected';
    if (chainId === undefined) return 'unknown';
    return isMismatch ? 'mismatch' : 'connected';
  }, [isConnected, chainId, isMismatch]);

  const mismatch: WalletNetworkMismatch = useMemo(
    () => ({
      isMismatch,
      expectedNetworkName: EXPECTED_CHAIN_NAME,
      expectedChainId: EXPECTED_CHAIN_ID,
      currentChainId: chainId,
      changeNetworkGuidance: `Open your wallet and switch the active network to ${EXPECTED_CHAIN_NAME}. The app cannot change your wallet network automatically.`,
      leaveOperationGuidance:
        'To leave safely, cancel this operation and disconnect your wallet. No transaction will be signed while the network is mismatched.',
    }),
    [isMismatch, chainId],
  );

  const retryDiscovery = useCallback(() => {
    setDiscoveryNonce((n) => n + 1);
  }, []);

  const requestNetworkSwitch = useCallback(() => {
    if (!switchChain) return;
    switchChain({ chainId: EXPECTED_CHAIN_ID });
  }, [switchChain]);

  // Re-run discovery whenever the nonce changes so the panel can retry.
  useEffect(() => {
    // Reading chainId/address on each render is the discovery step; the nonce
    // forces a fresh evaluation after the user reports a network change.
  }, [discoveryNonce]);

  return {
    address,
    isConnected,
    status,
    canSign: isConnected && !isMismatch && chainId === EXPECTED_CHAIN_ID,
    mismatch,
    retryDiscovery,
    requestNetworkSwitch,
    isSwitching,
  };
}
