"use client";

import { useEffect, useState } from "react";

/** GET a JSON endpoint with loading and error state; refetches when the url changes. */
export function useApi<T>(url: string, fallbackError = "Could not load data.", reloadKey = 0): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    fetch(url, { signal: ctl.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? fallbackError);
        setData(body);
      })
      .catch((e) => { if (e.name !== "AbortError") { setData(null); setError(e.message); } })
      .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    return () => ctl.abort();
  }, [url, fallbackError, reloadKey]);
  return { data, error, loading };
}
