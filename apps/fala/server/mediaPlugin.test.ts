import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaHandler } from './mediaPlugin.ts';
import { pseudoRandomBytes } from '../src/test/fakeCaches.ts';

let server: Server;
let base: string;
const bytes = pseudoRandomBytes(50_000, 5);

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fala-media-'));
  writeFileSync(path.join(dir, 'a.m4a'), bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(
    path.join(dir, 'a.json'),
    JSON.stringify({ id: 'a', track_id: 'a', title: 'Ą', modes: ['focus'], file: 'a.m4a', size: bytes.length, sha256, duration_s: 3 }),
  );
  // A sidecar whose size no longer matches its file must not be offered for download.
  writeFileSync(path.join(dir, 'b.m4a'), bytes.slice(0, 10));
  writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ file: 'b.m4a', size: 11, sha256 }));
  writeFileSync(path.join(dir, 'broken.json'), '{');
  const handle = mediaHandler(dir, '/fala/');
  server = createServer((req, res) => void handle(req, res, () => ((res.statusCode = 404), res.end())));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('media server under /fala/', () => {
  it('lists only consistent sidecars in the catalogue', async () => {
    const index = await (await fetch(`${base}/fala/media/index.json`)).json();
    expect(index.schema).toBe('fala-media-index/1');
    expect(index.tracks).toEqual([
      expect.objectContaining({
        id: 'a',
        title: 'Ą',
        modes: ['focus'],
        variants: [expect.objectContaining({ file: 'a.m4a', size: 50_000, contentType: 'audio/mp4', durationS: 3, modulation: 'none' })],
      }),
    ]);
  });

  it('serves full file and ranges with correct headers', async () => {
    const full = await fetch(`${base}/fala/media/a.m4a`);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);

    const part = await fetch(`${base}/fala/media/a.m4a`, { headers: { Range: 'bytes=49990-' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 49990-49999/50000');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(49_990));

    const bad = await fetch(`${base}/fala/media/a.m4a`, { headers: { Range: 'bytes=60000-' } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */50000');
  });

  it('only answers below the base path', async () => {
    expect((await fetch(`${base}/media/a.m4a`)).status).toBe(404);
  });

  it('does not leave the media directory', async () => {
    const res = await fetch(`${base}/fala/media/..%2F..%2Fetc%2Fpasswd`);
    expect(res.status).toBe(404);
  });

  it('sends validators like GitHub Pages (ETag, Last-Modified) and honours If-Range', async () => {
    const r1 = await fetch(`${base}/fala/media/a.m4a`, { headers: { Range: 'bytes=0-1' } });
    const etag = r1.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(r1.headers.get('last-modified')).toMatch(/GMT$/);
    await r1.arrayBuffer();
    const same = await fetch(`${base}/fala/media/a.m4a`, { headers: { Range: 'bytes=0-1', 'If-Range': etag! } });
    expect(same.status).toBe(206);
    await same.arrayBuffer();
    const stale = await fetch(`${base}/fala/media/a.m4a`, { headers: { Range: 'bytes=0-1', 'If-Range': '"stale"' } });
    expect(stale.status).toBe(200);
    expect((await stale.arrayBuffer()).byteLength).toBe(bytes.length);
  });
});
