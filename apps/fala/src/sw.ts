/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { buildMediaResponse } from './offline/range';
import { CACHE_NAME, chunkSource, metaKey, type CacheLike, type StoredMeta } from './offline/store';
import type { ChunkSource } from './offline/range';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// One reader per file, reused across requests so its small chunk memory helps
// the many short ranges a media element issues while seeking.
const sources = new Map<string, { verifiedAt: string; src: ChunkSource }>();

async function storedSource(path: string): Promise<ChunkSource | null> {
  const cache = (await caches.open(CACHE_NAME)) as unknown as CacheLike;
  const res = await cache.match(metaKey(path));
  if (!res) {
    sources.delete(path);
    return null;
  }
  const meta = (await res.json()) as StoredMeta;
  const known = sources.get(path);
  if (known && known.verifiedAt === meta.verifiedAt) return known.src;
  const src = chunkSource(cache, meta);
  sources.set(path, { verifiedAt: meta.verifiedAt, src });
  return src;
}

registerRoute(
  ({ url }) =>
    url.origin === self.location.origin && url.pathname.startsWith('/media/') && url.pathname !== '/media/index.json',
  async ({ request, url }) => {
    const src = await storedSource(url.pathname);
    if (src) return buildMediaResponse(src, request.headers.get('range'), request.method);
    // Re-wrap network responses so the media element sees the same kind of response
    // whether bytes come from the network or from the cache. Chromium fails the read
    // ("PIPELINE_ERROR_READ") when a source opened from a network response continues
    // with synthesized ones after the file was downloaded.
    const net = await fetch(request);
    return new Response(net.body, { status: net.status, statusText: net.statusText, headers: net.headers });
  },
  'GET',
);

registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')));
