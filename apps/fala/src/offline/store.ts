import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ChunkSource } from './range';

/*
 * Offline storage of large media in Cache Storage, split into fixed-size chunks.
 *
 * Why chunks instead of one cached Response: serving a Range request from a single
 * cached entry needs `response.blob()` (what Workbox's RangeRequestsPlugin does), and
 * WebKit may materialise the whole 460 MB body in the service worker's memory for
 * every range request. With chunks a range costs at most one chunk read.
 *
 * The meta entry is written last, only after the stored bytes were read back and
 * matched the expected size and SHA-256, so "meta exists" means "verified copy".
 */

export const CACHE_NAME = 'fala-media-v1';
export const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024;

export interface TrackInfo {
  id: string;
  title: string;
  /** Same-origin path, e.g. /media/fala-diag-8h.m4a */
  url: string;
  size: number;
  sha256: string;
  contentType: string;
  durationS?: number;
}

export interface StoredMeta extends TrackInfo {
  chunkSize: number;
  chunkCount: number;
  verifiedAt: string;
}

export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<ReadonlyArray<{ url: string }>>;
}

export interface CachesLike {
  open(name: string): Promise<CacheLike>;
}

export type Progress = { phase: 'download' | 'verify'; bytes: number; total: number };

export type DownloadErrorCode = 'http' | 'size' | 'sha256' | 'readback' | 'storage' | 'aborted';

