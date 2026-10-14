import { DEFAULT_START_RATE, clampStartRate } from '../session/breathing';
import { isMode, type Mode } from '../offline/mediaIndex';

export const FOCUS_MINUTES = [25, 50, 90] as const;
export const RELAX_MINUTES = [5, 10, 20, 30] as const;
export const SLEEP_MINUTES = [30, 45, 60] as const;

export const MINUTES: Record<Mode, readonly number[]> = { focus: FOCUS_MINUTES, relax: RELAX_MINUTES, sleep: SLEEP_MINUTES };

export interface Prefs {
  focus: { trackId: string | null; minutes: number };
  relax: { minutes: number; startRate: number };
  sleep: { minutes: number };
  /** Last session the user started; drives the "Wznów" chip. */
  last: { mode: Mode; at: string } | null;
}

export const DEFAULT_PREFS: Prefs = {
  focus: { trackId: null, minutes: 25 },
  relax: { minutes: 10, startRate: DEFAULT_START_RATE },
  // Research default for pre-sleep music (25-60 min window, author default 45).
  sleep: { minutes: 45 },
  last: null,
};

const KEY = 'fala.prefs.v1';

const pick = (allowed: readonly number[], v: unknown, fallback: number) =>
  typeof v === 'number' && allowed.includes(v) ? v : fallback;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** Stored data is untrusted (old versions, manual edits): keep only valid values. */
export function sanitizePrefs(raw: unknown): Prefs {
  const r = obj(raw);
  const focus = obj(r.focus);
  const relax = obj(r.relax);
  const sleep = obj(r.sleep);
  const last = obj(r.last);
  return {
    focus: {
      trackId: typeof focus.trackId === 'string' ? focus.trackId : null,
      minutes: pick(FOCUS_MINUTES, focus.minutes, DEFAULT_PREFS.focus.minutes),
    },
    relax: {
      minutes: pick(RELAX_MINUTES, relax.minutes, DEFAULT_PREFS.relax.minutes),
      startRate: typeof relax.startRate === 'number' ? clampStartRate(relax.startRate) : DEFAULT_PREFS.relax.startRate,
    },
    sleep: { minutes: pick(SLEEP_MINUTES, sleep.minutes, DEFAULT_PREFS.sleep.minutes) },
    last: isMode(last.mode) && typeof last.at === 'string' ? { mode: last.mode, at: last.at } : null,
  };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

// Accessing localStorage itself can throw (blocked site data, some private modes).
function storage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadPrefs(s: StorageLike | null = storage()): Prefs {
  try {
    const raw = s?.getItem(KEY);
    return sanitizePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizePrefs(null);
  }
}

export function savePrefs(p: Prefs, s: StorageLike | null = storage()): void {
  try {
    s?.setItem(KEY, JSON.stringify(p));
  } catch {
    // Preferences are a convenience; the app works without them.
  }
}
