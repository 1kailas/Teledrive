import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { PartRow } from '../types.js';
import type { PartCache } from './partCache.js';

export interface ByteRange {
  start: number;
  end: number; // inclusive
}

/**
 * Parse an HTTP Range header for a single range.
 * Returns null when no/empty range, or 'invalid' -> respond 416.
 */
export function parseRangeHeader(header: string | undefined, size: number): ByteRange | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';
  const [, a, b] = m;
  if (a === '' && b === '') return 'invalid';
  let start: number;
  let end: number;
  if (a === '') {
    // suffix range: last N bytes
    const n = parseInt(b!, 10);
    if (n <= 0) return 'invalid';
    if (n >= size) return { start: 0, end: Math.max(0, size - 1) };
    return { start: size - n, end: size - 1 };
  }
  start = parseInt(a!, 10);
  end = b === '' ? size - 1 : parseInt(b!, 10);
  if (start >= size || start > end) return 'invalid';
  if (end >= size) end = size - 1;
  return { start, end };
}

export interface PartSegment {
  part: PartRow;
  start: number; // offset within the part
  end: number; // inclusive
}

/** Map an absolute [start,end] byte range onto part segments. */
export function rangeToSegments(parts: PartRow[], start: number, end: number): PartSegment[] {
  const out: PartSegment[] = [];
  for (const part of parts) {
    const partStart = part.offset;
    const partEnd = part.offset + part.size - 1;
    if (end < partStart || start > partEnd) continue;
    out.push({
      part,
      start: Math.max(0, start - partStart),
      end: Math.min(part.size - 1, end - partStart),
    });
  }
  return out;
}

export interface StreamOptions {
  signal?: AbortSignal;
  parts: PartRow[]; // ordered, all parts of the blob
  /**
   * How many upcoming parts to fetch from Telegram in parallel while streaming.
   * Parts are spread across bots at upload time, so look-ahead fetches run on
   * different bots concurrently. 0 disables look-ahead.
   */
  prefetchAhead?: number;
  /**
   * Start look-ahead immediately (full downloads, zips). Otherwise it starts
   * once 25% of the current segment has streamed, so video seeking/scrubbing
   * does not trigger multi-GB fetches that are abandoned a second later.
   */
  eager?: boolean;
}

/**
 * A single Readable streaming [segments] of a blob. Aborts promptly when the
 * client disconnects (no further getFile calls).
 */
export function createBlobStream(cache: PartCache, segments: PartSegment[], opts: StreamOptions): Readable {
  const ahead = Math.max(0, opts.prefetchAhead ?? 0);
  const warmed = new Set<number>();
  const warm = (from: number) => {
    for (let j = from; j < Math.min(segments.length, from + ahead); j++) {
      if (warmed.has(j)) continue;
      warmed.add(j);
      void cache.ensureLocal(segments[j]!.part).catch(() => {});
    }
  };
  async function* gen(): AsyncGenerator<Buffer> {
    if (opts.eager) warm(1);
    for (let i = 0; i < segments.length; i++) {
      if (opts.signal?.aborted) return;
      const seg = segments[i]!;
      const localPath = await cache.ensureLocal(seg.part);
      if (opts.signal?.aborted) return;
      cache.ref(localPath);
      let yielded = 0;
      const segLen = seg.end - seg.start + 1;
      try {
        const rs = fs.createReadStream(localPath, { start: seg.start, end: seg.end, highWaterMark: 1024 * 1024 });
        try {
          for await (const chunk of rs) {
            if (opts.signal?.aborted) {
              rs.destroy();
              return;
            }
            yielded += (chunk as Buffer).length;
            if (ahead > 0 && yielded >= segLen / 4) warm(i + 1);
            yield chunk as Buffer;
          }
        } finally {
          rs.destroy();
        }
      } finally {
        cache.unref(localPath);
      }
    }
  }
  return Readable.from(gen());
}
