import { isMode, parseMediaIndex, type MediaIndex, type Mode } from './mediaIndex';
import {
  listStored,
  recoverAbandoned,
  type CachesLike,
  type LockManagerLike,
  type OpenReaders,
  type StoredMeta,
  type TrackInfo,
} from './store';

export interface CatalogueFile extends TrackInfo {
  trackId: string;
  modulation: string;
  modes: Mode[];
  stored: StoredMeta | null;
}

export interface CatalogueTrack {
  id: string;
  title: string;
  subtitle?: string;
  modes: Mode[];
  files: CatalogueFile[];
}

export interface Catalogue {
  tracks: CatalogueTrack[];
  online: boolean;
}

const withSlash = (base: string) => (base.endsWith('/') ? base : `${base}/`);
export const mediaUrl = (base: string, file: string) => `${withSlash(base)}media/${encodeURIComponent(file)}`;
export const indexUrl = (base: string) => `${withSlash(base)}media/index.json`;

export function buildCatalogue(index: MediaIndex | null, stored: StoredMeta[], base: string): CatalogueTrack[] {
  const tracks: CatalogueTrack[] = [];
  const byUrl = new Map<string, CatalogueFile>();
  for (const t of index?.tracks ?? []) {
    const track: CatalogueTrack = { id: t.id, title: t.title, subtitle: t.subtitle, modes: t.modes, files: [] };
    for (const v of t.variants) {
      const file: CatalogueFile = {
        id: v.id,
        title: t.title,
        subtitle: t.subtitle,
        url: mediaUrl(base, v.file),
        size: v.size,
        sha256: v.sha256,
        contentType: v.contentType,
        durationS: v.durationS,
        trackId: t.id,
        modes: t.modes,
        modulation: v.modulation,
        stored: null,
      };
      track.files.push(file);
      byUrl.set(file.url, file);
    }
    tracks.push(track);
  }
  for (const m of stored) {
    const known = byUrl.get(m.url);
    if (known) {
      // A stored copy only counts if it is the same file the server now offers.
      if (known.sha256 === m.sha256) known.stored = m;
      continue;
    }
    // Offline, or the server no longer lists it: the stored meta is all we know.
    const modes = (m.modes ?? []).filter(isMode);
    const trackId = m.trackId ?? m.id;
    const file: CatalogueFile = { ...m, trackId, modes, modulation: m.modulation ?? 'none', stored: m };
    let track = tracks.find((t) => t.id === trackId);
    if (!track) {
      track = { id: trackId, title: m.title, subtitle: m.subtitle, modes, files: [] };
      tracks.push(track);
    }
    track.files.push(file);
    byUrl.set(m.url, file);
  }
  return tracks;
}

export const allFiles = (tracks: CatalogueTrack[]) => tracks.flatMap((t) => t.files);

export const tracksForMode = (tracks: CatalogueTrack[], mode: Mode) => tracks.filter((t) => t.modes.includes(mode));

export function pickFile(track: CatalogueTrack, modulation = 'none'): CatalogueFile | null {
  return track.files.find((f) => f.modulation === modulation) ?? track.files.find((f) => f.modulation === 'none') ?? track.files[0] ?? null;
}

export function chooseTrack(tracks: CatalogueTrack[], mode: Mode, preferredId?: string | null): CatalogueTrack | null {
  const list = tracksForMode(tracks, mode);
  return list.find((t) => t.id === preferredId) ?? list[0] ?? null;
}

async function fetchIndex(base: string, fetchFn: typeof fetch): Promise<MediaIndex | null> {
  try {
    const res = await fetchFn(indexUrl(base), { cache: 'no-store' });
    if (!res.ok) return null;
    return parseMediaIndex(await res.json());
  } catch {
    return null;
  }
}

/**
 * Server catalogue merged with what is stored offline; offline only the stored part is known.
 * Listing is also when chunks of abandoned downloads are reclaimed.
 */
export async function loadCatalogue(
  caches: CachesLike,
  base: string,
  fetchFn: typeof fetch = fetch,
  locks?: LockManagerLike | null,
  /** Only where every open reader is known (no service worker at all): also frees retired copies. */
  readers?: OpenReaders,
): Promise<Catalogue> {
  const storedNow = recoverAbandoned(caches, { locks, readers })
    .catch(() => undefined)
    .then(() => listStored(caches))
    .catch(() => []);
  const [index, stored] = await Promise.all([fetchIndex(base, fetchFn), storedNow]);
  return { tracks: buildCatalogue(index, stored, base), online: index !== null };
}
