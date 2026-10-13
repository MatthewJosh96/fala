import type { PlaybackEvent } from './types';

const KEY = 'fala.playbackLog.v1';
const MAX = 400;

export function readLog(): PlaybackEvent[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as PlaybackEvent[];
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
