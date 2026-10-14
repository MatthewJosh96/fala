/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { buildMediaResponse } from './offline/range';
import {
  CACHE_NAME,
  ReaderRegistry,
  chunkSource,
  collectRetired,
  metaKey,
  parseStoredMeta,
  type CacheLike,
  type LockManagerLike,
} from './offline/store';
import type { ChunkSource } from './offline/range';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

// No skipWaiting() here: an updated worker waits until the page asks for it (SKIP_WAITING),
// which the page does only when nothing plays and nothing is being stored. Taking over at
// once would swap the worker that streams ranges to <audio> and reload the page mid-session.
self.addEventListener('message', (event) => {
  const type = (event.data as { type?: unknown } | null)?.type;
  if (type === 'SKIP_WAITING') void self.skipWaiting();
  if (type === 'FALA_BUILD') event.ports[0]?.postMessage(BUILD);
  // A page changed storage (download, removal) or lists it: free what nobody reads, then answer.
  if (type === 'FALA_GC') event.waitUntil(collect().then(() => event.ports[0]?.postMessage('done')));
});
// The first worker still takes control right away: media only starts once a worker controls the page.
clientsClaim();
cleanupOutdatedCaches();
const manifest = self.__WB_MANIFEST;
precacheAndRoute(manifest);

// Identifies this version (its asset revisions) for pages deciding about an update (app/handoff.ts).
const BUILD = (() => {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(manifest)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(36);
})();

// One reader per file, reused across requests so its small chunk memory helps
// the many short ranges a media element issues while seeking.
const sources = new Map<string, { attempt: string; src: ChunkSource }>();

/*
 * Replaced or removed copies are "retired" and freed only when no response stream reads
 * them. This worker is the only place that knows its open streams. Collection runs when its
 * last stream closes, when a page asks (FALA_GC: after a download or removal and on every
 * catalogue listing, app start included) and when a new version activates. A worker instance
 * restarted by the browser starts with no open streams (they die with the instance), but
 * 'activate' does not fire then; the pages' FALA_GC requests cover that case.
 */
let collecting: Promise<void> | null = null;
let collectAgain = false;
function collect(): Promise<void> {
  if (collecting) {
    collectAgain = true;
    return collecting;
  }
  collecting = (async () => {
    do {
      collectAgain = false;
      try {
        const cache = (await caches.open(CACHE_NAME)) as unknown as CacheLike;
        await collectRetired(cache, readers, (self.navigator.locks as unknown as LockManagerLike | undefined) ?? null);
      } catch {
        // Retried on the next stream close, page request or start-up.
      }
    } while (collectAgain);
  })().finally(() => {
    collecting = null;
  });
  return collecting;
}
const readers = new ReaderRegistry(() => void collect());
self.addEventListener('activate', (event) => event.waitUntil(collect()));

async function storedSource(path: string): Promise<ChunkSource | null> {
  const cache = (await caches.open(CACHE_NAME)) as unknown as CacheLike;
  const res = await cache.match(metaKey(path));
  const meta = res ? parseStoredMeta(await res.json().catch(() => null)) : null;
  if (!meta) {
    sources.delete(path);
    return null;
  }
  // The attempt id names the committed chunks; a re-download commits under a new one.
  const known = sources.get(path);
  if (known && known.attempt === meta.attempt) return known.src;
  const src = chunkSource(cache, meta, 3, readers);
  sources.set(path, { attempt: meta.attempt, src });
  return src;
}

// The app lives under a sub-path on GitHub Pages (/fala/); the scope is that path.
const BASE = new URL(self.registration.scope).pathname;
const MEDIA = `${BASE}media/`;

registerRoute(
  ({ url }) =>
    url.origin === self.location.origin && url.pathname.startsWith(MEDIA) && url.pathname !== `${MEDIA}index.json`,
  async ({ request, url }) => {
    // Until its stream is open, a request holds off collection of this file's retired copies.
    readers.begin(url.pathname);
    try {
      const src = await storedSource(url.pathname);
      if (src) return buildMediaResponse(src, request.headers.get('range'), request.method, request.headers.get('if-range'));
    } finally {
      readers.end(url.pathname);
    }
    // Re-wrap network responses so the media element sees the same kind of response
    // whether bytes come from the network or from the cache. Chromium fails the read
    // ("PIPELINE_ERROR_READ") when a source opened from a network response continues
    // with synthesized ones after the file was downloaded.
    const net = await fetch(request);
    return new Response(net.body, { status: net.status, statusText: net.statusText, headers: net.headers });
  },
  'GET',
);

registerRoute(new NavigationRoute(createHandlerBoundToURL(`${BASE}index.html`), { denylist: [new RegExp(`^${MEDIA}`)] }));
