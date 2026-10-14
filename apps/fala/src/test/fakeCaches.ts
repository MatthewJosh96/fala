import type { CacheLike, CachesLike } from '../offline/store';

/** In-memory Cache Storage stand-in: stores bodies as bytes, like the real one. */
export class FakeCache implements CacheLike {
  readonly entries = new Map<string, { body: Uint8Array; headers: [string, string][]; status: number }>();
  puts = 0;
  failPutAfter = Infinity;
  /** One-shot fault injection: the first delete of a matching key throws. */
  failDelete: ((key: string) => boolean) | null = null;

  async match(key: string) {
    const e = this.entries.get(key);
    if (!e) return undefined;
    return new Response(e.body.slice(), { status: e.status, headers: e.headers });
  }
  async put(key: string, res: Response) {
    if (this.puts >= this.failPutAfter) {
      const err = new Error('The quota has been exceeded.');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.puts++;
    const body = new Uint8Array(await res.arrayBuffer());
    this.entries.set(key, { body, headers: [...res.headers.entries()], status: res.status });
  }
  async delete(key: string) {
    if (this.failDelete?.(key)) {
      this.failDelete = null;
      throw new Error('delete failed');
    }
    return this.entries.delete(key);
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
}

export class FakeCaches implements CachesLike {
  readonly caches = new Map<string, FakeCache>();
  async open(name: string) {
    let c = this.caches.get(name);
    if (!c) {
      c = new FakeCache();
      this.caches.set(name, c);
    }
    return c;
  }
}

/** A response whose body arrives in irregular pieces, like a real network stream. */
export function streamingResponse(bytes: Uint8Array, pieces: number[] = [1, 7, 4096, 65_536, 100_003]): Response {
  let pos = 0;
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= bytes.length) {
        controller.close();
        return;
      }
      const n = pieces[i++ % pieces.length];
      controller.enqueue(bytes.slice(pos, pos + n));
      pos += n;
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'audio/mp4' } });
}

export function pseudoRandomBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/**
 * Web Locks stand-in shared by several simulated pages (one origin). Exclusive locks only.
 * crash() releases everything, as the browser does when a page dies.
 */
export class FakeLocks {
  private held = new Set<string>();
  private generation = 0;
  async request<T>(name: string, options: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => Promise<T> | T): Promise<T> {
    while (this.held.has(name)) {
      if (options.ifAvailable) return callback(null);
      await new Promise((r) => setTimeout(r, 1));
    }
    this.held.add(name);
    const gen = this.generation;
    try {
      return await callback({ name });
    } finally {
      // A crashed page's lock is already gone; do not release a lock taken after the crash.
      if (gen === this.generation) this.held.delete(name);
    }
  }
  crash() {
    this.held.clear();
    this.generation++;
  }
  isHeld(name: string) {
    return this.held.has(name);
  }
}

/** A download whose body delivers `firstBytes`, then waits until open() is called. */
export function gatedFetch(bytes: Uint8Array, firstBytes: number) {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    let sentFirst = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sentFirst) {
          sentFirst = true;
          controller.enqueue(bytes.slice(0, firstBytes));
          return;
        }
        await gate;
        controller.enqueue(bytes.slice(firstBytes));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, open, calls: () => calls };
}
