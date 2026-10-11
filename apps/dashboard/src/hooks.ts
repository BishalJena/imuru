import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Loads data, optionally polling; `reload` refetches on demand. Changing a
 * value in `deps` refetches immediately, and a response that arrives after a
 * newer request was started is dropped, so slow requests never overwrite
 * fresher data.
 */
export function useLoad<T>(load: () => Promise<T>, pollMs?: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const loader = useRef(load);
  loader.current = load;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const value = await loader.current();
      if (mine !== seq.current) return;
      setData(value);
      setError(undefined);
    } catch (err) {
      if (mine === seq.current) setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    if (!pollMs) return;
    const t = setInterval(() => void reload(), pollMs);
    return () => clearInterval(t);
  }, [reload, pollMs, ...deps]); // deps is the caller's refetch key

  return { data, error, reload };
}

/** Runs a user action and keeps its failure as a message instead of an unhandled rejection. */
export function useAction() {
  const [actionError, setActionError] = useState<string>();
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      setActionError(undefined);
      await fn();
    } catch (err) {
      setActionError((err as Error).message);
    }
  }, []);
  return { run, actionError, clearActionError: () => setActionError(undefined) };
}

export const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");
