'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import QRCode from 'react-qr-code';
import {
  PaymentStatusBadge,
  type PaymentStatus,
} from '@/components/PaymentStatusBadge';

type ScamAlert = ScamSignal;

interface PaymentPageProps {
  params: Promise<{ username: string; amount: string }>;
  searchParams: Promise<{ asset?: string }>;
}

const isMobile = (): boolean => {
  if (typeof window === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(
    navigator.userAgent
  );
};

export default function PaymentPage({ scamAlert }: PaymentPageProps) {
  const params = useParams();
  const username = (params?.username as string) ?? '';
  const amount = (params?.amount as string) ?? '';

  const [showExplainer, setShowExplainer] = useState(false);
  const router = useRouter();
  const [alert, setAlert] = useState<ScamAlert | null>(scamAlert ?? null);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>('pending');
  // Treat alerts without an explicit confidence as high: fail safe.
  const isHighConfidence = alert?.isScam === true && alert.confidence !== 'low';
  const blocked = isHighConfidence && !riskAccepted;

  useEffect(() => {
    if (scamAlert) {
      setAlert(scamAlert);
      return;
    }

    let cancelled = false;

    async function fetchScamAlert() {
      try {
        const res = await fetch(
          `/api/scam-alert?username=${encodeURIComponent(username)}`
        );
        if (!res.ok) return;
        const data = (await res.json()) as ScamAlert;
        if (!cancelled) setAlert(data);
      } catch {
        // Silently ignore — absence of an alert is the safe default.
      }
    }

    if (username) {
      fetchScamAlert();
    }

    return () => {
      cancelled = true;
    };
  }, [username, scamAlert]);

  useEffect(() => {
    let cancelled = false;

    async function fetchPaymentStatus() {
      try {
        const res = await fetch(
          `/api/payments/status?username=${encodeURIComponent(
            username
          )}&amount=${encodeURIComponent(amount)}`
        );
        if (!res.ok) return;
        const data = (await res.json()) as { status?: PaymentStatus };
        if (!cancelled && data.status) setPaymentStatus(data.status);
      } catch {
        // Keep the safe default ('pending') if the status cannot be resolved.
      }
    }

    if (username && amount) {
      fetchPaymentStatus();
    }

    return () => {
      cancelled = true;
    };
  }, [username, amount]);

  const handleFreighter = () => {
    if (isMobile()) {
      window.location.href = `freighter://pay?to=${encodeURIComponent(
        username
      )}&amount=${encodeURIComponent(amount)}`;
    } else {
      window.open('https://www.freighter.app/', '_blank', 'noopener,noreferrer');
    }
  };
}

  const handleLobstr = () => {
    window.open(
      `https://lobstr.co/`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  const payUrl =
    typeof window !== 'undefined'
      ? window.location.href
      : `https://quickex.to/${username}/${amount}`;

  const ctaClass =
    'flex min-h-12 w-full items-center justify-center rounded-xl bg-indigo-700 px-5 py-3.5 text-base font-semibold text-white shadow-sm transition-colors hover:bg-indigo-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2';

  return (
    <main className="min-h-screen bg-white px-4 py-6 sm:px-6 sm:py-12">
      <div className="mx-auto w-full max-w-md md:grid md:max-w-4xl md:grid-cols-2 md:items-center md:gap-12">
        {/* Details + actions: single column on mobile, left column on desktop */}
        <section className="min-w-0">
          {alert?.isScam && (
            <div
              role="alert"
              className="mb-6 rounded-lg border border-red-300 bg-red-50 p-4"
            >
              <p className="text-sm font-semibold text-red-800">
                ⚠️ Warning: this payment request may be a scam
              </p>
              {alert.reason && (
                <p className="mt-1 text-sm text-red-700">{alert.reason}</p>
              )}
              <p className="mt-2 text-sm text-red-700">
                Do not send funds unless you trust the recipient.
              </p>
            </div>
          )}

          <div className="flex flex-col items-center gap-2 md:flex-row md:items-center md:justify-between">
            <p className="text-center text-sm font-medium uppercase tracking-wide text-gray-500 md:text-left">
              Payment request
            </p>
            <PaymentStatusBadge status={paymentStatus} />
          </div>
          <h1 className="mt-2 text-center md:text-left">
            <span className="block break-words text-5xl font-extrabold leading-tight text-gray-900 sm:text-6xl">
              {amount}
            </span>
            <span className="mt-2 block break-all text-xl font-semibold text-gray-800 sm:text-2xl">
              to @{username}
            </span>
          </h1>

          <p className="mt-4 text-center text-base leading-relaxed text-gray-700 md:text-left">
            You&apos;ll send {amount} directly to @{username}&apos;s Stellar
            wallet — no middleman, no account needed.
          </p>

          {/* QR: centred under the details on mobile, moves right on desktop */}
          <div className="mt-6 flex justify-center md:hidden">
            <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
              <QRCode
                value={payUrl}
                size={200}
                className="h-[200px] w-[200px]"
                aria-label={`QR code to pay ${amount} to @${username}`}
              />
            </div>
          </div>

          <div className="mt-8 flex flex-col gap-3">
            <button type="button" onClick={handleFreighter} className={ctaClass}>
              Pay with Freighter
            </button>

            <button type="button" onClick={handleLobstr} className={ctaClass}>
              Pay with Lobstr
            </button>
          </div>

          <div className="mt-4 text-center md:text-left">
            <button
              type="button"
              onClick={() => setShowExplainer(true)}
              className="min-h-12 px-2 text-sm font-medium text-indigo-700 underline underline-offset-2 hover:text-indigo-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              I don&apos;t have a wallet yet
            </button>
          </div>

          <p className="mt-6 text-center text-xs leading-relaxed text-gray-600 md:text-left">
            Powered by Stellar · Funds go directly to @{username}&apos;s wallet
          </p>
        </section>

        <aside className="hidden md:flex md:flex-col md:items-center">
          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <QRCode
              value={payUrl}
              size={256}
              className="h-64 w-64"
              aria-label={`QR code to pay ${amount} to @${username}`}
            />
          </div>
          <p className="mt-4 text-sm text-gray-600">
            Scan with your phone&apos;s wallet app
          </p>
        </aside>
      </div>

      {showExplainer && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="explainer-title"
          onClick={() => setShowExplainer(false)}
        >
          <div
            className="w-full max-w-md rounded-t-2xl bg-white p-6 shadow-xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="explainer-title"
              className="text-lg font-bold text-gray-900"
            >
              What&apos;s a Stellar wallet?
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-gray-700">
              A Stellar wallet is a free app that lets you hold and send digital
              dollars and other currencies. You stay in control of your money —
              no bank account required.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-gray-700">
              To pay @{username}, install a wallet like Freighter or Lobstr,
              fund it, then come back to this page and tap a payment button.
            </p>
            <button
              type="button"
              onClick={() => setShowExplainer(false)}
              className="mt-6 w-full rounded-lg bg-indigo-700 px-5 py-3 text-base font-semibold text-white transition-colors hover:bg-indigo-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
