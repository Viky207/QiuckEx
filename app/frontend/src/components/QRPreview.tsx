"use client";

import { useRef, useState } from "react";
import QRCode from "react-qr-code";
import { Download, Copy } from "lucide-react";

export type QRErrorCorrection = "L" | "M" | "Q" | "H";

interface QRPreviewProps {
  value?: string;
  errorCorrection?: QRErrorCorrection;
  logoUrl?: string;
  brandColor?: string;
  isPaymentLink?: boolean;
}

export function QRPreview({
  value,
  errorCorrection,
  logoUrl,
  brandColor = "#000000",
  isPaymentLink = false,
}: QRPreviewProps) {
  const isValid = Boolean(value);
  const qrRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  // Default to H error correction for payment links
  const effectiveErrorCorrection: QRErrorCorrection =
    errorCorrection || (isPaymentLink ? "H" : "M");

  const handleDownloadSVG = () => {
    if (!qrRef.current) return;
    const svg = qrRef.current.querySelector("svg");
    if (!svg) return;

    const svgString = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([svgString], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `qr-code-${Date.now()}.svg`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadPNG = () => {
    if (!qrRef.current) return;
    const canvas = qrRef.current.querySelector("canvas");
    if (!canvas) return;

    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    link.download = `qr-code-${Date.now()}.png`;
    link.click();
  };

  const handleCopyToClipboard = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <div className="relative group">
      <div className="absolute -inset-10 bg-indigo-500/10 blur-[60px] rounded-full opacity-50 group-hover:opacity-80 transition-opacity" />

      <div className="relative w-full aspect-square bg-gradient-to-br from-white/10 to-white/[0.02] backdrop-blur-3xl rounded-[3rem] p-1 border border-border-strong shadow-2xl overflow-hidden group-hover:scale-[1.02] transition-all duration-500">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-indigo-500/5 to-transparent h-1/2 w-full -translate-y-full hover:animate-[scan_3s_linear_infinite]" />

        <div className="h-full w-full bg-card rounded-[2.8rem] flex flex-col items-center justify-center p-12 border border-border">
          {/* QR CONTAINER */}
          <div
            ref={qrRef}
            className="relative p-6 bg-white rounded-3xl shadow-[0_0_30px_rgba(255,255,255,0.05)]"
          >
            {isValid ? (
              <div className="relative">
                <QRCode
                  value={value!}
                  size={200}
                  level={effectiveErrorCorrection}
                  bgColor="white"
                  fgColor={brandColor}
                  includeMargin={true}
                />
                {/* Logo overlay - max 15% of QR code size */}
                {logoUrl && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-12 h-12 bg-white rounded-lg flex items-center justify-center shadow-md border border-gray-200">
                      <img
                        src={logoUrl}
                        alt="Logo"
                        className="w-10 h-10 object-contain"
                      />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Placeholder */
              <div className="w-48 h-48 border-4 border-dashed border-border-strong rounded-2xl flex flex-col items-center justify-center gap-4">
                <div className="w-12 h-12 bg-background rounded-lg flex items-center justify-center">
                  <div className="w-6 h-6 bg-indigo-500 rounded-sm animate-pulse" />
                </div>
                <div className="grid grid-cols-2 gap-1 opacity-20 capitalize">
                  <div className="w-4 h-4 bg-background rounded-sm" />
                  <div className="w-4 h-4 bg-background rounded-sm" />
                  <div className="w-4 h-4 bg-background rounded-sm" />
                  <div className="w-4 h-4 bg-background rounded-sm" />
                </div>
              </div>
            )}
          </div>

          <div className="mt-10 text-center space-y-4">
            <div className="space-y-2">
              <p className="text-xs font-black text-indigo-400 tracking-[0.3em] uppercase">
                Ready to Scan
              </p>
              <p className="text-sm text-subtle font-medium">
                Point your wallet camera here
              </p>
              {isPaymentLink && (
                <p className="text-xs text-brand font-medium">
                  Error Correction: {effectiveErrorCorrection}
                </p>
              )}
            </div>

            {isValid && (
              <div className="flex gap-2 justify-center">
                <button
                  onClick={handleDownloadSVG}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs bg-brand/10 text-brand rounded-md hover:bg-brand/20 transition"
                  title="Download as SVG"
                >
                  <Download className="h-3.5 w-3.5" />
                  SVG
                </button>
                <button
                  onClick={handleDownloadPNG}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs bg-brand/10 text-brand rounded-md hover:bg-brand/20 transition"
                  title="Download as PNG"
                >
                  <Download className="h-3.5 w-3.5" />
                  PNG
                </button>
                <button
                  onClick={handleCopyToClipboard}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs bg-muted/10 text-muted rounded-md hover:bg-muted/20 transition"
                  title="Copy value to clipboard"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}