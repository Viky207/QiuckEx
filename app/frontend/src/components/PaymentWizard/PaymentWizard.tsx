"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Copy, Info } from "lucide-react";
import { QRPreview } from "@/components/QRPreview";
import { getQuickexApiBase } from "@/lib/api";
import {
  MAX_MEMO_LENGTH,
  STELLAR_ADDRESS_REGEX,
  validateAmountInput,
  validateMemoInput,
} from "@/lib/linkGenerator";

type StellarAsset = {
  code: string;
  type: string;
  issuer: string | null;
  verified: boolean;
};

type ScamAlert = {
  isScam: boolean;
  reason?: string;
};

type ScamScanResult = {
  isSafe: boolean;
  alerts: Array<{ message: string }>;
};

type WizardProps = {
  onClose?: () => void;
};

const STEP_TITLES = [
  "Choose an asset",
  "Set the amount",
  "Add a memo",
  "Privacy settings",
  "Payment link preview",
];

const BASE_ASSETS: StellarAsset[] = [
  { code: "USDC", type: "credit_alphanum4", issuer: null, verified: true },
  { code: "XLM", type: "native", issuer: null, verified: true },
];

function isUsername(value: string) {
  return /^[a-zA-Z0-9_]{3,32}$/.test(value.trim());
}

function horizonAssetParams(asset: StellarAsset, prefix: "selling" | "buying") {
  const params: Record<string, string> = {};
  if (asset.type === "native" || asset.code === "XLM") {
    params[`${prefix}_asset_type`] = "native";
  } else if (asset.issuer) {
    params[`${prefix}_asset_type`] = asset.code.length <= 4
      ? "credit_alphanum4"
      : "credit_alphanum12";
    params[`${prefix}_asset_code`] = asset.code;
    params[`${prefix}_asset_issuer`] = asset.issuer;
  }
  return params;
}

