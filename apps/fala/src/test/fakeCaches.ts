import type { CacheLike, CachesLike } from '../offline/store';

/** In-memory Cache Storage stand-in: stores bodies as bytes, like the real one. */
export class FakeCache implements CacheLike {
  readonly entries = new Map<string, { body: Uint8Array; headers: [string, string][]; status: number }>();
  puts = 0;
  failPutAfter = Infinity;

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
