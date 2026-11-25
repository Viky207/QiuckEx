import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  /** Important notices are kept in a persistent history after dismissal. */
  important?: boolean;
  /** Auto-dismiss delay in ms; 0 keeps the toast until dismissed. */
  duration?: number;
}

export interface ToastOptions {
  variant?: ToastVariant;
  important?: boolean;
  duration?: number;
}

const DEFAULT_DURATION = 5000;
const MAX_VISIBLE = 3;
const MAX_HISTORY = 50;

let toastCounter = 0;

function nextToastId(): string {
  toastCounter += 1;
  return `toast-${Date.now()}-${toastCounter}`;
}

/**
 * Queued, dismissible toast state.
 *
 * - Toasts are queued and only a bounded number are visible at once, so rapid
 *   events never overlap or vanish before they can be read.
 * - Important notices are retained in a persistent history after dismissal.
 * - The hook never moves focus; consumers render a polite live region.
 */
export function useToast() {
  const [queue, setQueue] = useState<Toast[]>([]);
  const [history, setHistory] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setQueue((current) => {
        const toast = current.find((item) => item.id === id);
        if (toast?.important) {
          setHistory((prev) => [toast, ...prev].slice(0, MAX_HISTORY));
        }
        return current.filter((item) => item.id !== id);
      });
    },
    [clearTimer],
  );

  const dismissAll = useCallback(() => {
    setQueue((current) => {
      const important = current.filter((item) => item.important);
      if (important.length > 0) {
        setHistory((prev) => [...important, ...prev].slice(0, MAX_HISTORY));
      }
      return [];
    });
    timers.current.forEach((timer) => clearTimeout(timer));
    timers.current.clear();
  }, []);

  const push = useCallback(
    (message: string, options: ToastOptions = {}): string => {
      const id = nextToastId();
      const toast: Toast = {
        id,
        message,
        variant: options.variant ?? 'info',
        important: options.important ?? false,
        duration: options.duration ?? DEFAULT_DURATION,
      };
      setQueue((current) => [...current, toast]);
      return id;
    },
    [],
  );

  const clearHistory = useCallback(() => setHistory([]), []);

  // Schedule auto-dismiss only for the visible window so queued toasts keep
  // their full reading time once they surface.
  const visible = queue.slice(0, MAX_VISIBLE);
  const visibleKey = visible.map((toast) => toast.id).join('|');

  useEffect(() => {
    visible.forEach((toast) => {
      if (!toast.duration || toast.duration <= 0) return;
      if (timers.current.has(toast.id)) return;
      const timer = setTimeout(() => dismiss(toast.id), toast.duration);
      timers.current.set(toast.id, timer);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, dismiss]);

  useEffect(() => {
    const activeTimers = timers.current;
    return () => {
      activeTimers.forEach((timer) => clearTimeout(timer));
      activeTimers.clear();
    };
  }, []);

  return {
    toasts: visible,
    queuedCount: Math.max(0, queue.length - visible.length),
    history,
    push,
    dismiss,
    dismissAll,
    clearHistory,
  };
}
