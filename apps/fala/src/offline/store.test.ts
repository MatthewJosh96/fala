import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CACHE_NAME,
  DownloadError,
  chunkKey,
  chunkSource,
  downloadTrack,
  getStoredMeta,
  listStored,
  metaKey,
  recoverAbandoned,
  removeTrack,
  ReaderRegistry,
  storageReport,
  verifyStored,
  type Progress,
  type TrackInfo,
} from './store';
import { buildMediaResponse } from './range';
import { loadCatalogue } from './catalogue';
import { FakeCaches, FakeLocks, gatedFetch, pseudoRandomBytes, streamingResponse } from '../test/fakeCaches';

const CHUNK = 64 * 1024;

function fixture(size = 300_001) {
  const bytes = pseudoRandomBytes(size, 3);
  const track: TrackInfo = {
    id: 'diag',
    title: 'Test',
    url: '/media/diag.m4a',
    size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentType: 'audio/mp4',
    durationS: 20,
  };
  return { bytes, track };
}

const fetchOf = (bytes: Uint8Array, status = 200) =>
  (async () => (status === 200 ? streamingResponse(bytes) : new Response('nope', { status }))) as unknown as typeof fetch;

describe('downloadTrack', () => {
  it('stores the file in chunks, verifies it and writes meta last', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    const progress: Progress[] = [];
    const meta = await downloadTrack(track, {
      caches,
      fetchFn: fetchOf(bytes),
      chunkSize: CHUNK,
      onProgress: (p) => progress.push(p),
    });
    expect(meta.chunkCount).toBe(5);
    expect(meta.verifiedAt).not.toBe('');
    const cache = await caches.open(CACHE_NAME);
    const stored = [];
    for (let i = 0; i < meta.chunkCount; i++) {
      stored.push(new Uint8Array(await (await cache.match(chunkKey(track.url, meta.attempt, i)))!.arrayBuffer()));
    }
    expect(stored.map((c) => c.length)).toEqual([CHUNK, CHUNK, CHUNK, CHUNK, 300_001 - 4 * CHUNK]);
    expect(Buffer.concat(stored)).toEqual(Buffer.from(bytes));
    expect([...cache.entries.keys()].at(-1)).toBe(metaKey(track.url));
    expect(progress.at(-1)).toEqual({ phase: 'verify', bytes: track.size, total: track.size });
    expect(progress.some((p) => p.phase === 'download')).toBe(true);
    expect(await getStoredMeta(caches, track.url)).toEqual(meta);
    expect(await listStored(caches)).toEqual([meta]);
  });

  it('handles a file that is an exact multiple of the chunk size', async () => {
    const { bytes, track } = fixture(CHUNK * 3);
    const caches = new FakeCaches();
    const meta = await downloadTrack(track, { caches, fetchFn: fetchOf(bytes), chunkSize: CHUNK });
    expect(meta.chunkCount).toBe(3);
    expect(await verifyStored(caches, track.url)).toEqual({ ok: true });
  });

  it('rejects a wrong SHA-256 and leaves nothing behind', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    const bad = { ...track, sha256: '0'.repeat(64) };
    await expect(downloadTrack(bad, { caches, fetchFn: fetchOf(bytes), chunkSize: CHUNK })).rejects.toMatchObject({
      code: 'sha256',
    });
    expect((await caches.open(CACHE_NAME)).entries.size).toBe(0);
  });

  it('rejects a short file (size mismatch) and cleans up', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    await expect(
      downloadTrack(track, { caches, fetchFn: fetchOf(bytes.slice(0, -1)), chunkSize: CHUNK }),
    ).rejects.toMatchObject({ code: 'size' });
    expect((await caches.open(CACHE_NAME)).entries.size).toBe(0);
  });

  it('stops early when the server sends more bytes than expected', async () => {
    const { track } = fixture();
    const caches = new FakeCaches();
    const longer = pseudoRandomBytes(track.size * 3, 9);
    await expect(downloadTrack(track, { caches, fetchFn: fetchOf(longer), chunkSize: CHUNK })).rejects.toMatchObject({
      code: 'size',
    });
    const cache = await caches.open(CACHE_NAME);
    expect(cache.puts).toBeLessThanOrEqual(Math.ceil(track.size / CHUNK) + 1);
    expect(cache.entries.size).toBe(0);
  });

  it('reports HTTP errors', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    await expect(downloadTrack(track, { caches, fetchFn: fetchOf(bytes, 404), chunkSize: CHUNK })).rejects.toThrow(
      DownloadError,
    );
  });

  it('maps a quota failure to a storage error and cleans up', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    (await caches.open(CACHE_NAME)).failPutAfter = 2;
    await expect(downloadTrack(track, { caches, fetchFn: fetchOf(bytes), chunkSize: CHUNK })).rejects.toMatchObject({
      code: 'storage',
    });
    expect((await caches.open(CACHE_NAME)).entries.size).toBe(0);
  });

  it('replaces leftovers of an interrupted download before starting', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    const cache = await caches.open(CACHE_NAME);
    // A chunk in the first storage layout (no attempt id) and one of a dead attempt.
    const legacy = `/__fala/chunk/${encodeURIComponent(track.url)}/99`;
    await cache.put(legacy, new Response(new Uint8Array(5)));
    await cache.put(chunkKey(track.url, 'dead', 0), new Response(new Uint8Array(5)));
    await downloadTrack(track, { caches, fetchFn: fetchOf(bytes), chunkSize: CHUNK });
    expect(await cache.match(legacy)).toBeUndefined();
    expect(await cache.match(chunkKey(track.url, 'dead', 0))).toBeUndefined();
    expect(await verifyStored(caches, track.url)).toEqual({ ok: true });
  });
});

