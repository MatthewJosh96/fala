import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CACHE_NAME,
  DownloadError,
  chunkKey,
  chunkSource,
  downloadTrack,
  getStoredMeta,
  listStored,
  metaKey,
  removeTrack,
  verifyStored,
  type Progress,
  type TrackInfo,
} from './store';
import { buildMediaResponse } from './range';
import { FakeCaches, pseudoRandomBytes, streamingResponse } from '../test/fakeCaches';

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
      stored.push(new Uint8Array(await (await cache.match(chunkKey(track.url, i)))!.arrayBuffer()));
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
    await cache.put(chunkKey(track.url, 99), new Response(new Uint8Array(5)));
    await downloadTrack(track, { caches, fetchFn: fetchOf(bytes), chunkSize: CHUNK });
    expect(await cache.match(chunkKey(track.url, 99))).toBeUndefined();
  });
});

describe('verifyStored and removeTrack', () => {
  it('detects a corrupted or missing chunk after download', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    await downloadTrack(track, { caches, fetchFn: fetchOf(bytes), chunkSize: CHUNK });
    const cache = await caches.open(CACHE_NAME);
    const entry = cache.entries.get(chunkKey(track.url, 2))!;
    entry.body = entry.body.slice();
    entry.body[123] ^= 0xff;
    expect(await verifyStored(caches, track.url)).toEqual({ ok: false, reason: 'SHA-256 niezgodny' });
    await cache.delete(chunkKey(track.url, 4));
    expect(await verifyStored(caches, track.url)).toEqual({ ok: false, reason: 'brak porcji 4' });
  });

  it('removes meta and every chunk', async () => {
    const { bytes, track } = fixture();
    const caches = new FakeCaches();
    await downloadTrack(track, { caches, fetchFn: fetchOf(bytes), chunkSize: CHUNK });
    await removeTrack(caches, track.url);
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
