import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendLog, readLog } from './playbackLog';
import type { PlaybackEvent } from './types';

const KEY = 'fala.playbackLog.v1';

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const ev = (i: number): PlaybackEvent => ({ at: `2026-10-14T10:00:${String(i % 60).padStart(2, '0')}Z`, type: 'play', position: i });

describe('playback log in localStorage', () => {
  let mem: MemStorage;
  beforeEach(() => {
    mem = new MemStorage();
    vi.stubGlobal('localStorage', mem);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('treats a stored value that is not a list as empty, and appending still works', () => {
    mem.setItem(KEY, '{}');
    expect(readLog()).toEqual([]);
    expect(() => appendLog(ev(1))).not.toThrow();
    expect(readLog()).toEqual([ev(1)]);
  });

  it('drops malformed entries and keeps valid ones', () => {
    const good = { ...ev(2), detail: 'koniec pliku' };
    mem.setItem(
      KEY,
      JSON.stringify([ev(1), null, 'x', 7, { at: 5, type: 'play', position: 1 }, { at: 'a', type: 'play', position: 'NaN' }, { ...ev(3), detail: 7 }, good]),
    );
    expect(readLog()).toEqual([ev(1), good]);
  });

  it('keeps only the newest 400 entries even if more were stored', () => {
    mem.setItem(KEY, JSON.stringify(Array.from({ length: 1000 }, (_, i) => ev(i))));
    const log = readLog();
    expect(log).toHaveLength(400);
    expect(log.at(-1)).toEqual(ev(999));
  });
});
