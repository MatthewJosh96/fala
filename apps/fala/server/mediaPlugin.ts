import { createReadStream, promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';
import { parseRange } from '../src/offline/range.ts';

/*
 * Serves large media from a directory outside the build (FALA_MEDIA_DIR), so the
 * 460 MB test file is never copied into dist/ nor precached by Workbox.
 *   GET /media/index.json  -> catalogue built from the generator's sidecar JSON files
 *   GET /media/<file>      -> the file, with Range support (200/206/416)
 */

export interface CatalogueEntry {
  id: string;
  title: string;
  url: string;
  size: number;
  sha256: string;
  contentType: string;
  durationS?: number;
}

const TYPES: Record<string, string> = { '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.mp3': 'audio/mpeg' };

export async function readCatalogue(dir: string): Promise<CatalogueEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: CatalogueEntry[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const s = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      if (typeof s.file !== 'string' || typeof s.size !== 'number' || typeof s.sha256 !== 'string') continue;
      const file = path.basename(s.file);
      const stat = await fs.stat(path.join(dir, file)).catch(() => null);
      if (!stat || stat.size !== s.size) continue;
      out.push({
        id: String(s.id ?? file),
        title: String(s.title ?? file),
        url: `/media/${encodeURIComponent(file)}`,
        size: s.size,
        sha256: s.sha256,
        contentType: String(s.content_type ?? TYPES[path.extname(file)] ?? 'application/octet-stream'),
        durationS: typeof s.duration_s === 'number' ? s.duration_s : undefined,
      });
    } catch {
      // A malformed sidecar should not take the whole catalogue down.
    }
  }
  return out;
}

export function mediaHandler(dir: string) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (!url.pathname.startsWith('/media/')) return next();
    res.setHeader('Cache-Control', 'no-store');
    const rel = decodeURIComponent(url.pathname.slice('/media/'.length));
    if (rel === 'index.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(await readCatalogue(dir)));
      return;
    }
    // basename() keeps requests inside the media directory.
    const file = path.join(dir, path.basename(rel));
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const size = stat.size;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    const range = parseRange(req.headers.range, size);
    if (range.kind === 'unsatisfiable') {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }
    const start = range.kind === 'range' ? range.start : 0;
    const end = range.kind === 'range' ? range.end : size - 1;
    res.statusCode = range.kind === 'range' ? 206 : 200;
    if (range.kind === 'range') res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD' || size === 0) {
      res.end();
      return;
    }
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };
}

export function mediaPlugin(dir: string): Plugin {
  return {
    name: 'fala-media',
    configureServer(server) {
      server.middlewares.use(mediaHandler(dir));
    },
    configurePreviewServer(server) {
      server.middlewares.use(mediaHandler(dir));
    },
  };
}
