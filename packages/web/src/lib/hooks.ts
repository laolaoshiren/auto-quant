import { useCallback, useEffect, useRef, useState } from 'react';

export interface QueryState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Milliseconds epoch of the last successful load. */
  updatedAt: number | null;
  reload: () => void;
}

/**
 * Run an async loader on mount and then on an interval.
 *
 * Every fetch is abortable, so switching symbols or unmounting a trader page
 * cannot land a stale response in the UI. In-flight requests are skipped rather
 * than queued when a poll fires while the previous one is still running.
 */
export function usePolled<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  options: { intervalMs?: number; enabled?: boolean; deps?: unknown[] } = {},
): QueryState<T> {
  const { intervalMs = 0, enabled = true } = options;
  const deps = options.deps ?? [];

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let disposed = false;
    // Scoped to this effect instance on purpose. A shared instance counter would
    // deadlock the restarted effect: the previous run is still unwinding from
    // its abort while the new run checks the flag and bails out.
    let busy = false;

    const run = async () => {
      if (busy || disposed) return;
      busy = true;
      try {
        const result = await loaderRef.current(controller.signal);
        if (disposed) return;
        setData(result);
        setError(null);
        setUpdatedAt(Date.now());
      } catch (err) {
        if (disposed || (err as Error).name === 'AbortError') return;
        setError((err as Error).message);
      } finally {
        busy = false;
        if (!disposed) setLoading(false);
      }
    };

    void run();
    let timer: number | null = null;
    if (intervalMs > 0) {
      timer = window.setInterval(() => void run(), intervalMs);
    }

    return () => {
      disposed = true;
      controller.abort();
      if (timer !== null) window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, nonce, ...deps]);

  return { data, error, loading, updatedAt, reload };
}

/** Poll interval that lengthens while the socket is delivering live data. */
export function fallbackInterval(socketOpen: boolean, liveMs = 5000, idleMs = 3000): number {
  return socketOpen ? liveMs : idleMs;
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · AutoQuant`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** Copy-to-clipboard with a transient "copied" flag for the audit views. */
export function useCopy(timeoutMs = 1400): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  const copy = useCallback(
    (text: string) => {
      const done = () => {
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), timeoutMs);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(done);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        document.body.appendChild(area);
        area.select();
        try {
          document.execCommand('copy');
        } catch {
          /* nothing else we can do */
        }
        document.body.removeChild(area);
        done();
      }
    },
    [timeoutMs],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return { copied, copy };
}

/** A ticking clock for relative timestamps ("last cycle 34s ago"). */
export function useTicker(intervalMs = 1000): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return tick;
}