export class DownloadError extends Error {
  constructor(
    readonly code: DownloadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

const enc = (path: string) => encodeURIComponent(path);
export const metaKey = (path: string) => `/__fala/meta/${enc(path)}`;
export const chunkKey = (path: string, i: number) => `/__fala/chunk/${enc(path)}/${i}`;
const chunkPrefix = (path: string) => `/__fala/chunk/${enc(path)}/`;

function expectedChunkLength(meta: Pick<StoredMeta, 'size' | 'chunkSize' | 'chunkCount'>, i: number) {
  return i < meta.chunkCount - 1 ? meta.chunkSize : meta.size - meta.chunkSize * (meta.chunkCount - 1);
}

export async function getStoredMeta(caches: CachesLike, path: string): Promise<StoredMeta | null> {
  const cache = await caches.open(CACHE_NAME);
  const res = await cache.match(metaKey(path));
  return res ? ((await res.json()) as StoredMeta) : null;
}

export async function listStored(caches: CachesLike): Promise<StoredMeta[]> {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  const metas: StoredMeta[] = [];
  for (const k of keys) {
    if (!k.url.includes('/__fala/meta/')) continue;
    const res = await cache.match(k.url);
    if (res) metas.push((await res.json()) as StoredMeta);
  }
  return metas;
}

export async function removeTrack(caches: CachesLike, path: string): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  // Meta first: once it is gone the service worker stops serving this file from cache.
  await cache.delete(metaKey(path));
  const prefix = chunkPrefix(path);
  for (const k of await cache.keys()) {
    if (k.url.includes(prefix)) await cache.delete(k.url);
  }
}

export async function verifyChunks(
  cache: CacheLike,
  meta: Omit<StoredMeta, 'verifiedAt'>,
  onProgress?: (p: Progress) => void,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const hasher = sha256.create();
  let total = 0;
  for (let i = 0; i < meta.chunkCount; i++) {
    const res = await cache.match(chunkKey(meta.url, i));
    if (!res) return { ok: false, reason: `brak porcji ${i}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length !== expectedChunkLength(meta, i)) {
      return { ok: false, reason: `porcja ${i} ma ${bytes.length} B` };
    }
    hasher.update(bytes);
    total += bytes.length;
    onProgress?.({ phase: 'verify', bytes: total, total: meta.size });
  }
  if (total !== meta.size) return { ok: false, reason: `rozmiar ${total} ≠ ${meta.size}` };
  const digest = bytesToHex(hasher.digest());
  if (digest !== meta.sha256.toLowerCase()) return { ok: false, reason: 'SHA-256 niezgodny' };
  return { ok: true };
}

export async function verifyStored(
  caches: CachesLike,
  path: string,
  onProgress?: (p: Progress) => void,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const meta = await getStoredMeta(caches, path);
  if (!meta) return { ok: false, reason: 'plik nie jest pobrany' };
  const cache = await caches.open(CACHE_NAME);
  return verifyChunks(cache, meta, onProgress);
}

function isQuotaError(e: unknown) {
  return e instanceof Error && (e.name === 'QuotaExceededError' || /quota/i.test(e.message));
}

export async function downloadTrack(
  track: TrackInfo,
  opts: {
    caches: CachesLike;
    fetchFn?: typeof fetch;
    chunkSize?: number;
    onProgress?: (p: Progress) => void;
    signal?: AbortSignal;
  },
): Promise<StoredMeta> {
  const { caches, onProgress, signal } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const cache = await caches.open(CACHE_NAME);
  await removeTrack(caches, track.url);
  try {
    const res = await fetchFn(track.url, { cache: 'no-store', signal });
    if (res.status !== 200 || !res.body) {
      throw new DownloadError('http', `serwer zwrócił HTTP ${res.status}`);
    }
    const hasher = sha256.create();
    const reader = res.body.getReader();
    let buf = new Uint8Array(chunkSize);
    let fill = 0;
    let index = 0;
    let total = 0;
    const flush = async (bytes: Uint8Array<ArrayBuffer>) => {
      await cache.put(
        chunkKey(track.url, index),
        new Response(bytes, {
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
        }),
      );
      index++;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      // Stop early instead of filling storage with a file that cannot verify.
      if (total > track.size) {
        await reader.cancel();
        throw new DownloadError('size', `plik większy niż oczekiwane ${track.size} B`);
      }
      hasher.update(value);
      let off = 0;
      while (off < value.length) {
        const n = Math.min(chunkSize - fill, value.length - off);
        buf.set(value.subarray(off, off + n), fill);
        fill += n;
        off += n;
        if (fill === chunkSize) {
          await flush(buf);
          buf = new Uint8Array(chunkSize);
          fill = 0;
        }
      }
      onProgress?.({ phase: 'download', bytes: total, total: track.size });
    }
    if (fill > 0) await flush(buf.slice(0, fill));
    if (total !== track.size) {
      throw new DownloadError('size', `pobrano ${total} B, oczekiwano ${track.size} B`);
    }
    if (bytesToHex(hasher.digest()) !== track.sha256.toLowerCase()) {
      throw new DownloadError('sha256', 'SHA-256 pobranego pliku niezgodny');
    }
    const meta: StoredMeta = { ...track, chunkSize, chunkCount: index, verifiedAt: '' };
    const check = await verifyChunks(cache, meta, onProgress);
    if (!check.ok) throw new DownloadError('readback', `odczyt kontrolny: ${check.reason}`);
    meta.verifiedAt = new Date().toISOString();
    await cache.put(
      metaKey(track.url),
      new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }),
    );
    return meta;
  } catch (e) {
    await removeTrack(caches, track.url).catch(() => undefined);
    if (e instanceof DownloadError) throw e;
    if (signal?.aborted) throw new DownloadError('aborted', 'pobieranie przerwane');
    if (isQuotaError(e)) throw new DownloadError('storage', 'brak miejsca w pamięci przeglądarki');
    throw e;
  }
}

/** Chunk reader for the service worker; keeps the last few chunks because media
 * elements often issue several small ranges inside one region. */
export function chunkSource(cache: CacheLike, meta: StoredMeta, keep = 3): ChunkSource {
  const recent = new Map<number, Uint8Array>();
  return {
    size: meta.size,
    chunkSize: meta.chunkSize,
    contentType: meta.contentType,
    async readChunk(i) {
      const hit = recent.get(i);
      if (hit) return hit;
      const res = await cache.match(chunkKey(meta.url, i));
      if (!res) throw new Error(`brak porcji ${i} w pamięci podręcznej`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      recent.set(i, bytes);
      if (recent.size > keep) recent.delete(recent.keys().next().value as number);
      return bytes;
    },
  };
}
