export type ParsedRange =
  | { kind: 'none' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * Single-range parser for `Range: bytes=...` (RFC 9110 §14).
 * Malformed or multi-range headers are ignored (`none`), which the RFC allows:
 * the full representation is then served with 200. Media elements never send
 * multi-range requests.
 */
export function parseRange(header: string | null | undefined, size: number): ParsedRange {
  if (!header) return { kind: 'none' };
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return { kind: 'none' };
  const [, a, b] = m;
  if (a === '' && b === '') return { kind: 'none' };
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (start >= size || start > end) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end };
}

/** Random access to a stored file split into fixed-size chunks. */
export interface ChunkSource {
  size: number;
  chunkSize: number;
  contentType: string;
  /** Strong validator of these exact bytes, sent as ETag and checked against If-Range. */
  etag?: string;
  /**
   * Called when a response stream opens; the returned function when it ends, fails or is
   * cancelled. Lets the service worker keep a replaced copy until nobody reads it.
   */
  retain?(): () => void;
  readChunk(index: number): Promise<Uint8Array>;
}

/** A verified copy is identified by its SHA-256, so the hash is a strong validator. */
export const strongEtag = (sha256: string) => `"sha256-${sha256.toLowerCase()}"`;

/**
 * RFC 9110 §13.1.5: with If-Range, a Range is honoured only when the validator strongly
 * matches the current ETag. Weak tags and HTTP-dates (there is no Last-Modified) never match;
 * then the whole representation is sent with 200.
 */
function ifRangeAllows(ifRange: string | null | undefined, etag: string | undefined): boolean {
  if (ifRange == null) return true;
  const v = ifRange.trim();
  return etag !== undefined && !v.startsWith('W/') && v === etag;
}

/**
 * Lazily streams bytes [start, end] chunk by chunk, so a request for "bytes=0-"
 * of a 460 MB file never holds more than one chunk in memory.
 */
export function rangeStream(src: ChunkSource, start: number, end: number): ReadableStream<Uint8Array> {
  let pos = start;
  let release: (() => void) | undefined;
  const finish = () => {
    release?.();
    release = undefined;
  };
  return new ReadableStream<Uint8Array>({
    start() {
      release = src.retain?.();
    },
    async pull(controller) {
      try {
        if (pos > end) {
          controller.close();
          finish();
          return;
        }
        const index = Math.floor(pos / src.chunkSize);
        const chunkStart = index * src.chunkSize;
        const chunk = await src.readChunk(index);
        const from = pos - chunkStart;
        const to = Math.min(chunk.length, end - chunkStart + 1);
        if (to <= from) {
          controller.error(new Error(`chunk ${index} is shorter than expected`));
          finish();
          return;
        }
        controller.enqueue(chunk.subarray(from, to));
        pos = chunkStart + to;
      } catch (e) {
        finish();
        throw e;
      }
    },
    cancel() {
      finish();
    },
  });
}

export function buildMediaResponse(
  src: ChunkSource,
  rangeHeader: string | null,
  method = 'GET',
  ifRange: string | null = null,
): Response {
  const range: ParsedRange = ifRangeAllows(ifRange, src.etag) ? parseRange(rangeHeader, src.size) : { kind: 'none' };
  const base: Record<string, string> = {
    'Content-Type': src.contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (src.etag) base.ETag = src.etag;
  if (range.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...base, 'Content-Range': `bytes */${src.size}` },
    });
  }
  const start = range.kind === 'range' ? range.start : 0;
  const end = range.kind === 'range' ? range.end : src.size - 1;
  const headers: Record<string, string> = { ...base, 'Content-Length': String(end - start + 1) };
  if (range.kind === 'range') headers['Content-Range'] = `bytes ${start}-${end}/${src.size}`;
  const body = method === 'HEAD' || src.size === 0 ? null : rangeStream(src, start, end);
  return new Response(body, { status: range.kind === 'range' ? 206 : 200, headers });
}
