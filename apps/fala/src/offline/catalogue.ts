import { listStored, type CachesLike, type StoredMeta, type TrackInfo } from './store';

export interface CatalogueTrack extends TrackInfo {
  stored: StoredMeta | null;
}

async function fetchRemote(): Promise<TrackInfo[] | null> {
  try {
    const res = await fetch('/media/index.json', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as TrackInfo[];
  } catch {
    return null;
  }
}

/** Server catalogue merged with what is stored offline; offline only the stored part is known. */
export async function loadCatalogue(caches: CachesLike): Promise<{ tracks: CatalogueTrack[]; online: boolean }> {
  const [remote, stored] = await Promise.all([fetchRemote(), listStored(caches).catch(() => [])]);
  const byUrl = new Map<string, CatalogueTrack>();
  for (const t of remote ?? []) byUrl.set(t.url, { ...t, stored: null });
  for (const m of stored) {
    const known = byUrl.get(m.url);
    // A stored copy only counts if it is the same file the server now offers.
    if (known && known.sha256 !== m.sha256) continue;
    byUrl.set(m.url, { ...(known ?? m), stored: m });
  }
  return { tracks: [...byUrl.values()], online: remote !== null };
}
