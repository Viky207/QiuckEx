import { useCallback, useEffect, useRef, useState } from "react";

type CopyStatus = "idle" | "success" | "error";

export interface CopyButtonProps {
  /** Text to place on the clipboard. */
  value: string;
  /** Visible label when idle. */
  label?: string;
  /** Visible label shown after a successful copy. */
  successLabel?: string;
  /** Visible label shown after a failed copy. */
  errorLabel?: string;
  /** Optional class name for the button. */
  className?: string;
  /** Optional callback invoked with the copy result. */
  onResult?: (status: Exclude<CopyStatus, "idle">) => void;
}

async function writeToClipboard(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  throw new Error("Clipboard API unavailable");
}

/**
 * Reusable copy control with visible confirmation and a persistent live
 * announcement so assistive technology receives both success and failure.
 */
export function CopyButton({
  value,
  label = "Copy",
  successLabel = "Copied",
  errorLabel = "Copy failed",
  className,
  onResult,
}: CopyButtonProps) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const [announcement, setAnnouncement] = useState("");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) {
        clearTimeout(resetTimer.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }

    try {
      await writeToClipboard(value);
      setStatus("success");
      setAnnouncement(`${successLabel}: ${value}`);
      onResult?.("success");
    } catch {
      setStatus("error");
      setAnnouncement(errorLabel);
      onResult?.("error");
    }

    resetTimer.current = setTimeout(() => {
      setStatus("idle");
      resetTimer.current = null;
    }, 2000);
  }, [value, successLabel, errorLabel, onResult]);

  const visibleLabel =
    status === "success" ? successLabel : status === "error" ? errorLabel : label;

  return (
    <span className="copy-button">
      <button
        type="button"
        className={className}
        onClick={handleCopy}
        aria-label={label}
        data-copy-status={status}
      >
        {visibleLabel}
      </button>
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="copy-button__announcement"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {announcement}
      </span>
    </span>
  );
}

export default CopyButton;
