/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { buildMediaResponse } from './offline/range';
import { CACHE_NAME, chunkSource, metaKey, parseStoredMeta, type CacheLike } from './offline/store';
import type { ChunkSource } from './offline/range';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

// No skipWaiting() here: an updated worker waits until the page asks for it (SKIP_WAITING),
// which the page does only when nothing plays and nothing is being stored. Taking over at
// once would swap the worker that streams ranges to <audio> and reload the page mid-session.
self.addEventListener('message', (event) => {
  if ((event.data as { type?: unknown } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});
// The first worker still takes control right away: media only starts once a worker controls the page.
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// One reader per file, reused across requests so its small chunk memory helps
// the many short ranges a media element issues while seeking.
const sources = new Map<string, { attempt: string; src: ChunkSource }>();

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
  const src = chunkSource(cache, meta);
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
    const src = await storedSource(url.pathname);
    if (src) return buildMediaResponse(src, request.headers.get('range'), request.method, request.headers.get('if-range'));
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
