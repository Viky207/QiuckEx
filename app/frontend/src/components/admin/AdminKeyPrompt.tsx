"use client";

import { useCallback, useState } from "react";
import { X } from "lucide-react";

interface AdminKeyPromptProps {
  onKeySubmit: (key: string) => void;
  onClose?: () => void;
}

export function AdminKeyPrompt({ onKeySubmit, onClose }: AdminKeyPromptProps) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!key.trim()) {
        setError("API key is required");
        return;
      }
      onKeySubmit(key.trim());
      setKey("");
      setError(null);
    },
    [key, onKeySubmit]
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-foreground">Admin API Key Required</h3>
          {onClose && (
            <button
              onClick={onClose}
              className="text-subtle hover:text-foreground transition"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        <p className="text-sm text-subtle mb-4">
          Please enter your admin API key to access admin features.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="password"
              placeholder="Paste your admin API key here"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setError(null);
              }}
              className="w-full px-3 py-2 border border-border rounded-md bg-background text-foreground placeholder-subtle focus:outline-none focus:ring-2 focus:ring-brand"
              autoFocus
            />
          </div>

          {error && (
            <p className="text-sm text-warning bg-warning-soft px-3 py-2 rounded-md">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="w-full bg-brand text-white px-4 py-2 rounded-md font-medium hover:bg-brand/90 transition"
          >
            Save & Continue
          </button>
        </form>
      </div>
    </div>
  );
}
