"use client";

import { useCallback, useRef, useState } from "react";
import { createSubmissionGuard } from "@/lib/submissionGuard";

export function useApi<T>() {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const guardRef = useRef(createSubmissionGuard<T>());
  const lastResultRef = useRef<T | null>(null);
  const scopeRef = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `session-${Math.random().toString(36).slice(2)}`,
  );

  /**
   * `key` should be derived from the submitted form values. Requests with the
   * same key are single-flight and, once successful, replayed locally instead
   * of being sent again.
   */
  const callApi = useCallback(async (fn: () => Promise<T>, key?: string) => {
    const submissionKey = key ?? `${scopeRef.current}:default`;
    const attempt = guardRef.current.begin(submissionKey);

    if (attempt.status === "duplicate") {
      return lastResultRef.current ?? undefined;
    }

    if (attempt.status === "replay") {
      lastResultRef.current = attempt.value;
      setData(attempt.value);
      setError(null);
      return attempt.value;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fn();
      attempt.settle({ ok: true, value: res });
      lastResultRef.current = res;
      setData(res);
      return res;
    } catch (err: unknown) {
      attempt.settle({ ok: false });
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Something went wrong. Please try again.";
      setError(msg);
      console.error(err);
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);

  return { data, error, loading, callApi };
}
