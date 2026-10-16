import { useEffect, useRef, useState } from 'react';

export interface Transaction {
  id: string;
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
}

interface TransactionFeedProps {
  transactions: Transaction[];
  network?: 'testnet' | 'mainnet';
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function truncate(value: string, head = 6, tail = 6): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ml-2 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100"
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 border-b border-gray-100 last:border-b-0">
      <span className="text-xs uppercase tracking-wide text-gray-500">{label}</span>
      <span className="break-all text-sm text-gray-900">{children}</span>
    </div>
  );
}

function TransactionDrawer({
  transaction,
  network,
  onClose,
}: {
  transaction: Transaction;
  network: 'testnet' | 'mainnet';
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
      previouslyFocused?.focus();
    };
  }, [onClose]);

  const explorerUrl = `https://stellar.expert/explorer/${network}/tx/${transaction.hash}`;
  const horizonUrl = `https://horizon-${network}.stellar.org/transactions/${transaction.hash}`;

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
        className="relative ml-auto flex h-full w-full max-w-md flex-col overflow-y-auto bg-white shadow-xl outline-none sm:rounded-l-lg max-sm:mt-auto max-sm:h-[85vh] max-sm:max-w-none max-sm:rounded-t-2xl"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h2 className="text-base font-semibold text-gray-900">Transaction details</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 px-4 py-2">
          <DetailRow label="Transaction hash">
            <span className="font-mono">{truncate(transaction.hash, 10, 10)}</span>
            <CopyButton value={transaction.hash} />
          </DetailRow>
          <DetailRow label="Ledger sequence">{transaction.ledger}</DetailRow>
          <DetailRow label="Sender">
            {transaction.shielded ? 'Shielded' : <span className="font-mono">{truncate(transaction.sender)}</span>}
          </DetailRow>
          <DetailRow label="Recipient">
            {transaction.shielded ? 'Shielded' : <span className="font-mono">{truncate(transaction.recipient)}</span>}
          </DetailRow>
          <DetailRow label="Amount">
            {transaction.shielded ? 'Shielded' : `${transaction.amount} ${transaction.asset}`}
          </DetailRow>
          <DetailRow label="Asset">{transaction.asset}</DetailRow>
          {transaction.memo ? <DetailRow label="Memo">{transaction.memo}</DetailRow> : null}
          <DetailRow label="Timestamp">
            <span>{new Date(transaction.timestamp).toISOString()}</span>
            <span className="ml-2 text-xs text-gray-500">({relativeTime(transaction.timestamp)})</span>
          </DetailRow>
          <DetailRow label="Fee paid">{transaction.fee}</DetailRow>
        </div>

        <div className="flex flex-col gap-2 border-t border-gray-200 px-4 py-3">
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded bg-indigo-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-indigo-700"
          >
            View on Stellar Explorer
          </a>
          <a
            href={horizonUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-gray-300 px-3 py-2 text-center text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            View on Horizon
          </a>
        </div>
      </div>
    </div>
  );
}

export default function TransactionFeed({ transactions, network = 'testnet' }: TransactionFeedProps) {
  const [selected, setSelected] = useState<Transaction | null>(null);

  return (
    <div className="divide-y divide-gray-100">
      {transactions.map((tx) => (
        <button
          key={tx.id}
          type="button"
          onClick={() => setSelected(tx)}
          className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
        >
          <span className="text-sm text-gray-900">
            {tx.shielded ? 'Shielded' : `${tx.amount} ${tx.asset}`}
          </span>
          <span className="text-xs text-gray-500">{relativeTime(tx.timestamp)}</span>
        </button>
      ))}

      {selected ? (
        <TransactionDrawer
          transaction={selected}
          network={network}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
