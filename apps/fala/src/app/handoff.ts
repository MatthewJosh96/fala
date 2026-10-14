/*
 * The stalled-takeover fallback (a reload after 10 s) may run once per waiting worker. After
 * that reload the page sees the same worker still waiting, applies again and stalls again;
 * without this guard an idle window would reload every ~10 s while another window keeps
 * playing from the old worker. The mark lives in sessionStorage (per tab, survives reloads);
 * a finished takeover (controllerchange) clears it.
 */

const KEY = 'fala.update.fallbackFor';

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sessionStore(): SessionStorageLike | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function createHandoffGuard(storage: SessionStorageLike | null = sessionStore()) {
  // Used when storage throws (blocked site data): then the guard holds for this page only.
  let memory: string | null = null;
  const read = () => {
    try {
      return storage?.getItem(KEY) ?? memory;
    } catch {
      return memory;
    }
  };
  return {
    /** True, and remembered, if the fallback has not yet been used for this waiting worker. */
    claim(workerId: string): boolean {
      if (read() === workerId) return false;
      memory = workerId;
      try {
        storage?.setItem(KEY, workerId);
      } catch {
        // memory only
      }
      return true;
    },
    reset() {
      memory = null;
      try {
        storage?.removeItem(KEY);
      } catch {
        // nothing stored
      }
    },
  };
}

export const handoffGuard = createHandoffGuard();

/** Identity of the waiting worker (its precache revisions, see sw.ts); 'unknown' if it does not answer. */
export async function waitingWorkerId(): Promise<string> {
  const waiting = (await navigator.serviceWorker?.getRegistration())?.waiting;
  if (!waiting) return 'none';
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve('unknown'), 1_000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(String(e.data));
    };
    waiting.postMessage({ type: 'FALA_BUILD' }, [channel.port2]);
  });
}
