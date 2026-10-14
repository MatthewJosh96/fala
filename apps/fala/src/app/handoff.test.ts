import { describe, expect, it } from 'vitest';
import { createHandoffGuard } from './handoff';

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

describe('stalled-takeover fallback: one reload per waiting worker (M1)', () => {
  it('allows the fallback reload once for a worker, never again for the same one (it survives the reload)', () => {
    const storage = new MemStorage();
    expect(createHandoffGuard(storage).claim('build-a')).toBe(true);
    // After the reload: a new page, same tab storage, the same worker still waiting.
    expect(createHandoffGuard(storage).claim('build-a')).toBe(false);
    expect(createHandoffGuard(storage).claim('build-a')).toBe(false);
  });

  it('a different waiting worker gets its own fallback; a finished takeover resets the guard', () => {
    const storage = new MemStorage();
    const g = createHandoffGuard(storage);
    expect(g.claim('build-a')).toBe(true);
    expect(g.claim('build-b')).toBe(true);
    g.reset();
    expect(g.claim('build-b')).toBe(true);
  });

  it('works without storage (blocked site data): only one fallback per page', () => {
    const throwing = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      removeItem: () => undefined,
    };
    const g = createHandoffGuard(throwing);
    expect(g.claim('x')).toBe(true);
    expect(g.claim('x')).toBe(false);
  });
});
