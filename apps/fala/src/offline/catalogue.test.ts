import { describe, expect, it } from 'vitest';
import {
  allFiles,
  buildCatalogue,
  chooseTrack,
  indexUrl,
  loadCatalogue,
  mediaUrl,
  pickFile,
  tracksForMode,
} from './catalogue';
import { INDEX_SCHEMA, parseMediaIndex, type MediaIndex } from './mediaIndex';
import type { StoredMeta } from './store';
import { FakeCaches } from '../test/fakeCaches';
import { CACHE_NAME, metaKey } from './store';

const BASE = '/fala/';

const index: MediaIndex = {
  schema: INDEX_SCHEMA,
  tracks: [
    {
      id: 'poranne-swiatlo',
      title: 'Poranne światło',
      subtitle: 'Smyczki i fortepian',
      modes: ['focus', 'relax', 'sleep'],
      variants: [
        { id: 'poranne-swiatlo-am16', file: 'poranne-swiatlo-am16.m4a', modulation: 'am16', size: 10, sha256: 'b'.repeat(64), contentType: 'audio/mp4', durationS: 456 },
        { id: 'poranne-swiatlo', file: 'poranne-swiatlo.m4a', modulation: 'none', size: 10, sha256: 'a'.repeat(64), contentType: 'audio/mp4', durationS: 456 },
      ],
    },
    {
      id: 'miekki-puls',
      title: 'Miękki puls',
      modes: ['focus'],
      variants: [{ id: 'miekki-puls', file: 'miekki-puls.m4a', modulation: 'none', size: 20, sha256: 'c'.repeat(64), contentType: 'audio/mp4', durationS: 420 }],
    },
  ],
};

const stored = (over: Partial<StoredMeta>): StoredMeta => ({
  id: 'x',
  title: 'X',
  url: '/fala/media/x.m4a',
  size: 1,
  sha256: 'd'.repeat(64),
  contentType: 'audio/mp4',
  chunkSize: 1,
  chunkCount: 1,
  attempt: 'a1',
  verifiedAt: '2026-10-14T00:00:00.000Z',
  ...over,
});

describe('media paths under the GitHub Pages base', () => {
  it('builds media and index URLs below /fala/', () => {
    expect(mediaUrl(BASE, 'poranne-swiatlo.m4a')).toBe('/fala/media/poranne-swiatlo.m4a');
    expect(indexUrl(BASE)).toBe('/fala/media/index.json');
    expect(mediaUrl('/', 'a.m4a')).toBe('/media/a.m4a');
    expect(mediaUrl('/fala', 'a.m4a')).toBe('/fala/media/a.m4a');
    expect(mediaUrl(BASE, 'z ą.m4a')).toBe('/fala/media/z%20%C4%85.m4a');
  });
});

