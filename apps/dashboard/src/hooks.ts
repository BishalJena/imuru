import { useCallback, useEffect, useRef, useState } from "react";

/** Loads data, optionally polling; `reload` refetches on demand. */
export function useLoad<T>(load: () => Promise<T>, pollMs?: number) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const loader = useRef(load);
  loader.current = load;

  const reload = useCallback(async () => {
    try {
      setData(await loader.current());
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    if (!pollMs) return;
    const t = setInterval(() => void reload(), pollMs);
    return () => clearInterval(t);
  }, [reload, pollMs]);

  return { data, error, reload };
}

export const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");
