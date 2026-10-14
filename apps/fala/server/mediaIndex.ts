import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { INDEX_SCHEMA, isMode, type IndexTrack, type MediaIndex, type Mode } from '../src/offline/mediaIndex.ts';

/*
 * media/index.json is generated from the audio files and their sidecar JSON, both in
 * one directory. Used by `vite preview` (lenient: skips inconsistent entries), by the
 * Pages workflow (strict: any inconsistency fails the deploy) and by the publish script.
 * Runs under plain Node with --experimental-strip-types, so only erasable TS syntax here.
 */

export const SIDECAR_FORMAT = 'fala-track-v1';

export interface Sidecar {
  format?: string;
  id?: string;
  track_id?: string;
  title?: string;
  subtitle?: string;
  modes?: string[];
  modulation?: string;
  order?: number;
  file: string;
  content_type?: string;
  duration_s?: number;
  size: number;
  sha256: string;
}

const TYPES: Record<string, string> = { '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.mp3': 'audio/mpeg' };

export const contentTypeFor = (file: string) => TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function probeDurationS(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
      (err, stdout) => {
        if (err) return reject(err);
        const d = Number(stdout.trim());
        if (!Number.isFinite(d) || d <= 0) return reject(new Error(`ffprobe: no duration for ${file}`));
        resolve(Math.round(d * 1000) / 1000);
      },
    );
  });
}

export interface BuildOptions {
  /** Throw on the first inconsistent sidecar instead of skipping it. */
  strict?: boolean;
  /** Hash every file and compare with its sidecar (slow for the 8 h file). */
  verifySha?: boolean;
}

export async function buildIndex(dir: string, opts: BuildOptions = {}): Promise<MediaIndex> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (opts.strict) throw e;
    return { schema: INDEX_SCHEMA, tracks: [] };
  }
  const problem = (msg: string) => {
    if (opts.strict) throw new Error(msg);
  };
  const entries: { s: Sidecar; file: string }[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name === 'index.json') continue;
    let s: Sidecar;
    try {
      s = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
    } catch {
      problem(`${name}: invalid JSON`);
      continue;
    }
    if (typeof s.file !== 'string' || typeof s.size !== 'number' || typeof s.sha256 !== 'string') {
      problem(`${name}: missing file/size/sha256`);
      continue;
    }
    const file = path.basename(s.file);
    const stat = await fs.stat(path.join(dir, file)).catch(() => null);
    if (!stat || stat.size !== s.size) {
      problem(`${name}: ${file} ${stat ? `has ${stat.size} B, sidecar says ${s.size}` : 'is missing'}`);
      continue;
    }
    if (opts.verifySha && (await sha256File(path.join(dir, file))) !== s.sha256.toLowerCase()) {
      problem(`${name}: SHA-256 of ${file} does not match`);
      continue;
    }
    entries.push({ s, file });
  }

  const tracks = new Map<string, IndexTrack & { order: number }>();
  for (const { s, file } of entries) {
    const stem = file.replace(/\.[^.]+$/, '');
    const trackId = String(s.track_id ?? s.id ?? stem);
    let t = tracks.get(trackId);
    if (!t) {
      t = {
        id: trackId,
        title: String(s.title ?? stem),
        subtitle: typeof s.subtitle === 'string' ? s.subtitle : undefined,
        modes: (s.modes ?? []).filter(isMode) as Mode[],
        variants: [],
        order: typeof s.order === 'number' ? s.order : Number.MAX_SAFE_INTEGER,
      };
      tracks.set(trackId, t);
    }
    t.variants.push({
      id: String(s.id ?? stem),
      file,
      modulation: typeof s.modulation === 'string' ? s.modulation : 'none',
      size: s.size,
      sha256: s.sha256.toLowerCase(),
      contentType: String(s.content_type ?? contentTypeFor(file)),
      durationS: typeof s.duration_s === 'number' ? s.duration_s : undefined,
    });
  }
  const sorted = [...tracks.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'pl'));
  return {
    schema: INDEX_SCHEMA,
    tracks: sorted.map(({ order: _order, ...t }) => ({
      ...t,
      variants: t.variants.sort((a, b) => Number(b.modulation === 'none') - Number(a.modulation === 'none') || a.id.localeCompare(b.id)),
    })),
  };
}

/* ---------- publishing: media/catalogue.json -> files + sidecars ---------- */

export interface CatalogueSpec {
  schema: 'fala-catalogue/1';
  release: string;
  tracks: {
    id: string;
    title: string;
    subtitle?: string;
    modes: string[];
    variants: { id: string; file: string; source: string; modulation?: string }[];
  }[];
}