describe('verifyStored and removeTrack', () => {
  it('detects a corrupted or missing chunk after download', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    const meta = await downloadTrack(track, { caches, fetchFn: fetchOf(bytes), chunkSize: CHUNK });
    const cache = await caches.open(CACHE_NAME);
    const entry = cache.entries.get(chunkKey(track.url, meta.attempt, 2))!;
    entry.body = entry.body.slice();
    entry.body[123] ^= 0xff;
    expect(await verifyStored(caches, track.url)).toEqual({ ok: false, reason: 'SHA-256 niezgodny' });
    await cache.delete(chunkKey(track.url, meta.attempt, 4));
    expect(await verifyStored(caches, track.url)).toEqual({ ok: false, reason: 'brak porcji 4' });
  });

  it('removes meta and every chunk', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    await downloadTrack(track, { caches, fetchFn: fetchOf(bytes), chunkSize: CHUNK });
    await removeTrack(caches, track.url);
    // The bytes are retired, then freed once no response reads them (the service worker's job).
    await recoverAbandoned(caches, { readers: { isOpen: () => false } });
    expect((await caches.open(CACHE_NAME)).entries.size).toBe(0);
    expect(await getStoredMeta(caches, track.url)).toBeNull();
    expect(await verifyStored(caches, track.url)).toEqual({ ok: false, reason: 'plik nie jest pobrany' });
  });
});

describe('serving stored chunks', () => {
  it('returns the exact bytes for ranges across chunk boundaries', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    const meta = await downloadTrack(track, { caches, fetchFn: fetchOf(bytes), chunkSize: CHUNK });
    const src = chunkSource(await caches.open(CACHE_NAME), meta);
    for (const [a, b] of [
      [0, 1],
      [CHUNK - 10, CHUNK + 9],
      [CHUNK * 2, CHUNK * 4 + 5],
      [track.size - 3, track.size - 1],
    ]) {
      const res = buildMediaResponse(src, `bytes=${a}-${b}`);
      expect(res.status).toBe(206);
      expect(res.headers.get('Content-Range')).toBe(`bytes ${a}-${b}/${track.size}`);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(a, b + 1));
    }
    const full = buildMediaResponse(src, null);
    expect(createHash('sha256').update(new Uint8Array(await full.arrayBuffer())).digest('hex')).toBe(track.sha256);
  });
});

const keysFor = async (caches: FakeCaches, url: string) =>
  [...(await caches.open(CACHE_NAME)).entries.keys()].filter((k) => k.includes(encodeURIComponent(url)));

const noIndex = (async () => new Response('offline', { status: 503 })) as unknown as typeof fetch;

