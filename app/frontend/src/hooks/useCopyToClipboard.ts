import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyStatus = 'idle' | 'success' | 'error';

export interface UseCopyToClipboardResult {
  /** Current copy result, used for visible confirmation. */
  status: CopyStatus;
  /** True while a success/error confirmation is being shown. */
  copied: boolean;
  /**
   * Message suitable for a non-visual live region. Empty when idle.
   * Only changes when a new copy attempt produces a result, so unrelated
   * rerenders do not re-trigger the announcement.
   */
  announcement: string;
  /** Attempts to copy the given text; resolves to the resulting status. */
  copy: (text: string) => Promise<CopyStatus>;
  /** Clears the current confirmation state. */
  reset: () => void;
}

export interface UseCopyToClipboardOptions {
  /** How long the confirmation stays visible, in ms. Defaults to 2000. */
  timeout?: number;
  /** Message announced on success. */
  successMessage?: string;
  /** Message announced on failure. */
  errorMessage?: string;
}

async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }

  try {
    if (typeof document === 'undefined') {
      return false;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Reusable copy-to-clipboard control state with visible confirmation and a
 * non-visual live announcement for assistive technology.
 */
export function useCopyToClipboard(
  options: UseCopyToClipboardOptions = {},
): UseCopyToClipboardResult {
  const {
    timeout = 2000,
    successMessage = 'Copied to clipboard',
    errorMessage = 'Failed to copy to clipboard',
  } = options;

  const [status, setStatus] = useState<CopyStatus>('idle');
  const [announcement, setAnnouncement] = useState('');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const reset = useCallback(() => {
    clearTimer();
    setStatus('idle');
    setAnnouncement('');
  }, [clearTimer]);

  const copy = useCallback(
    async (text: string): Promise<CopyStatus> => {
      clearTimer();
      const ok = await writeToClipboard(text);
      const nextStatus: CopyStatus = ok ? 'success' : 'error';

      setStatus(nextStatus);
      // Announcement is derived from the copy result, not from render, so
      // unrelated rerenders do not repeat it.
      setAnnouncement(ok ? successMessage : errorMessage);

      timeoutRef.current = setTimeout(() => {
        setStatus('idle');
        setAnnouncement('');
        timeoutRef.current = null;
      }, timeout);

      return nextStatus;
    },
    [clearTimer, errorMessage, successMessage, timeout],
  );

  return {
    status,
    copied: status === 'success',
    announcement,
    copy,
    reset,
  };
}

export default useCopyToClipboard;
