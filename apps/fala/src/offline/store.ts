import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { strongEtag, type ChunkSource } from './range';

/*
 * Offline storage of large media in Cache Storage, split into fixed-size chunks.
 *
 * Why chunks instead of one cached Response: serving a Range request from a single
 * cached entry needs `response.blob()` (what Workbox's RangeRequestsPlugin does), and
 * WebKit may materialise the whole 460 MB body in the service worker's memory for
 * every range request. With chunks a range costs at most one chunk read.
 *
 * Every download attempt writes its chunks under its own id, next to a small attempt
 * record. The meta entry is the commit: written last, only after the stored bytes were
 * read back and matched the expected size and SHA-256, and it names the attempt whose
 * chunks are the file. So "meta exists" means "verified copy", and a failed or abandoned
 * attempt can only ever delete its own chunks.
 *
 * Several pages (tabs, the installed app) share this storage. Downloads, removal and the
 * clean-up of abandoned attempts take a per-file Web Lock; without the Web Locks API only
 * this page is protected against a second attempt (other pages are not).
 */

export const CACHE_NAME = 'fala-media-v1';
export const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024;
/** Without Web Locks an attempt record this old is considered abandoned. */
const STALE_ATTEMPT_MS = 24 * 60 * 60 * 1000;

export interface TrackInfo {
  id: string;
  title: string;
  /** Same-origin path, e.g. /fala/media/fala-diag-8h.m4a */
  url: string;
  size: number;
  sha256: string;
  contentType: string;
  durationS?: number;
  // Kept in the stored meta so a downloaded file still shows up in its modes offline.
  trackId?: string;
  subtitle?: string;
  modes?: string[];
  modulation?: string;
}

