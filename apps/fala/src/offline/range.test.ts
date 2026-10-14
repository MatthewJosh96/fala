import { describe, expect, it } from 'vitest';
import { buildMediaResponse, parseRange, type ChunkSource } from './range';
import { pseudoRandomBytes } from '../test/fakeCaches';

function memorySource(bytes: Uint8Array, chunkSize: number) {
  const reads: number[] = [];
  const src: ChunkSource = {
    size: bytes.length,
    chunkSize,
    contentType: 'audio/mp4',
    async readChunk(i) {
      reads.push(i);
      return bytes.slice(i * chunkSize, (i + 1) * chunkSize);
    },
  };
  return { src, reads };
}

async function body(res: Response) {
  return new Uint8Array(await res.arrayBuffer());
}

describe('parseRange', () => {
  const size = 1000;
  it.each([
    ['bytes=0-99', { kind: 'range', start: 0, end: 99 }],
    ['bytes=0-1', { kind: 'range', start: 0, end: 1 }],
    ['bytes=500-', { kind: 'range', start: 500, end: 999 }],
    ['bytes=990-5000', { kind: 'range', start: 990, end: 999 }],
    ['bytes=-100', { kind: 'range', start: 900, end: 999 }],
    ['bytes=-5000', { kind: 'range', start: 0, end: 999 }],
    ['bytes=999-999', { kind: 'range', start: 999, end: 999 }],
    ['BYTES = 10 - 20', { kind: 'range', start: 10, end: 20 }],
  ])('%s', (header, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });

  it.each(['bytes=1000-', 'bytes=1000-1001', 'bytes=50-10', 'bytes=-0'])('%s is unsatisfiable', (h) => {
    expect(parseRange(h, size)).toEqual({ kind: 'unsatisfiable' });
  });

  it.each([null, '', 'items=0-1', 'bytes=0-1,5-6', 'bytes=-', 'bytes=a-b'])('%s is ignored', (h) => {
    expect(parseRange(h, size)).toEqual({ kind: 'none' });
  });
});

describe('buildMediaResponse', () => {
  const bytes = pseudoRandomBytes(10_000, 7);
  const chunk = 1024;

  it('serves the whole file with 200 when there is no Range', async () => {
    const { src } = memorySource(bytes, chunk);
    const res = buildMediaResponse(src, null);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('10000');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Content-Type')).toBe('audio/mp4');
    expect(res.headers.get('Content-Range')).toBeNull();
    expect(await body(res)).toEqual(bytes);
  });

  it('answers the 2-byte probe Safari sends first', async () => {
    const { src, reads } = memorySource(bytes, chunk);
    const res = buildMediaResponse(src, 'bytes=0-1');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-1/10000');
    expect(res.headers.get('Content-Length')).toBe('2');
    expect(await body(res)).toEqual(bytes.slice(0, 2));
    expect(reads).toEqual([0]);
  });

  it('serves a range spanning several chunks with exact bytes', async () => {
    const { src, reads } = memorySource(bytes, chunk);
    const res = buildMediaResponse(src, 'bytes=1000-3100');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 1000-3100/10000');
    expect(res.headers.get('Content-Length')).toBe('2101');
    expect(await body(res)).toEqual(bytes.slice(1000, 3101));
    expect(reads).toEqual([0, 1, 2, 3]);
  });

  it('serves open-ended and suffix ranges up to the last byte', async () => {
    const { src } = memorySource(bytes, chunk);
    const open = buildMediaResponse(src, 'bytes=9000-');
    expect(open.headers.get('Content-Range')).toBe('bytes 9000-9999/10000');
    expect(await body(open)).toEqual(bytes.slice(9000));
    const suffix = buildMediaResponse(src, 'bytes=-17');
    expect(suffix.headers.get('Content-Range')).toBe('bytes 9983-9999/10000');
    expect(await body(suffix)).toEqual(bytes.slice(9983));
  });

  it('reads chunks lazily: a cancelled open-ended stream does not read the rest', async () => {
    const { src, reads } = memorySource(bytes, chunk);
    const res = buildMediaResponse(src, 'bytes=0-');
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(reads.length).toBeLessThanOrEqual(2);
  });

  it('returns 416 with the size for an unsatisfiable range', async () => {
    const { src } = memorySource(bytes, chunk);
    const res = buildMediaResponse(src, 'bytes=10000-');
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */10000');
  });

  it('answers HEAD without a body', async () => {
    const { src, reads } = memorySource(bytes, chunk);
    const res = buildMediaResponse(src, 'bytes=0-99', 'HEAD');
    expect(res.status).toBe(206);
    expect(res.body).toBeNull();
    expect(reads).toEqual([]);
  });

  it('errors the stream when a stored chunk is truncated', async () => {
    const src: ChunkSource = {
      size: 3000,
      chunkSize: 1024,
      contentType: 'audio/mp4',
      readChunk: async (i) => (i === 1 ? new Uint8Array(10) : new Uint8Array(1024)),
    };
    await expect(buildMediaResponse(src, 'bytes=1500-1600').arrayBuffer()).rejects.toThrow(/shorter/);
  });
});

describe('If-Range (RFC 9110 §13.1.5)', () => {
  const bytes = pseudoRandomBytes(5000, 11);
  const etag = '"sha256-abc"';
  const withTag = () => ({ ...memorySource(bytes, 1024).src, etag });

  it('serves the range when If-Range matches the strong ETag', async () => {
    const res = buildMediaResponse(withTag(), 'bytes=1-2', 'GET', etag);
    expect(res.status).toBe(206);
    expect(res.headers.get('ETag')).toBe(etag);
    expect(await body(res)).toEqual(bytes.slice(1, 3));
  });

  it.each(['"sha256-other"', 'W/"sha256-abc"', 'Tue, 14 Oct 2026 10:00:00 GMT'])(
    'If-Range %s does not match: Range is ignored and the whole file is sent',
    async (ifRange) => {
      const res = buildMediaResponse(withTag(), 'bytes=1-2', 'GET', ifRange);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Range')).toBeNull();
      expect(res.headers.get('Content-Length')).toBe('5000');
      expect(res.headers.get('ETag')).toBe(etag);
      expect(await body(res)).toEqual(bytes);
    },
  );

  it('a failed If-Range also overrides an unsatisfiable range (200, never 416)', () => {
    expect(buildMediaResponse(withTag(), 'bytes=9999-', 'GET', '"stale"').status).toBe(200);
    expect(buildMediaResponse(withTag(), 'bytes=9999-', 'GET', null).status).toBe(416);
  });

  it('without a known validator any If-Range means the whole file', () => {
    expect(buildMediaResponse(memorySource(bytes, 1024).src, 'bytes=1-2', 'GET', '"x"').status).toBe(200);
    expect(buildMediaResponse(memorySource(bytes, 1024).src, 'bytes=1-2', 'GET', null).status).toBe(206);
  });

  it('sends the ETag on 200, 206 and 416', () => {
    for (const r of [null, 'bytes=0-0', 'bytes=9999-']) {
      expect(buildMediaResponse(withTag(), r, 'GET', null).headers.get('ETag')).toBe(etag);
    }
  });
});