describe('catalogue', () => {
  it('groups variants into tracks and points every file at base/media', () => {
    const tracks = buildCatalogue(index, [], BASE);
    expect(tracks.map((t) => t.id)).toEqual(['poranne-swiatlo', 'miekki-puls']);
    expect(allFiles(tracks).map((f) => f.url)).toEqual([
      '/fala/media/poranne-swiatlo-am16.m4a',
      '/fala/media/poranne-swiatlo.m4a',
      '/fala/media/miekki-puls.m4a',
    ]);
    const f = tracks[0].files[1];
    expect(f).toMatchObject({ trackId: 'poranne-swiatlo', title: 'Poranne światło', modulation: 'none', stored: null });
    expect(f.modes).toEqual(['focus', 'relax', 'sleep']);
  });

  it('picks the plain variant by default (Intensywność does not exist yet)', () => {
    const tracks = buildCatalogue(index, [], BASE);
    expect(pickFile(tracks[0])?.id).toBe('poranne-swiatlo');
    expect(pickFile(tracks[0], 'am16')?.id).toBe('poranne-swiatlo-am16');
    expect(pickFile(tracks[1], 'am16')?.id).toBe('miekki-puls');
  });

  it('lists tracks per mode and remembers the preferred one', () => {
    const tracks = buildCatalogue(index, [], BASE);
    expect(tracksForMode(tracks, 'focus').map((t) => t.id)).toEqual(['poranne-swiatlo', 'miekki-puls']);
    expect(tracksForMode(tracks, 'relax').map((t) => t.id)).toEqual(['poranne-swiatlo']);
    expect(chooseTrack(tracks, 'focus', 'miekki-puls')?.id).toBe('miekki-puls');
    // A preference that does not fit the mode falls back to the first track of that mode.
    expect(chooseTrack(tracks, 'relax', 'miekki-puls')?.id).toBe('poranne-swiatlo');
    expect(chooseTrack(tracks, 'sleep', 'nieznany')?.id).toBe('poranne-swiatlo');
    expect(chooseTrack([], 'sleep')).toBeNull();
  });

  it('marks a file as stored only when the stored copy has the same SHA-256', () => {
    const tracks = buildCatalogue(
      index,
      [
        stored({ url: '/fala/media/poranne-swiatlo.m4a', sha256: 'a'.repeat(64) }),
        stored({ url: '/fala/media/miekki-puls.m4a', sha256: 'f'.repeat(64) }),
      ],
      BASE,
    );
    expect(pickFile(tracks[0])?.stored).not.toBeNull();
    expect(pickFile(tracks[1])?.stored).toBeNull();
  });

  it('offline: rebuilds tracks and modes from what is stored', () => {
    const tracks = buildCatalogue(
      null,
      [
        stored({
          id: 'poranne-swiatlo',
          title: 'Poranne światło',
          url: '/fala/media/poranne-swiatlo.m4a',
          trackId: 'poranne-swiatlo',
          modes: ['focus', 'relax', 'sleep', 'bogus'],
          modulation: 'none',
        }),
        stored({ id: 'fala-diag-30min', title: 'Diagnostyka', url: '/fala/media/fala-diag-30min.m4a' }),
      ],
      BASE,
    );
    expect(tracks.map((t) => [t.id, t.modes])).toEqual([
      ['poranne-swiatlo', ['focus', 'relax', 'sleep']],
      ['fala-diag-30min', []],
    ]);
    expect(tracksForMode(tracks, 'sleep').map((t) => t.id)).toEqual(['poranne-swiatlo']);
    expect(pickFile(tracks[0])?.stored).not.toBeNull();
  });

  it('loads the index from base/media/index.json and merges stored files', async () => {
    const caches = new FakeCaches();
    const cache = await caches.open(CACHE_NAME);
    const meta = stored({ url: '/fala/media/miekki-puls.m4a', sha256: 'c'.repeat(64) });
    await cache.put(metaKey(meta.url), new Response(JSON.stringify(meta)));
    const requested: string[] = [];
    const fetchFn = (async (u: string) => {
      requested.push(u);
      return new Response(JSON.stringify(index));
    }) as unknown as typeof fetch;
    const c = await loadCatalogue(caches, BASE, fetchFn);
    expect(requested).toEqual(['/fala/media/index.json']);
    expect(c.online).toBe(true);
    expect(pickFile(c.tracks[1])?.stored?.url).toBe('/fala/media/miekki-puls.m4a');

    const offline = await loadCatalogue(caches, BASE, (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);
    expect(offline.online).toBe(false);
    expect(offline.tracks).toHaveLength(1);
  });
});

describe('index validation', () => {
  it('rejects other schemas and drops unsafe or incomplete entries', () => {
    expect(parseMediaIndex([{ url: '/media/a.m4a' }])).toBeNull();
    expect(parseMediaIndex({ schema: 'x', tracks: [] })).toBeNull();
    const parsed = parseMediaIndex({
      schema: INDEX_SCHEMA,
      tracks: [
        { id: 'a', title: 'A', modes: ['focus', 'party'], variants: [{ file: '../etc/passwd', size: 1, sha256: 'a' }] },
        { id: 'b', title: 'B', modes: ['sleep'], variants: [{ file: 'b.m4a', size: 1, sha256: 'b' }] },
      ],
    });
    expect(parsed?.tracks).toEqual([
      {
        id: 'b',
        title: 'B',
        subtitle: undefined,
        modes: ['sleep'],
        variants: [{ id: 'b.m4a', file: 'b.m4a', modulation: 'none', size: 1, sha256: 'b', contentType: 'audio/mp4', durationS: undefined }],
      },
    ]);
  });
});
