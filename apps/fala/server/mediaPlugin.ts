import { createReadStream, promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';
import { parseRange } from '../src/offline/range.ts';
import { buildIndex, contentTypeFor } from './mediaIndex.ts';

/*
 * Serves media from a directory outside the build (FALA_MEDIA_DIR), so large files are
 * never copied into dist/ nor precached by Workbox. Mirrors what GitHub Pages serves:
 *   GET <base>media/index.json  -> catalogue generated from the sidecar JSON files
 *   GET <base>media/<file>      -> the file, with Range support (200/206/416)
 */

export function mediaHandler(dir: string, base = '/') {
  const prefix = `${base.endsWith('/') ? base : `${base}/`}media/`;
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (!url.pathname.startsWith(prefix)) return next();
    res.setHeader('Cache-Control', 'no-store');
    const rel = decodeURIComponent(url.pathname.slice(prefix.length));
    if (rel === 'index.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(await buildIndex(dir)));
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
    res.setHeader('Content-Type', contentTypeFor(file));
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

export function mediaPlugin(dir: string, base: string): Plugin {
  return {
    name: 'fala-media',
    configureServer(server) {
      server.middlewares.use(mediaHandler(dir, base));
    },
    configurePreviewServer(server) {
      server.middlewares.use(mediaHandler(dir, base));
    },
  };
}