export function PaymentWizard({ onClose }: WizardProps) {
  const apiBase = useMemo(() => getQuickexApiBase(), []);
  const [step, setStep] = useState(0);
  const [assets, setAssets] = useState(BASE_ASSETS);
  const [assetCode, setAssetCode] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [memo, setMemo] = useState("");
  const [privacy, setPrivacy] = useState(false);
  const [usdRate, setUsdRate] = useState<number | null>(1);
  const [priceLoading, setPriceLoading] = useState(false);
  const [scamAlert, setScamAlert] = useState<ScamAlert | null>(null);
  const [scamLoading, setScamLoading] = useState(false);
  const [scamError, setScamError] = useState("");
  const [scamAcknowledged, setScamAcknowledged] = useState(false);
  const [generatedLink, setGeneratedLink] = useState("");
  const [generationError, setGenerationError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const stepHeading = useRef<HTMLHeadingElement>(null);

  const customAssets = assets.filter(
    (asset) => asset.code !== "USDC" && asset.code !== "XLM",
  );
  const amountValidation = validateAmountInput(amount);
  const memoValidation = validateMemoInput(memo);
  const recipientValid = STELLAR_ADDRESS_REGEX.test(destination.trim()) || isUsername(destination);
  const hasScamWarning = scamAlert?.isScam === true;

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/stellar/verified-assets`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Asset list unavailable");
        return response.json() as Promise<{ assets?: StellarAsset[] }>;
      })
      .then((result) => {
        if (cancelled) return;
        const merged = [...BASE_ASSETS, ...(result.assets ?? [])];
        const byCode = new Map(merged.map((asset) => [asset.code, asset]));
        setAssets(Array.from(byCode.values()));
      })
      .catch(() => {
        if (!cancelled) setAssets(BASE_ASSETS);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  useEffect(() => {
    stepHeading.current?.focus();
  }, [step]);

  useEffect(() => {
    if (assetCode === "USDC") {
      setUsdRate(1);
      setPriceLoading(false);
      return;
    }

    const usdcAsset = assets.find((asset) => asset.code === "USDC");
    const selected = assets.find((asset) => asset.code === assetCode);
    if (!selected || !usdcAsset?.issuer) {
      setUsdRate(null);
      return;
    }

    const controller = new AbortController();
    const network = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "testnet";
    const horizonUrl = process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ??
      (network === "mainnet"
        ? "https://horizon.stellar.org"
        : "https://horizon-testnet.stellar.org");
    const params = new URLSearchParams({
      ...horizonAssetParams(selected, "selling"),
      ...horizonAssetParams(usdcAsset, "buying"),
      limit: "10",
    });

    setPriceLoading(true);
    setUsdRate(null);
    fetch(`${horizonUrl.replace(/\/$/, "")}/order_book?${params}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Price quote unavailable");
        return response.json() as Promise<{
          asks?: Array<{ price?: string }>;
          bids?: Array<{ price?: string }>;
        }>;
      })
      .then((book) => {
        const ask = Number(book.asks?.[0]?.price);
        const bid = Number(book.bids?.[0]?.price);
        const rate = ask > 0 && bid > 0 ? (ask + bid) / 2 : ask || bid;
        setUsdRate(Number.isFinite(rate) && rate > 0 ? rate : null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setUsdRate(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setPriceLoading(false);
      });

    return () => controller.abort();
  }, [assetCode, assets]);

  useEffect(() => {
    setScamAlert(null);
    setScamAcknowledged(false);
    setScamError("");
    if (step !== 2) return;

    let cancelled = false;
    setScamLoading(true);
    fetch(`${apiBase}/links/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assetCode: assetCode,
        amount: Number(amount),
        memo: memo || undefined,
        ...(STELLAR_ADDRESS_REGEX.test(destination.trim())
          ? { recipientAddress: destination.trim() }
          : {}),
      }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Safety scan unavailable");
        return response.json() as Promise<ScamScanResult>;
      })
      .then((result) => {
        if (!cancelled) {
          setScamAlert({
            isScam: !result.isSafe,
            reason: result.alerts.map((alert) => alert.message).join(" "),
          });
        }
      })
      .catch(() => {
        if (!cancelled) setScamError("Safety scan is unavailable for this asset right now.");
      })
      .finally(() => {
        if (!cancelled) setScamLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, amount, assetCode, destination, memo, step]);

  const usdEquivalent = Number(amount) * (usdRate ?? 0);
  const priceText = priceLoading
    ? "Checking Horizon price..."
    : usdRate === null
      ? "USD estimate unavailable for this asset"
      : `Approximately $${usdEquivalent.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} USD`;

  const handleGenerate = async () => {
    setGenerating(true);
    setGenerationError("");
    setCopyMessage("");
    try {
      const recipient = destination.trim();
      const body = {
        amount: Number(amount),
        asset: assetCode,
        ...(STELLAR_ADDRESS_REGEX.test(recipient)
          ? { destination: recipient }
          : { username: recipient }),
        memo: memo || undefined,
        privacy,
      };
      const response = await fetch(`${apiBase}/links/metadata`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok || result?.success !== true || !result?.data?.canonical) {
        throw new Error(result?.message ?? result?.error ?? "Could not generate the payment link.");
      }
      const canonical = String(result.data.canonical).replace(/^\?/, "");
      setGeneratedLink(/^https?:\/\//.test(canonical)
        ? canonical
        : `${window.location.origin}/pay?${canonical}`);
      setStep(4);
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "Could not generate the payment link.");
    } finally {
      setGenerating(false);
    }
  };

  const handleContinue = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step === 0) {
      if (!assetCode || !recipientValid) return;
      setStep(1);
    } else if (step === 1) {
      if (!amountValidation.valid) return;
      setStep(2);
    } else if (step === 2) {
      if (!memoValidation.valid || (hasScamWarning && !scamAcknowledged) || scamLoading) return;
      setStep(3);
    } else if (step === 3) {
      void handleGenerate();
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(generatedLink);
      setCopyMessage("Payment link copied.");
    } catch {
      setCopyMessage("Copy is unavailable in this browser.");
    }
  };

  return (
    <section
      aria-labelledby="payment-wizard-title"
      className="w-full max-w-3xl border-y border-border-strong py-6 sm:py-8"
    >
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-muted">Create payment link</p>
          <h2
            id="payment-wizard-title"
            ref={stepHeading}
            tabIndex={-1}
            className="mt-1 text-2xl font-semibold text-foreground focus:outline-none"
          >
            {STEP_TITLES[step]}
          </h2>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close payment wizard"
            className="rounded-md border border-border-strong px-3 py-2 text-sm text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
          >
            Close
          </button>
        )}
      </div>

      <div className="mb-6 flex items-center gap-2" aria-label={`Step ${step + 1} of 5`}>
        {STEP_TITLES.map((title, index) => (
          <span
            key={title}
            aria-label={`Step ${index + 1}: ${title}${index === step ? ", current" : ""}`}
            aria-current={index === step ? "step" : undefined}
            className={`h-1.5 flex-1 rounded-full ${index <= step ? "bg-emerald-500" : "bg-border-strong"}`}
          />
        ))}
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        Step {step + 1} of 5: {STEP_TITLES[step]}
      </p>

      <form onSubmit={handleContinue} noValidate>
        {step === 0 && (
          <div className="space-y-5">
            <fieldset>
              <legend className="mb-3 text-sm font-medium text-muted">Payment asset</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {assets.filter((asset) => asset.code === "USDC" || asset.code === "XLM").map((asset) => (
                  <button
                    key={asset.code}
                    type="button"
                    aria-pressed={assetCode === asset.code}
                    onClick={() => setAssetCode(asset.code)}
                    className={`min-h-12 rounded-md border px-4 text-left font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 ${assetCode === asset.code ? "border-emerald-500 bg-emerald-500/10 text-foreground" : "border-border-strong text-muted"}`}
                  >
                    {asset.code}
                  </button>
                ))}
              </div>
            </fieldset>
            {customAssets.length > 0 && (
              <div>
                <label htmlFor="wizard-custom-asset" className="mb-2 block text-sm font-medium text-muted">
                  Custom Stellar asset
                </label>
                <select
                  id="wizard-custom-asset"
                  value={customAssets.some((asset) => asset.code === assetCode) ? assetCode : ""}
                  onChange={(event) => event.target.value && setAssetCode(event.target.value)}
                  className="min-h-12 w-full rounded-md border border-border-strong bg-background px-3 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
                >
                  <option value="">Choose a verified asset</option>
                  {customAssets.map((asset) => (
                    <option key={`${asset.code}-${asset.issuer ?? ""}`} value={asset.code}>
                      {asset.code}{asset.issuer ? ` · ${asset.issuer.slice(0, 6)}…` : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label htmlFor="wizard-recipient" className="mb-2 block text-sm font-medium text-muted">
                Recipient username or Stellar address
              </label>
              <input
                id="wizard-recipient"
                autoComplete="off"
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
                aria-invalid={Boolean(destination) && !recipientValid}
                aria-describedby="wizard-recipient-hint"
                placeholder="Username or G... address"
                className="min-h-12 w-full rounded-md border border-border-strong bg-background px-3 text-foreground placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
              />
              <p id="wizard-recipient-hint" className="mt-2 text-xs text-muted">
                {destination && !recipientValid ? "Enter a username (3-32 characters) or a valid Stellar public key." : "Choose where this payment request should be sent."}
              </p>
            </div>
          </div>
        )}

        {step === 1 && (
          <div>
            <label htmlFor="wizard-amount" className="mb-2 block text-sm font-medium text-muted">Amount in {assetCode}</label>
            <input
              id="wizard-amount"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              autoFocus
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              aria-invalid={Boolean(amount) && !amountValidation.valid}
              placeholder="0.00"
              className="min-h-16 w-full rounded-md border border-border-strong bg-background px-4 text-3xl font-semibold text-foreground placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
            />
            <p className="mt-3 text-sm font-medium text-muted" aria-live="polite">{priceText}</p>
            <p className="mt-1 text-xs text-subtle">Estimate from the current Stellar Horizon order book; final settlement rates may vary.</p>
            {amount && !amountValidation.valid && <p role="alert" className="mt-2 text-sm text-red-500">{amountValidation.message}</p>}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <div>
              <label htmlFor="wizard-memo" className="mb-2 block text-sm font-medium text-muted">Memo <span className="font-normal">(optional)</span></label>
              <input
                id="wizard-memo"
                type="text"
                maxLength={MAX_MEMO_LENGTH}
                value={memo}
                onChange={(event) => setMemo(event.target.value)}
                aria-invalid={!memoValidation.valid}
                aria-describedby="wizard-memo-counter"
                placeholder="What is this payment for?"
                className="min-h-12 w-full rounded-md border border-border-strong bg-background px-3 text-foreground placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
              />
              <p id="wizard-memo-counter" className="mt-2 text-xs text-muted">{memoValidation.byteLength}/{MAX_MEMO_LENGTH} bytes</p>
              {!memoValidation.valid && <p role="alert" className="mt-2 text-sm text-red-500">{memoValidation.message}</p>}
            </div>
            <div className="border-l-2 border-amber-500 pl-4" aria-live="polite">
              <h3 className="text-sm font-semibold text-foreground">Recipient safety check</h3>
              {scamLoading ? <p className="mt-1 text-sm text-muted">Checking this username...</p> : null}
              {hasScamWarning ? (
                <div>
                  <p role="alert" className="mt-1 text-sm text-amber-600">This payment request has scam indicators{scamAlert?.reason ? `: ${scamAlert.reason}` : ". Verify the details before sharing."}</p>
                  <label className="mt-3 flex items-start gap-2 text-sm text-muted">
                    <input type="checkbox" checked={scamAcknowledged} onChange={(event) => setScamAcknowledged(event.target.checked)} className="mt-1 accent-amber-500" />
                    I have reviewed the warning and want to continue.
                  </label>
                </div>
              ) : scamError ? (
                <p role="status" className="mt-1 text-sm text-amber-700">{scamError}</p>
              ) : !scamLoading && scamAlert ? (
                <p className="mt-1 text-sm text-emerald-700">No scam indicators detected for these payment details.</p>
              ) : (
                <p className="mt-1 text-sm text-muted">Checking the payment details for common scam indicators.</p>
              )}
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-md border border-border-strong p-4">
              <div>
                <p className="font-medium text-foreground">X-Ray privacy</p>
                <p className="mt-1 text-sm text-muted">{privacy ? "On: hides amounts and senders in supported views." : "Off: standard payment link details are shown."}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={privacy}
                aria-label="Enable X-Ray privacy"
                aria-describedby="wizard-privacy-help"
                onClick={() => setPrivacy((enabled) => !enabled)}
                className={`relative h-7 w-12 shrink-0 rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 ${privacy ? "border-emerald-600 bg-emerald-600" : "border-border-strong bg-surface"}`}
              >
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${privacy ? "translate-x-5" : "translate-x-0.5"}`} />
              </button>
            </div>
            <div className="flex items-start gap-2 text-sm text-muted">
              <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
              <p id="wizard-privacy-help">X-Ray marks the link as private for supported QuickEx views. It does not conceal transactions from the public Stellar ledger.</p>
              <button type="button" title="X-Ray privacy hides amounts and senders in supported QuickEx views; Stellar ledger activity remains public." aria-label="X-Ray privacy explanation" className="cursor-help underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300">Details</button>
            </div>
            <p className="text-sm text-muted">{amount} {assetCode} · {destination}{memo ? ` · ${memo}` : ""}</p>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-4">
            {generatedLink ? (
              <>
                <div className="mx-auto w-full max-w-xs"><QRPreview value={generatedLink} isPaymentLink /></div>
                <p className="break-all rounded-md border border-border-strong bg-surface p-3 font-mono text-xs text-muted">{generatedLink}</p>
                <button
                  type="button"
                  onClick={() => void handleCopy()}
                  className="flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-4 font-semibold text-white hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
                >
                  <Copy size={16} aria-hidden="true" /> Copy payment link
                </button>
                <p className="min-h-5 text-sm text-emerald-700" aria-live="polite">{copyMessage}</p>
              </>
            ) : (
              <p className="text-sm text-muted">Generate the link to see its QR code and copy it.</p>
            )}
            {generationError && <p role="alert" className="text-sm text-red-500">{generationError}</p>}
          </div>
        )}

        <div className="mt-8 flex flex-col-reverse gap-3 border-t border-border-strong pt-5 sm:flex-row sm:justify-between">
          <button
            type="button"
            onClick={() => step > 0 && setStep(step - 1)}
            disabled={step === 0 || generating}
            className="min-h-11 rounded-md border border-border-strong px-5 font-medium text-foreground disabled:invisible focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
          >
            Back
          </button>
          {step < 4 ? (
            <button
              type="submit"
              disabled={generating || (step === 0 && (!recipientValid || !assetCode)) || (step === 1 && !amountValidation.valid) || (step === 2 && (!memoValidation.valid || scamLoading || (hasScamWarning && !scamAcknowledged)))}
              className="min-h-11 rounded-md bg-emerald-600 px-5 font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
            >
              {step === 3 ? (generating ? "Generating link..." : "Generate preview") : "Continue"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setStep(0);
                setGeneratedLink("");
              }}
              className="min-h-11 rounded-md border border-border-strong px-5 font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
            >
              Create another link
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
