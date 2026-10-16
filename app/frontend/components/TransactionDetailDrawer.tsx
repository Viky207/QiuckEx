import { useEffect, useRef, useState } from 'react';

export interface TransactionDetail {
  hash: string;
  ledger: number;
  sender: string;
  recipient: string;
  amount: string;
  asset: string;
  memo?: string;
  timestamp: string;
  fee: string;
  shielded?: boolean;
  network?: 'testnet' | 'mainnet';
}

interface TransactionDetailDrawerProps {
  transaction: TransactionDetail | null;
  onClose: () => void;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Math.round((Date.now() - then) / 1000);
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.345, 'week'],
    [12, 'month'],
  ];
  let value = abs;
  let unit = 'second';
  for (const [step, name] of units) {
    if (value < step) {
      unit = name;
      break;
    }
    value = value / step;
    unit = name;
  }
  const rounded = Math.max(1, Math.round(value));
  const label = `${rounded} ${unit}${rounded === 1 ? '' : 's'}`;
  return diff >= 0 ? `${label} ago` : `in ${label}`;
}

function explorerUrl(tx: TransactionDetail): string {
  const network = tx.network === 'mainnet' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${network}/tx/${tx.hash}`;
}

function horizonUrl(tx: TransactionDetail): string {
  const base =
    tx.network === 'mainnet'
      ? 'https://horizon.stellar.org'
      : 'https://horizon-testnet.stellar.org';
  return `${base}/transactions/${tx.hash}`;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        );
      }}
      className="ml-2 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100"
      aria-label="Copy transaction hash"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-gray-100 py-3 sm:flex-row sm:items-start sm:justify-between">
      <span className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</span>
      <span className="break-all text-sm text-gray-900 sm:max-w-[60%] sm:text-right">{children}</span>
    </div>
  );
}

export default function TransactionDetailDrawer({
  transaction,
  onClose,
}: TransactionDetailDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const open = transaction !== null;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  if (!transaction) return null;

  const shielded = transaction.shielded === true;

  return (
    <div className="fixed inset-0 z-50 flex" role="presentation">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Transaction details"
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl outline-none sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[420px] sm:rounded-none sm:rounded-l-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Transaction details</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-500 hover:bg-gray-100"
            aria-label="Close transaction details"
          >
            ✕
          </button>
        </div>

        <Row label="Transaction hash">
          <span className="font-mono text-xs">{transaction.hash}</span>
          <CopyButton value={transaction.hash} />
        </Row>
        <Row label="Ledger sequence">{transaction.ledger}</Row>
        <Row label="Sender">
          {shielded ? 'Shielded' : <span className="font-mono text-xs">{transaction.sender}</span>}
        </Row>
        <Row label="Recipient">
          {shielded ? 'Shielded' : <span className="font-mono text-xs">{transaction.recipient}</span>}
        </Row>
        <Row label="Amount">{shielded ? 'Shielded' : `${transaction.amount} ${transaction.asset}`}</Row>
        <Row label="Asset">{transaction.asset}</Row>
        {transaction.memo ? <Row label="Memo">{transaction.memo}</Row> : null}
        <Row label="Timestamp">
          <span className="block">{transaction.timestamp}</span>
          <span className="block text-xs text-gray-500">{relativeTime(transaction.timestamp)}</span>
        </Row>
        <Row label="Fee paid">{transaction.fee}</Row>

        <div className="mt-5 flex flex-col gap-2">
          <a
            href={explorerUrl(transaction)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md bg-indigo-600 px-4 py-2 text-center text-sm font-medium text-white hover:bg-indigo-700"
          >
            View on Stellar Explorer
          </a>
          <a
            href={horizonUrl(transaction)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-gray-300 px-4 py-2 text-center text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            View on Horizon
          </a>
        </div>
      </div>
    </div>
  );
}