describe('several pages at once (Web Locks)', () => {
  it('a failing re-download never deletes the verified copy', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    const locks = new FakeLocks();
    await downloadTrack(track, { caches, locks, fetchFn: fetchOf(bytes), chunkSize: CHUNK });
    const wrong = { ...track, sha256: '0'.repeat(64) };
    await expect(downloadTrack(wrong, { caches, locks, fetchFn: fetchOf(bytes), chunkSize: CHUNK })).rejects.toMatchObject({
      code: 'sha256',
    });
    expect(await verifyStored(caches, track.url)).toEqual({ ok: true });
    expect(await listStored(caches)).toHaveLength(1);
  });

  it('refuses a second download and a removal of the same file while one is running', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    const locks = new FakeLocks();
    const gate = gatedFetch(bytes, CHUNK + 10);
    const first = downloadTrack(track, { caches, locks, fetchFn: gate.fetchFn, chunkSize: CHUNK });
    await vi.waitFor(() => expect(gate.calls()).toBe(1));
    await expect(downloadTrack(track, { caches, locks, fetchFn: fetchOf(bytes), chunkSize: CHUNK })).rejects.toMatchObject({
      code: 'busy',
    });
    await expect(removeTrack(caches, track.url, { locks })).rejects.toMatchObject({ code: 'busy' });
    gate.open();
    await first;
    expect(await verifyStored(caches, track.url)).toEqual({ ok: true });
    await removeTrack(caches, track.url, { locks });
    await recoverAbandoned(caches, { locks, readers: { isOpen: () => false } });
    expect((await caches.open(CACHE_NAME)).entries.size).toBe(0);
  });

  it('without the Web Locks API a second attempt in the same page is refused (documented limit: other tabs are not)', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    const gate = gatedFetch(bytes, CHUNK + 10);
    const first = downloadTrack(track, { caches, locks: null, fetchFn: gate.fetchFn, chunkSize: CHUNK });
    await vi.waitFor(() => expect(gate.calls()).toBe(1));
    await expect(downloadTrack(track, { caches, locks: null, fetchFn: fetchOf(bytes), chunkSize: CHUNK })).rejects.toMatchObject({
      code: 'busy',
    });
    await expect(removeTrack(caches, track.url, { locks: null })).rejects.toMatchObject({ code: 'busy' });
    gate.open();
    await first;
    expect(await verifyStored(caches, track.url)).toEqual({ ok: true });
  });
});

describe('abandoned downloads', () => {
  it('chunks of a download whose page died are reclaimed when the catalogue is listed', async () => {
    const a = fixture();
    const b = { bytes: pseudoRandomBytes(200_000, 5), track: { ...fixture().track, id: 'other', url: '/media/other.m4a' } };
    b.track.size = b.bytes.length;
    b.track.sha256 = createHash('sha256').update(b.bytes).digest('hex');
    const caches = new FakeCaches();
    const locks = new FakeLocks();
    await downloadTrack(b.track, { caches, locks, fetchFn: fetchOf(b.bytes), chunkSize: CHUNK });

    const gate = gatedFetch(a.bytes, 2 * CHUNK + 10);
    void downloadTrack(a.track, { caches, locks, fetchFn: gate.fetchFn, chunkSize: CHUNK });
    await vi.waitFor(async () => expect((await keysFor(caches, a.track.url)).length).toBeGreaterThanOrEqual(2));
    locks.crash(); // the page doing the download is gone; its transfer never finishes

    await loadCatalogue(caches, '/', noIndex, locks);
    expect(await keysFor(caches, a.track.url)).toEqual([]);
    expect(await verifyStored(caches, b.track.url)).toEqual({ ok: true });
    expect(await storageReport(caches)).toEqual({ stored: b.track.size, partial: 0 });
  });

  it('listing never touches a download that another page is still running, and reports its bytes as partial', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    const locks = new FakeLocks();
    const gate = gatedFetch(bytes, 2 * CHUNK + 10);
    const running = downloadTrack(track, { caches, locks, fetchFn: gate.fetchFn, chunkSize: CHUNK });
    await vi.waitFor(async () => expect((await keysFor(caches, track.url)).length).toBeGreaterThanOrEqual(2));

    await loadCatalogue(caches, '/', noIndex, locks);
    expect(await storageReport(caches)).toEqual({ stored: 0, partial: 2 * CHUNK });

    gate.open();
    await running;
    expect(await verifyStored(caches, track.url)).toEqual({ ok: true });
    expect(await storageReport(caches)).toEqual({ stored: track.size, partial: 0 });
  });
});

/** What the service worker knows: open response streams per attempt (test stand-in). */
function openReaders() {
  const open = new Map<string, number>();
  return {
    retain(attempt: string) {
      open.set(attempt, (open.get(attempt) ?? 0) + 1);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        open.set(attempt, open.get(attempt)! - 1);
      };
    },
    isOpen: (attempt: string) => (open.get(attempt) ?? 0) > 0,
  };
}

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>, first: Uint8Array[] = []) {
  const parts = [...first];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts);
    parts.push(value);
  }
}

