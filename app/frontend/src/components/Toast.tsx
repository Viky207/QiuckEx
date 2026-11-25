import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastInput {
  message: string;
  tone?: ToastTone;
  /** When true the toast is kept in the persistent history after dismissal. */
  important?: boolean;
  /** Auto-dismiss delay in ms. Ignored for important toasts. */
  durationMs?: number;
}

export interface ToastRecord extends Required<Omit<ToastInput, "durationMs">> {
  id: number;
  createdAt: number;
}

interface ToastContextValue {
  toasts: ToastRecord[];
  history: ToastRecord[];
  push: (input: ToastInput) => number;
  dismiss: (id: number) => void;
  clearHistory: () => void;
}

const DEFAULT_DURATION_MS = 6000;
const MAX_VISIBLE = 4;
const MAX_HISTORY = 50;

const ToastContext = createContext<ToastContextValue | null>(null);

let nextToastId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const [history, setHistory] = useState<ToastRecord[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      clearTimer(id);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    },
    [clearTimer],
  );

  const push = useCallback(
    (input: ToastInput) => {
      const record: ToastRecord = {
        id: nextToastId++,
        message: input.message,
        tone: input.tone ?? "info",
        important: input.important ?? false,
        createdAt: Date.now(),
      };

      setToasts((current) => {
        const next = [...current, record];
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next;
      });

      if (record.important) {
        setHistory((current) => [record, ...current].slice(0, MAX_HISTORY));
      } else {
        const duration = input.durationMs ?? DEFAULT_DURATION_MS;
        if (duration > 0) {
          const timer = setTimeout(() => dismiss(record.id), duration);
          timers.current.set(record.id, timer);
        }
      }

      return record.id;
    },
    [dismiss],
  );

  const clearHistory = useCallback(() => setHistory([]), []);

  useEffect(() => {
    const activeTimers = timers.current;
    return () => {
      activeTimers.forEach((timer) => clearTimeout(timer));
      activeTimers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ toasts, history, push, dismiss, clearHistory }),
    [toasts, history, push, dismiss, clearHistory],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastRecord[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      className="toast-viewport"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
      aria-relevant="additions text"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast--${toast.tone}`}
          role={toast.tone === "error" ? "alert" : "status"}
          aria-atomic="true"
        >
          <span className="toast__message">{toast.message}</span>
          <button
            type="button"
            className="toast__dismiss"
            aria-label={`Dismiss notification: ${toast.message}`}
            onClick={() => onDismiss(toast.id)}
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
