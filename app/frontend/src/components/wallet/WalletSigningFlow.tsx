"use client";

import { useState } from "react";
import { detectWallets, type WalletId } from "@/lib/wallet/detectWallets";
import {
  WalletUserDeniedError,
  connectWallet,
  fetchUnsignedXdr,
  signXdr,
  submitSignedXdr,
} from "@/lib/wallet/walletSigning";

type SigningStep = "idle" | "connecting" | "composing" | "signing" | "submitting" | "done" | "error";

interface WalletSigningFlowProps {
  composeParams?: Record<string, unknown>;
  onComplete?: (result: unknown) => void;
}

const STEP_LABELS: Record<SigningStep, string> = {
  idle: "Choose a wallet to begin.",
  connecting: "Connecting to wallet...",
  composing: "Preparing transaction...",
  signing: "Waiting for signature in your wallet...",
  submitting: "Submitting transaction to the network...",
  done: "Transaction submitted.",
  error: "Something went wrong.",
};

export function WalletSigningFlow({ composeParams = {}, onComplete }: WalletSigningFlowProps) {
  const [step, setStep] = useState<SigningStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const wallets = detectWallets();

  const runFlow = async (walletId: WalletId) => {
    setError(null);
    setDenied(false);
    try {
      setStep("connecting");
      const publicKey = await connectWallet(walletId);

      setStep("composing");
      const xdr = await fetchUnsignedXdr({ ...composeParams, publicKey });

      setStep("signing");
      const signedXdr = await signXdr(walletId, xdr);

      setStep("submitting");
      const result = await submitSignedXdr(signedXdr);

      setStep("done");
      onComplete?.(result);
    } catch (err) {
      if (err instanceof WalletUserDeniedError) {
        setDenied(true);
        setStep("idle");
        return;
      }
      setError(err instanceof Error ? err.message : "Signing failed.");
      setStep("error");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {wallets.map((wallet) => (
          <button
            key={wallet.id}
            type="button"
            disabled={!wallet.available || (step !== "idle" && step !== "error")}
            onClick={() => runFlow(wallet.id)}
            className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-40"
          >
            {wallet.name}
            {!wallet.available && " (not detected)"}
          </button>
        ))}
      </div>

      {step !== "idle" && (
        <p className="text-sm text-muted-foreground" role="status">
          {STEP_LABELS[step]}
        </p>
      )}

      {denied && (
        <p className="text-sm text-amber-500">
          You declined the request in your wallet. No transaction was submitted.
        </p>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}

export default WalletSigningFlow;
