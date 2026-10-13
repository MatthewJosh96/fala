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
  readChunk(index: number): Promise<Uint8Array>;
}

/**
 * Lazily streams bytes [start, end] chunk by chunk, so a request for "bytes=0-"
 * of a 460 MB file never holds more than one chunk in memory.
 */
export function rangeStream(src: ChunkSource, start: number, end: number): ReadableStream<Uint8Array> {
  let pos = start;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pos > end) {
        controller.close();
        return;
      }
      const index = Math.floor(pos / src.chunkSize);
      const chunkStart = index * src.chunkSize;
      const chunk = await src.readChunk(index);
      const from = pos - chunkStart;
      const to = Math.min(chunk.length, end - chunkStart + 1);
      if (to <= from) {
        controller.error(new Error(`chunk ${index} is shorter than expected`));
        return;
      }
      controller.enqueue(chunk.subarray(from, to));
      pos = chunkStart + to;
    },
  });
}

export function buildMediaResponse(
  src: ChunkSource,
  rangeHeader: string | null,
  method = 'GET',
): Response {
  const range = parseRange(rangeHeader, src.size);
  const base: Record<string, string> = {
    'Content-Type': src.contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
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