describe('commit and generations (re-review)', () => {
  it('a clean-up failure after the commit never destroys the committed copy (R1)', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    const locks = new FakeLocks();
    const cache = await caches.open(CACHE_NAME);
    cache.failDelete = (k) => k.includes('/__fala/attempt/');
    await downloadTrack(track, { caches, locks, fetchFn: fetchOf(bytes), chunkSize: CHUNK }).catch(() => undefined);
    expect(await verifyStored(caches, track.url)).toEqual({ ok: true });
    // The leftover record is retried at the next listing.
    await loadCatalogue(caches, '/', noIndex, locks);
    expect([...cache.entries.keys()].filter((k) => k.includes('/__fala/attempt/'))).toEqual([]);
    expect(await verifyStored(caches, track.url)).toEqual({ ok: true });
  });

  it('downloading a file whose identical copy is already stored reuses it without fetching (R2a)', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    const locks = new FakeLocks();
    const first = await downloadTrack(track, { caches, locks, fetchFn: fetchOf(bytes), chunkSize: CHUNK });
    let fetches = 0;
    const counting = (async (...args: Parameters<typeof fetch>) => {
      fetches++;
      return fetchOf(bytes)(...args);
    }) as typeof fetch;
    const again = await downloadTrack(track, { caches, locks, fetchFn: counting, chunkSize: CHUNK });
    expect(fetches).toBe(0);
    expect(again.attempt).toBe(first.attempt);
    expect(await verifyStored(caches, track.url)).toEqual({ ok: true });
  });

  it('an open Range response reads the old copy to the end while it is replaced; then it is reclaimed (R2b)', async () => {
    const v1 = fixture();
    const v2bytes = pseudoRandomBytes(v1.track.size, 77);
    const v2 = { ...v1.track, sha256: createHash('sha256').update(v2bytes).digest('hex') };
    const caches = new FakeCaches();
    const locks = new FakeLocks();
    const readers = openReaders();
    const meta1 = await downloadTrack(v1.track, { caches, locks, fetchFn: fetchOf(v1.bytes), chunkSize: CHUNK });
    const cache = await caches.open(CACHE_NAME);

    const res = buildMediaResponse(chunkSource(cache, meta1, 1, readers), 'bytes=0-');
    const reader = res.body!.getReader();
    const head = await reader.read();

    await downloadTrack(v2, { caches, locks, fetchFn: fetchOf(v2bytes), chunkSize: CHUNK });
    await loadCatalogue(caches, '/', noIndex, locks, readers); // recovery must respect the open reader
    expect(await readAll(reader, [head.value!])).toEqual(Buffer.from(v1.bytes));

    await loadCatalogue(caches, '/', noIndex, locks, readers); // reader closed: the old generation goes
    expect(await keysFor(caches, v1.track.url).then((ks) => ks.filter((k) => k.includes(meta1.attempt)))).toEqual([]);
    expect(await verifyStored(caches, v1.track.url)).toEqual({ ok: true });
    expect(await storageReport(caches)).toEqual({ stored: v1.track.size, partial: 0 });
  });

  it('removing a file never pulls the bytes from under an open response (R2b)', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    const locks = new FakeLocks();
    const readers = openReaders();
    const meta = await downloadTrack(track, { caches, locks, fetchFn: fetchOf(bytes), chunkSize: CHUNK });
    const cache = await caches.open(CACHE_NAME);
    const reader = buildMediaResponse(chunkSource(cache, meta, 1, readers), 'bytes=0-').body!.getReader();
    const head = await reader.read();

    await removeTrack(caches, track.url, { locks });
    expect(await listStored(caches)).toEqual([]);
    await loadCatalogue(caches, '/', noIndex, locks, readers);
    expect(await readAll(reader, [head.value!])).toEqual(Buffer.from(bytes));

    await loadCatalogue(caches, '/', noIndex, locks, readers);
    expect(cache.entries.size).toBe(0);
  });
});

describe('ReaderRegistry (service worker side)', () => {
  it('counts open streams per attempt and reports when the last one closes', () => {
    let idle = 0;
    const r = new ReaderRegistry(() => idle++);
    const a = r.retain('x');
    const b = r.retain('x');
    expect(r.isOpen('x')).toBe(true);
    a();
    a(); // releasing twice counts once
    expect(r.isOpen('x')).toBe(true);
    b();
    expect(r.isOpen('x')).toBe(false);
    expect(idle).toBe(1);
    r.begin('/p');
    expect(r.isPending('/p')).toBe(true);
    r.end('/p');
    expect(r.isPending('/p')).toBe(false);
  });

  it('a cancelled response stream releases its reader', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    const meta = await downloadTrack(track, { caches, fetchFn: fetchOf(bytes), chunkSize: CHUNK });
    const r = new ReaderRegistry();
    const reader = buildMediaResponse(chunkSource(await caches.open(CACHE_NAME), meta, 3, r), 'bytes=0-').body!.getReader();
    await reader.read();
    expect(r.isOpen(meta.attempt)).toBe(true);
    await reader.cancel();
    expect(r.isOpen(meta.attempt)).toBe(false);
  });
});
