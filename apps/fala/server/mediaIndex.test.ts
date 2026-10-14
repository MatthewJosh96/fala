import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIndex, compareWithCatalogue, readCatalogueSpec, stageFromSpec, type CatalogueSpec } from './mediaIndex.ts';
import { parseMediaIndex } from '../src/offline/mediaIndex.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function dirWith(files: Record<string, string | Uint8Array>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fala-index-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return dir;
}

describe('media index generation', () => {
  it('groups variants by track, keeps catalogue order and puts the plain variant first', async () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    const c = new Uint8Array([6]);
    const dir = dirWith({
      'z.m4a': a,
      'z.json': JSON.stringify({ id: 'z', track_id: 'zz', title: 'Żółw', modes: ['sleep'], order: 0, file: 'z.m4a', size: 3, sha256: sha(a) }),
      'y-am16.m4a': b,
      'y-am16.json': JSON.stringify({ id: 'y-am16', track_id: 'y', title: 'Y', modes: ['focus'], modulation: 'am16', order: 2, file: 'y-am16.m4a', size: 2, sha256: sha(b) }),
      'y.m4a': c,
      'y.json': JSON.stringify({ id: 'y', track_id: 'y', title: 'Y', modes: ['focus', 'disco'], order: 1, file: 'y.m4a', size: 1, sha256: sha(c), duration_s: 7.5 }),
      'index.json': '{"stale": true}',
    });
    const index = await buildIndex(dir, { strict: true, verifySha: true });
    expect(index.tracks.map((t) => t.id)).toEqual(['zz', 'y']);
    expect(index.tracks[1].modes).toEqual(['focus']);
    expect(index.tracks[1].variants.map((v) => [v.id, v.modulation])).toEqual([
      ['y', 'none'],
      ['y-am16', 'am16'],
    ]);
    // What the generator writes is exactly what the app accepts.
    expect(parseMediaIndex(JSON.parse(JSON.stringify(index)))).toEqual(index);
  });

  it('strict mode fails on a size or hash mismatch, lenient mode skips the entry', async () => {
    const a = new Uint8Array([1, 2, 3]);
    const dir = dirWith({
      'a.m4a': a,
      'a.json': JSON.stringify({ file: 'a.m4a', size: 3, sha256: 'f'.repeat(64) }),
    });
    await expect(buildIndex(dir, { strict: true, verifySha: true })).rejects.toThrow(/SHA-256/);
    expect((await buildIndex(dir, { verifySha: true })).tracks).toEqual([]);
    const sizeDir = dirWith({ 'a.m4a': a, 'a.json': JSON.stringify({ file: 'a.m4a', size: 4, sha256: sha(a) }) });
    await expect(buildIndex(sizeDir, { strict: true })).rejects.toThrow(/has 3 B/);
  });

  it('stages files and writes sidecars with size, SHA-256 and duration from the catalogue spec', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fala-src-'));
    const src = path.join(root, 'render.m4a');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-c:a', 'aac', '-b:a', '64k', src]);
    const spec: CatalogueSpec = {
      schema: 'fala-catalogue/1',
      release: 'media-v1',
      tracks: [{ id: 't', title: 'Tęcza', modes: ['relax'], variants: [{ id: 't', file: 'tecza.m4a', source: 'render.m4a' }] }],
    };
    const specFile = path.join(root, 'catalogue.json');
    writeFileSync(specFile, JSON.stringify(spec));
    const out = path.join(root, 'out');
    const [sidecar] = await stageFromSpec(await readCatalogueSpec(specFile), root, out);
    const bytes = readFileSync(src);
    expect(sidecar).toMatchObject({ format: 'fala-track-v1', file: 'tecza.m4a', size: bytes.length, sha256: sha(bytes), modes: ['relax'] });
    expect(sidecar.duration_s).toBeGreaterThan(1.4);
    expect(sidecar.duration_s).toBeLessThan(1.7);
    const index = await buildIndex(out, { strict: true, verifySha: true });
    expect(index.tracks[0]).toMatchObject({ id: 't', title: 'Tęcza', variants: [{ file: 'tecza.m4a', sha256: sha(bytes) }] });
  });

  it('rejects a spec with an unknown mode or a path as file name', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fala-spec-'));
    const bad = (tracks: unknown) => {
      const f = path.join(root, `${Math.random()}.json`);
      writeFileSync(f, JSON.stringify({ schema: 'fala-catalogue/1', release: 'x', tracks }));
      return readCatalogueSpec(f);
    };
    await expect(bad([{ id: 'a', title: 'A', modes: ['party'], variants: [] }])).rejects.toThrow(/unknown mode/);
    await expect(bad([{ id: 'a', title: 'A', modes: [], variants: [{ id: 'a', file: '../a.m4a', source: 'a' }] }])).rejects.toThrow(/bare name/);
  });

  it('compares the published files with the catalogue: missing and unexpected files are reported', async () => {
    const a = new Uint8Array([1]);
    const dir = dirWith({
      'a.m4a': a,
      'a.json': JSON.stringify({ track_id: 'a', file: 'a.m4a', size: 1, sha256: sha(a) }),
      'old.m4a': a,
      'old.json': JSON.stringify({ track_id: 'old', file: 'old.m4a', size: 1, sha256: sha(a) }),
    });
    const spec: CatalogueSpec = {
      schema: 'fala-catalogue/1',
      release: 'media-v1',
      tracks: [
        { id: 'a', title: 'A', modes: ['focus'], variants: [{ id: 'a', file: 'a.m4a', source: 'x' }] },
        { id: 'b', title: 'B', modes: ['sleep'], variants: [{ id: 'b', file: 'b.m4a', source: 'y' }] },
      ],
    };
    const index = await buildIndex(dir, { strict: true, verifySha: true });
    expect(compareWithCatalogue(index, spec)).toEqual({ missing: ['b.m4a'], unexpected: ['old.m4a'] });
    spec.tracks.pop();
    spec.tracks.push({ id: 'old', title: 'Old', modes: [], variants: [{ id: 'old', file: 'old.m4a', source: 'z' }] });
    expect(compareWithCatalogue(index, spec)).toEqual({ missing: [], unexpected: [] });
  });
});