export async function readCatalogueSpec(file: string): Promise<CatalogueSpec> {
  const spec = JSON.parse(await fs.readFile(file, 'utf8')) as CatalogueSpec;
  if (spec.schema !== 'fala-catalogue/1' || !Array.isArray(spec.tracks)) throw new Error(`${file}: not a fala-catalogue/1 file`);
  for (const t of spec.tracks) {
    for (const m of t.modes) if (!isMode(m)) throw new Error(`${t.id}: unknown mode ${m}`);
    for (const v of t.variants) {
      if (path.basename(v.file) !== v.file) throw new Error(`${v.id}: file must be a bare name`);
    }
  }
  return spec;
}

/**
 * Physical inventory of a directory about to be published, against the catalogue: every
 * listed file present with exactly one sidecar, and nothing else (no unlisted audio, no
 * stray sidecars or other files). Sidecar contents (size, SHA-256) are checked by buildIndex.
 */
export async function inventoryProblems(dir: string, spec: CatalogueSpec): Promise<string[]> {
  const names = (await fs.readdir(dir)).sort();
  const expected = new Set(spec.tracks.flatMap((t) => t.variants.map((v) => v.file)));
  const problems: string[] = [];
  const sidecars = new Map<string, string[]>();
  for (const name of names) {
    if (name === 'index.json') continue;
    if (name.endsWith('.json')) {
      let file: unknown;
      try {
        file = (JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as { file?: unknown }).file;
      } catch {
        problems.push(`${name}: invalid JSON`);
        continue;
      }
      if (typeof file !== 'string' || !expected.has(file)) {
        problems.push(`${name}: sidecar for ${JSON.stringify(file)}, which the catalogue does not list`);
        continue;
      }
      sidecars.set(file, [...(sidecars.get(file) ?? []), name]);
      continue;
    }
    if (!expected.has(name)) problems.push(`${name}: not in the catalogue`);
  }
  for (const file of expected) {
    if (!names.includes(file)) problems.push(`${file}: missing`);
    const found = sidecars.get(file) ?? [];
    if (found.length !== 1) problems.push(`${file}: ${found.length} sidecars (${found.join(', ') || 'none'}), expected exactly one`);
  }
  return problems;
}

/** Files the catalogue lists but the index lacks, and files published without a catalogue entry. */
export function compareWithCatalogue(index: MediaIndex, spec: CatalogueSpec): { missing: string[]; unexpected: string[] } {
  const published = new Set(index.tracks.flatMap((t) => t.variants.map((v) => v.file)));
  const wanted = new Set(spec.tracks.flatMap((t) => t.variants.map((v) => v.file)));
  return {
    missing: [...wanted].filter((f) => !published.has(f)).sort(),
    unexpected: [...published].filter((f) => !wanted.has(f)).sort(),
  };
}

/**
 * Puts every published file into outDir (symlink, or copy) next to a sidecar with its
 * size, SHA-256 and duration. The sidecar is the contract the app verifies downloads against.
 */
export async function stageFromSpec(
  spec: CatalogueSpec,
  sourceRoot: string,
  outDir: string,
  opts: { copy?: boolean } = {},
): Promise<Sidecar[]> {
  await fs.mkdir(outDir, { recursive: true });
  const out: Sidecar[] = [];
  let order = 0;
  for (const t of spec.tracks) {
    for (const v of t.variants) {
      const src = path.resolve(sourceRoot, v.source);
      const real = await fs.realpath(src).catch(() => null);
      if (!real) throw new Error(`${v.id}: source ${src} not found`);
      const dest = path.join(outDir, v.file);
      await fs.rm(dest, { force: true });
      if (opts.copy) await fs.copyFile(real, dest);
      else await fs.symlink(real, dest);
      const sidecar: Sidecar = {
        format: SIDECAR_FORMAT,
        id: v.id,
        track_id: t.id,
        title: t.title,
        ...(t.subtitle ? { subtitle: t.subtitle } : {}),
        modes: t.modes,
        modulation: v.modulation ?? 'none',
        order: order++,
        file: v.file,
        content_type: contentTypeFor(v.file),
        duration_s: await probeDurationS(real),
        size: (await fs.stat(real)).size,
        sha256: await sha256File(real),
      };
      await fs.writeFile(path.join(outDir, v.file.replace(/\.[^.]+$/, '.json')), `${JSON.stringify(sidecar, null, 2)}\n`);
      out.push(sidecar);
    }
  }
  return out;
}