export interface StoredMeta extends TrackInfo {
  chunkSize: number;
  chunkCount: number;
  /** The download attempt whose chunks hold this file. */
  attempt: string;
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

/** The part of the Web Locks API used here (navigator.locks). */
export interface LockManagerLike {
  request<T>(name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<T> | T): Promise<T>;
}

export type Progress = { phase: 'download' | 'verify'; bytes: number; total: number };

export type DownloadErrorCode = 'http' | 'size' | 'sha256' | 'readback' | 'storage' | 'aborted' | 'busy';

export class DownloadError extends Error {
  constructor(
    readonly code: DownloadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

const BUSY_MESSAGE = 'ten plik jest właśnie pobierany lub usuwany (w tym albo innym oknie aplikacji)';

const enc = (path: string) => encodeURIComponent(path);
export const metaKey = (path: string) => `/__fala/meta/${enc(path)}`;
export const chunkKey = (path: string, attempt: string, i: number) => `/__fala/chunk/${enc(path)}/${attempt}/${i}`;
export const attemptKey = (attempt: string) => `/__fala/attempt/${attempt}`;
const lockName = (path: string) => `fala-media:${path}`;

type ParsedKey =
  | { kind: 'meta'; path: string }
  | { kind: 'chunk'; path: string; attempt: string }
  | { kind: 'attempt'; attempt: string }
  | { kind: 'other' };

/** Cache keys come back as absolute URLs in browsers. */
function parseKey(url: string): ParsedKey {
  let parts: string[];
  try {
    parts = new URL(url, 'http://local').pathname.split('/');
  } catch {
    return { kind: 'other' };
  }
  if (parts[1] !== '__fala') return { kind: 'other' };
  try {
    if (parts[2] === 'meta' && parts.length === 4) return { kind: 'meta', path: decodeURIComponent(parts[3]) };
    // Chunks of the first layout had no attempt segment; they are garbage now.
    if (parts[2] === 'chunk' && parts.length >= 5) {
      return { kind: 'chunk', path: decodeURIComponent(parts[3]), attempt: parts.length === 6 ? parts[4] : '' };
    }
    if (parts[2] === 'attempt' && parts.length === 4) return { kind: 'attempt', attempt: parts[3] };
  } catch {
    // undecodable segment
  }
  return { kind: 'other' };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Stored entries are untrusted (older layouts, partial writes): accept only complete metas. */
export function parseStoredMeta(json: unknown): StoredMeta | null {
  if (!json || typeof json !== 'object') return null;
  const m = json as Record<string, unknown>;
  const ok =
    typeof m.url === 'string' &&
    typeof m.id === 'string' &&
    typeof m.title === 'string' &&
    typeof m.sha256 === 'string' &&
    typeof m.contentType === 'string' &&
    typeof m.attempt === 'string' &&
    m.attempt !== '' &&
    typeof m.verifiedAt === 'string' &&
    isNum(m.size) &&
    isNum(m.chunkSize) &&
    m.chunkSize > 0 &&
    isNum(m.chunkCount) &&
    m.chunkCount === Math.ceil((m.size as number) / (m.chunkSize as number));
  return ok ? (m as unknown as StoredMeta) : null;
}

function expectedChunkLength(meta: Pick<StoredMeta, 'size' | 'chunkSize' | 'chunkCount'>, i: number) {
  return i < meta.chunkCount - 1 ? meta.chunkSize : meta.size - meta.chunkSize * (meta.chunkCount - 1);
}

async function readJson(cache: CacheLike, key: string): Promise<unknown> {
  const res = await cache.match(key);
  if (!res) return undefined;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

async function readMeta(cache: CacheLike, path: string): Promise<StoredMeta | null> {
  return parseStoredMeta(await readJson(cache, metaKey(path)));
}

export async function getStoredMeta(caches: CachesLike, path: string): Promise<StoredMeta | null> {
  return readMeta(await caches.open(CACHE_NAME), path);
}

export async function listStored(caches: CachesLike): Promise<StoredMeta[]> {
  const cache = await caches.open(CACHE_NAME);
  const metas: StoredMeta[] = [];
  for (const k of await cache.keys()) {
    if (parseKey(k.url).kind !== 'meta') continue;
    const meta = parseStoredMeta(await readJson(cache, k.url));
    if (meta) metas.push(meta);
  }
  return metas;
}

/* ---------- locking ---------- */

// Fallback without Web Locks: protects against a second attempt in this page only.
const localBusy = new Set<string>();

function resolveLocks(locks: LockManagerLike | null | undefined): LockManagerLike | null {
  if (locks !== undefined) return locks;
  const nav = (globalThis as { navigator?: { locks?: unknown } }).navigator;
  return (nav?.locks as LockManagerLike | undefined) ?? null;
}

/** Runs fn holding the file's lock; refuses at once if another attempt or removal holds it. */
async function withTrackLock<T>(locks: LockManagerLike | null, path: string, fn: () => Promise<T>): Promise<T> {
  if (locks) {
    return locks.request(lockName(path), { ifAvailable: true }, async (lock) => {
      if (!lock) throw new DownloadError('busy', BUSY_MESSAGE);
      return fn();
    });
  }
  if (localBusy.has(path)) throw new DownloadError('busy', BUSY_MESSAGE);
  localBusy.add(path);
  try {
    return await fn();
  } finally {
    localBusy.delete(path);
  }
}

/* ---------- clean-up ---------- */

async function deleteAttempt(cache: CacheLike, path: string, attempt: string) {
  for (const k of await cache.keys()) {
    const key = parseKey(k.url);
    if (key.kind === 'chunk' && key.path === path && key.attempt === attempt) await cache.delete(k.url);
  }
  // The record goes last: chunks without a record are only ever garbage.
  await cache.delete(attemptKey(attempt));
}

/**
 * Only while holding the file's lock (so no attempt for it is running): keeps the chunks of
 * the committed copy and deletes every other chunk and attempt record of that file.
 * A meta that does not parse (older layout) is not a usable copy and goes too.
 */
async function sweepPath(cache: CacheLike, path: string) {
  const raw = await readJson(cache, metaKey(path));
  const meta = parseStoredMeta(raw);
  if (raw !== undefined && !meta) await cache.delete(metaKey(path));
  const keep = meta?.attempt;
  for (const k of await cache.keys()) {
    const key = parseKey(k.url);
    if (key.kind === 'chunk' && key.path === path && key.attempt !== keep) await cache.delete(k.url);
    if (key.kind === 'attempt') {
      const rec = (await readJson(cache, k.url)) as { path?: unknown } | null | undefined;
      if (!rec || typeof rec.path !== 'string' || rec.path === path) await cache.delete(k.url);
    }
  }
}

/**
 * Reclaims chunks of downloads whose page died (closed, killed, crashed) before it could
 * clean up. Runs at start-up and whenever the catalogue is listed; files another page is
 * working on (lock held) are skipped.
 */
export async function recoverAbandoned(caches: CachesLike, opts: { locks?: LockManagerLike | null } = {}): Promise<void> {
  const locks = resolveLocks(opts.locks);
  const cache = await caches.open(CACHE_NAME);
  const committed = new Map<string, string | null>();
  const chunkAttempts = new Map<string, Set<string>>();
  const records: { key: string; attempt: string; path?: string; startedAt?: string }[] = [];
  for (const k of await cache.keys()) {
    const key = parseKey(k.url);
    if (key.kind === 'meta') committed.set(key.path, parseStoredMeta(await readJson(cache, k.url))?.attempt ?? null);
    else if (key.kind === 'chunk') chunkAttempts.set(key.path, (chunkAttempts.get(key.path) ?? new Set()).add(key.attempt));
    else if (key.kind === 'attempt') {
      const rec = (await readJson(cache, k.url)) as { path?: unknown; startedAt?: unknown } | null | undefined;
      records.push({
        key: k.url,
        attempt: key.attempt,
        path: typeof rec?.path === 'string' ? rec.path : undefined,
        startedAt: typeof rec?.startedAt === 'string' ? rec.startedAt : undefined,
      });
    }
  }

  if (!locks) {
    // Another page may be mid-download and nothing tells us; only clearly stale attempts go.
    for (const r of records) {
      if (!r.path || localBusy.has(r.path)) continue;
      const age = r.startedAt ? Date.now() - Date.parse(r.startedAt) : Infinity;
      if (age > STALE_ATTEMPT_MS && committed.get(r.path) !== r.attempt) await deleteAttempt(cache, r.path, r.attempt);
    }
    return;
  }

  const dirty = new Set<string>();
  for (const [path, attempts] of chunkAttempts) {
    const keep = committed.get(path);
    if ([...attempts].some((a) => a !== keep)) dirty.add(path);
  }
  for (const [path, attempt] of committed) if (attempt === null) dirty.add(path);
  for (const r of records) {
    if (r.path) dirty.add(r.path);
    else await cache.delete(r.key); // a record without a file cannot belong to anything
  }
  for (const path of dirty) {
    await locks.request(lockName(path), { ifAvailable: true }, async (lock) => {
      if (lock) await sweepPath(cache, path);
    });
  }
}

/** Bytes of verified copies, and of chunks that are not part of one (downloads in progress or not yet reclaimed). */
export async function storageReport(caches: CachesLike): Promise<{ stored: number; partial: number }> {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  const committed = new Map<string, string>();
  let stored = 0;
  for (const k of keys) {
    const key = parseKey(k.url);
    if (key.kind !== 'meta') continue;
    const meta = parseStoredMeta(await readJson(cache, k.url));
    if (meta) {
      committed.set(key.path, meta.attempt);
      stored += meta.size;
    }
  }
  let partial = 0;
  for (const k of keys) {
    const key = parseKey(k.url);
    if (key.kind !== 'chunk' || committed.get(key.path) === key.attempt) continue;
    const res = await cache.match(k.url);
    if (!res) continue;
    const length = Number(res.headers.get('Content-Length'));
    partial += Number.isFinite(length) && length > 0 ? length : (await res.arrayBuffer()).byteLength;
  }
  return { stored, partial };
}

export async function removeTrack(caches: CachesLike, path: string, opts: { locks?: LockManagerLike | null } = {}): Promise<void> {
  await withTrackLock(resolveLocks(opts.locks), path, async () => {
    const cache = await caches.open(CACHE_NAME);
    // Meta first: once it is gone the service worker stops serving this file from cache.
    await cache.delete(metaKey(path));
    await sweepPath(cache, path);
  });
}

/* ---------- verification ---------- */

export async function verifyChunks(
  cache: CacheLike,
  meta: Omit<StoredMeta, 'verifiedAt'>,
  onProgress?: (p: Progress) => void,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const hasher = sha256.create();
  let total = 0;
  for (let i = 0; i < meta.chunkCount; i++) {
    const res = await cache.match(chunkKey(meta.url, meta.attempt, i));
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
  opts: { locks?: LockManagerLike | null } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    return await withTrackLock(resolveLocks(opts.locks), path, async () => {
      const cache = await caches.open(CACHE_NAME);
      const meta = await readMeta(cache, path);
      if (!meta) return { ok: false as const, reason: 'plik nie jest pobrany' };
      return verifyChunks(cache, meta, onProgress);
    });
  } catch (e) {
    if (e instanceof DownloadError && e.code === 'busy') return { ok: false, reason: e.message };
    throw e;
  }
}

/* ---------- download ---------- */

function isQuotaError(e: unknown) {
  return e instanceof Error && (e.name === 'QuotaExceededError' || /quota/i.test(e.message));
}

function newAttemptId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function downloadTrack(
  track: TrackInfo,
  opts: {
    caches: CachesLike;
    fetchFn?: typeof fetch;
    chunkSize?: number;
    onProgress?: (p: Progress) => void;
    signal?: AbortSignal;
    /** Defaults to navigator.locks; null forces the single-page fallback. */
    locks?: LockManagerLike | null;
  },
): Promise<StoredMeta> {
  const { caches, onProgress, signal } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  return withTrackLock(resolveLocks(opts.locks), track.url, async () => {
    const cache = await caches.open(CACHE_NAME);
    // Holding the lock, nothing else works on this file: leftovers of dead attempts can go.
    await sweepPath(cache, track.url);
    const attempt = newAttemptId();
    try {
      await cache.put(attemptKey(attempt), json({ path: track.url, attempt, startedAt: new Date().toISOString() }));
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
          chunkKey(track.url, attempt, index),
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
      const meta: StoredMeta = { ...track, chunkSize, chunkCount: index, attempt, verifiedAt: '' };
      const check = await verifyChunks(cache, meta, onProgress);
      if (!check.ok) throw new DownloadError('readback', `odczyt kontrolny: ${check.reason}`);
      meta.verifiedAt = new Date().toISOString();
      // Commit: from here on the service worker serves this attempt's chunks.
      await cache.put(metaKey(track.url), json(meta));
      // The previous copy (if any) and this attempt's record are now garbage.
      await sweepPath(cache, track.url);
      return meta;
    } catch (e) {
      await deleteAttempt(cache, track.url, attempt).catch(() => undefined);
      if (e instanceof DownloadError) throw e;
      if (signal?.aborted) throw new DownloadError('aborted', 'pobieranie przerwane');
      if (isQuotaError(e)) throw new DownloadError('storage', 'brak miejsca w pamięci przeglądarki');
      throw e;
    }
  });
}

/** Chunk reader for the service worker; keeps the last few chunks because media
 * elements often issue several small ranges inside one region. */
export function chunkSource(cache: CacheLike, meta: StoredMeta, keep = 3): ChunkSource {
  const recent = new Map<number, Uint8Array>();
  return {
    size: meta.size,
    chunkSize: meta.chunkSize,
    contentType: meta.contentType,
    etag: strongEtag(meta.sha256),
    async readChunk(i) {
      const hit = recent.get(i);
      if (hit) return hit;
      const res = await cache.match(chunkKey(meta.url, meta.attempt, i));
      if (!res) throw new Error(`brak porcji ${i} w pamięci podręcznej`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      recent.set(i, bytes);
      if (recent.size > keep) recent.delete(recent.keys().next().value as number);
      return bytes;
    },
  };
}
