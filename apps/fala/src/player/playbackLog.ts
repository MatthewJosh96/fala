import type { PlaybackEvent } from './types';

const KEY = 'fala.playbackLog.v1';
const MAX = 400;

function toEvent(x: unknown): PlaybackEvent | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.at !== 'string' || typeof o.type !== 'string' || typeof o.position !== 'number' || !Number.isFinite(o.position)) {
    return null;
  }
  if (o.detail !== undefined && typeof o.detail !== 'string') return null;
  return o.detail === undefined ? { at: o.at, type: o.type, position: o.position } : { at: o.at, type: o.type, position: o.position, detail: o.detail };
}

/** Stored data is untrusted (older versions, manual edits): keep only well-formed events, newest MAX. */
export function readLog(): PlaybackEvent[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .map(toEvent)
      .filter((e): e is PlaybackEvent => e !== null)
      .slice(-MAX);
  } catch {
    return [];
  }
}

export function appendLog(e: PlaybackEvent): PlaybackEvent[] {
  const next = [...readLog(), e].slice(-MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage may be unavailable (private mode); the log is a convenience only.
  }
  return next;
}

export function clearLog() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
