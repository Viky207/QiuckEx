"use client";

import { useCallback, useEffect, useState } from "react";

const ADMIN_API_KEY_STORAGE = "quickex.adminApiKey";

export function useAdminAuth() {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [isPrompting, setIsPrompting] = useState(false);

  // Check for stored API key on mount
  useEffect(() => {
    const storedKey = typeof window !== "undefined" 
      ? window.sessionStorage.getItem(ADMIN_API_KEY_STORAGE)
      : null;
    setApiKey(storedKey);
  }, []);

  const saveApiKey = useCallback((key: string) => {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(ADMIN_API_KEY_STORAGE, key);
    }
    setApiKey(key);
    setIsPrompting(false);
  }, []);

  const clearApiKey = useCallback(() => {
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(ADMIN_API_KEY_STORAGE);
    }
    setApiKey(null);
  }, []);

  const getHeaders = useCallback((): HeadersInit => {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["X-API-Key"] = apiKey;
    }
    return headers;
  }, [apiKey]);

  return {
    apiKey,
    setIsPrompting,
    isPrompting,
    saveApiKey,
    clearApiKey,
    getHeaders,
  };
}
