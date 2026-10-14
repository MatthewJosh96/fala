/*
 * Static media catalogue served as media/index.json. Generated from the audio files
 * and their sidecar JSON (server/mediaIndex.ts); the app only reads it.
 * File names are relative to media/, so the same index works under any base path.
 */

export type Mode = 'focus' | 'relax' | 'sleep';
export const MODES: readonly Mode[] = ['focus', 'relax', 'sleep'];
export const INDEX_SCHEMA = 'fala-media-index/1';

/** One rendered file of a track. Tracks get more variants when "Intensywność" ships. */
export interface IndexVariant {
  id: string;
  file: string;
  /** 'none' = plain music; later e.g. 'am16' for burned-in 16 Hz modulation. */
  modulation: string;
  size: number;
  sha256: string;
  contentType: string;
  durationS?: number;
}

export interface IndexTrack {
  id: string;
  title: string;
  subtitle?: string;
  modes: Mode[];
  variants: IndexVariant[];
}

export interface MediaIndex {
  schema: typeof INDEX_SCHEMA;
  tracks: IndexTrack[];
}

export const isMode = (x: unknown): x is Mode => typeof x === 'string' && (MODES as readonly string[]).includes(x);

const isSafeFileName = (f: unknown): f is string =>
  typeof f === 'string' && f.length > 0 && !f.includes('/') && !f.includes('\\') && f !== '.' && f !== '..';

function parseVariant(v: unknown): IndexVariant | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isSafeFileName(o.file) || typeof o.size !== 'number' || typeof o.sha256 !== 'string') return null;
  return {
    id: typeof o.id === 'string' ? o.id : o.file,
    file: o.file,
    modulation: typeof o.modulation === 'string' ? o.modulation : 'none',
    size: o.size,
    sha256: o.sha256,
    contentType: typeof o.contentType === 'string' ? o.contentType : 'audio/mp4',
    durationS: typeof o.durationS === 'number' ? o.durationS : undefined,
  };
}

/** Validates untrusted JSON; drops malformed entries instead of failing the whole catalogue. */
export function parseMediaIndex(json: unknown): MediaIndex | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  if (o.schema !== INDEX_SCHEMA || !Array.isArray(o.tracks)) return null;
  const tracks: IndexTrack[] = [];
  for (const t of o.tracks) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.title !== 'string' || !Array.isArray(r.variants)) continue;
    const variants = r.variants.map(parseVariant).filter((v): v is IndexVariant => v !== null);
    if (variants.length === 0) continue;
    tracks.push({
      id: r.id,
      title: r.title,
      subtitle: typeof r.subtitle === 'string' ? r.subtitle : undefined,
      modes: Array.isArray(r.modes) ? r.modes.filter(isMode) : [],
      variants,
    });
  }
  return { schema: INDEX_SCHEMA, tracks };
}
