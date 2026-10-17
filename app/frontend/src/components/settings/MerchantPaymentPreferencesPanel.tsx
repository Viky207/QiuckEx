'use client';

import { useEffect, useState } from 'react';
import {
  fetchMerchantPaymentPreferences,
  MERCHANT_PREFERENCE_ASSETS,
  MerchantPaymentPreferences,
  MerchantPreferenceAsset,
  saveMerchantPaymentPreferences,
  signableMerchantPreferencesMessage,
} from '@/hooks/merchantPaymentPreferencesApi';
import { detectWallets } from '@/lib/wallet/detectWallets';
import { connectWallet, signMessage } from '@/lib/wallet/walletSigning';

type Props = { initialPublicKey: string | null };

export function MerchantPaymentPreferencesPanel({ initialPublicKey }: Props) {
  const [publicKey, setPublicKey] = useState(initialPublicKey);
  const [preferences, setPreferences] = useState<MerchantPaymentPreferences | null>(null);
  const [acceptedAssets, setAcceptedAssets] = useState<MerchantPreferenceAsset[]>(['XLM']);
  const [settlementAsset, setSettlementAsset] = useState<MerchantPreferenceAsset>('XLM');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (initialPublicKey) setPublicKey(initialPublicKey);
  }, [initialPublicKey]);

  useEffect(() => {
    if (!publicKey) return;
    let active = true;
    setLoading(true);
    setError(null);
    void fetchMerchantPaymentPreferences(publicKey)
      .then((current) => {
        if (!active) return;
        setPreferences(current);
        setAcceptedAssets(current.acceptedAssets);
        setSettlementAsset(current.settlementAsset);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Unable to load payment preferences.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [publicKey]);

  const toggleAsset = (asset: MerchantPreferenceAsset, checked: boolean) => {
    const next = checked
      ? [...acceptedAssets, asset]
      : acceptedAssets.filter((current) => current !== asset);
    if (next.length === 0) return;
    setAcceptedAssets(next);
    if (!next.includes(settlementAsset)) setSettlementAsset(next[0]);
  };

  const handleSave = async () => {
    setError(null);
    setMessage(null);
    if (!publicKey || !preferences || acceptedAssets.length === 0) {
      setError('Connect a wallet and select at least one accepted asset.');
      return;
    }
    const wallet = detectWallets().find((candidate) => candidate.available);
    if (!wallet) {
      setError('Install a supported Stellar wallet to authorize these preferences.');
      return;
    }

    setSaving(true);
    try {
      const connectedKey = await connectWallet(wallet.id);
      if (connectedKey !== publicKey) {
        setPublicKey(connectedKey);
        throw new Error('The connected wallet changed. Reload its preferences before saving.');
      }
      const signedAt = Date.now();
      const acceptedAssetsSorted = [...acceptedAssets].sort();
      const unsigned = {
        publicKey,
        expectedVersion: preferences.version,
        signedAt,
        acceptedAssets: acceptedAssetsSorted,
        settlementAsset,
      };
      const signature = await signMessage(
        wallet.id,
        await signableMerchantPreferencesMessage(unsigned),
      );
      const saved = await saveMerchantPaymentPreferences(
        { ...unsigned, signature },
        crypto.randomUUID(),
      );
      setPreferences(saved);
      setAcceptedAssets(saved.acceptedAssets);
      setSettlementAsset(saved.settlementAsset);
      setMessage('Payment preferences saved for new links.');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Unable to save payment preferences.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-8 rounded-2xl border border-border bg-card p-5 sm:p-6" aria-labelledby="merchant-payment-preferences-title">
      <div className="mb-5">
        <h2 id="merchant-payment-preferences-title" className="text-lg font-bold">Payment preferences</h2>
        <p className="mt-1 max-w-3xl text-sm text-subtle">
          Choose the assets shown on new payment links and your preferred requested asset. This does not authorize a payment or automatic conversion; every payment still needs the payer’s wallet approval.
        </p>
      </div>

      {!publicKey ? (
        <button
          type="button"
          onClick={() => {
            const wallet = detectWallets().find((candidate) => candidate.available);
            if (!wallet) setError('Install a supported Stellar wallet to continue.');
            else void connectWallet(wallet.id).then(setPublicKey).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Wallet connection failed.'));
          }}
          className="rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white"
        >
          Connect wallet
        </button>
      ) : (
        <>
          <fieldset disabled={loading || saving}>
            <legend className="mb-3 text-sm font-semibold">Accepted assets</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-3">
              {MERCHANT_PREFERENCE_ASSETS.map((asset) => (
                <label key={asset} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={acceptedAssets.includes(asset)}
                    onChange={(event) => toggleAsset(asset, event.target.checked)}
                  />
                  {asset}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="mt-5 max-w-sm">
            <label htmlFor="merchant-settlement-asset" className="mb-2 block text-sm font-semibold">Preferred requested asset</label>
            <select
              id="merchant-settlement-asset"
              value={settlementAsset}
              disabled={loading || saving}
              onChange={(event) => setSettlementAsset(event.target.value as MerchantPreferenceAsset)}
              className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-sm text-foreground"
            >
              {acceptedAssets.map((asset) => <option key={asset} value={asset}>{asset}</option>)}
            </select>
          </div>
          {error ? <p role="alert" className="mt-4 text-sm text-red-500">{error}</p> : null}
          {message ? <p role="status" className="mt-4 text-sm text-success">{message}</p> : null}
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={loading || saving || acceptedAssets.length === 0}
            className="mt-5 rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Loading...' : saving ? 'Authorizing...' : 'Save payment preferences'}
          </button>
        </>
      )}
    </section>
  );
}