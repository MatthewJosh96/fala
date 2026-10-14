/**
 * Wraps an async loader so only the newest call's result is applied: an older, slower
 * call (e.g. a catalogue fetch started before the network came back) cannot overwrite
 * a newer one. cancel() stops applying anything, for unmounting.
 */
export function latestOnly<A extends unknown[], T>(fn: (...args: A) => Promise<T>, apply: (value: T) => void) {
  let seq = 0;
  let cancelled = false;
  const run = async (...args: A): Promise<void> => {
    const mine = ++seq;
    const value = await fn(...args);
    if (!cancelled && mine === seq) apply(value);
  };
  return Object.assign(run, {
    cancel() {
      cancelled = true;
    },
  });
}
