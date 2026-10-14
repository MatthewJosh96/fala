import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, loadPrefs, sanitizePrefs, savePrefs } from './prefs';
import { hrefFor, parseRoute, routeMode } from './routes';

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

describe('routes', () => {
  it('maps hashes to screens and back', () => {
    expect(parseRoute('')).toBe('home');
    expect(parseRoute('#/')).toBe('home');
    expect(parseRoute('#/skupienie')).toBe('focus');
    expect(parseRoute('#/relaks/')).toBe('relax');
    expect(parseRoute('#/sen')).toBe('sleep');
    expect(parseRoute('#/informacje')).toBe('info');
    expect(parseRoute('#/pobrane')).toBe('downloads');
    expect(parseRoute('#/cokolwiek')).toBe('home');
    expect(hrefFor('sleep')).toBe('#/sen');
    expect(routeMode('relax')).toBe('relax');
    expect(routeMode('info')).toBeNull();
  });
});

describe('preferences', () => {
  it('round-trips through storage', () => {
    const s = new MemStorage();
    const p = { ...DEFAULT_PREFS, focus: { trackId: 'miekki-puls', minutes: 90 }, last: { mode: 'focus' as const, at: '2026-10-14T08:00:00Z' } };
    savePrefs(p, s);
    expect(loadPrefs(s)).toEqual(p);
  });

  it('falls back to defaults for unknown or corrupted values', () => {
    expect(sanitizePrefs({ focus: { minutes: 33, trackId: 5 }, relax: { minutes: 10, startRate: 30 }, sleep: { minutes: 45 }, last: { mode: 'party', at: 'x' } })).toEqual({
      focus: { trackId: null, minutes: 25 },
      relax: { minutes: 10, startRate: 14 },
      sleep: { minutes: 45 },
      last: null,
    });
    const s = new MemStorage();
    s.setItem('fala.prefs.v1', '{not json');
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS);
  });

  it('survives storage that throws (blocked site data)', () => {
    const throwing = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    expect(loadPrefs(throwing)).toEqual(DEFAULT_PREFS);
    expect(() => savePrefs(DEFAULT_PREFS, throwing)).not.toThrow();
    expect(loadPrefs(null)).toEqual(DEFAULT_PREFS);
  });

  it('defaults follow the brief: Minutnik 25, Relaks 10 min at 10 breaths/min, Sen 45 min', () => {
    expect(DEFAULT_PREFS).toMatchObject({ focus: { minutes: 25 }, relax: { minutes: 10, startRate: 10 }, sleep: { minutes: 45 } });
  });
});
