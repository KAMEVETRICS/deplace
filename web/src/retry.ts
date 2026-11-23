/** Pauses after the 1st, 2nd, 3rd, 4th failure, then every 30 s. */
const DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(id);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const id = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/**
 * Calls `load` until it succeeds, waiting longer after each failure (2, 4, 8, 16, then
 * every 30 s), so a board that was briefly unreachable when the page opened still loads.
 * Resolves `undefined` once `signal` aborts.
 */
export async function untilLoaded<T>(
  load: () => Promise<T>,
  o: { signal: AbortSignal; onError?: (e: unknown, attempt: number) => void; sleep?: (ms: number, signal: AbortSignal) => Promise<void> },
): Promise<T | undefined> {
  const sleep = o.sleep ?? pause;
  for (let attempt = 1; ; attempt++) {
    if (o.signal.aborted) return undefined;
    try {
      const value = await load();
      return o.signal.aborted ? undefined : value;
    } catch (e) {
      if (o.signal.aborted) return undefined;
      o.onError?.(e, attempt);
      await sleep(DELAYS_MS[Math.min(attempt - 1, DELAYS_MS.length - 1)]!, o.signal);
    }
  }
}
