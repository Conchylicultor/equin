/** One satisfiable byte range, inclusive at both ends (as `Content-Range` spells it). */
export type ByteRange = { start: number; end: number };

/**
 * Read a `Range` header against a body of `size` bytes.
 *
 * - `none`: no header, or one this server serves whole (several ranges, a unit
 *   other than bytes, malformed) — RFC 9110 lets a server ignore Range.
 * - `unsatisfiable`: a well-formed single range that lies past the end (416).
 */
export type RangeRequest =
  | { kind: "none" }
  | { kind: "range"; range: ByteRange }
  | { kind: "unsatisfiable" };

export function parseRange(header: string | null, size: number): RangeRequest {
  if (!header) return { kind: "none" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return { kind: "none" };
  const [, from, to] = m;
  if (from === "" && to === "") return { kind: "none" };
  if (from === "") {
    // Suffix range: the last N bytes.
    const n = Number(to);
    if (n === 0 || size === 0) return { kind: "unsatisfiable" };
    return {
      kind: "range",
      range: { start: Math.max(0, size - n), end: size - 1 },
    };
  }
  const start = Number(from);
  if (start >= size) return { kind: "unsatisfiable" };
  const end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (end < start) return { kind: "none" };
  return { kind: "range", range: { start, end } };
}

/**
 * Answer a GET for `body` honouring its `Range` header: the whole body (200),
 * the one requested window (206, `Content-Range`), or 416 for a range past the
 * end. Every answer says `Accept-Ranges: bytes`, so a `<video>` / `<audio>`
 * seeks by asking for the bytes it needs (Safari will not play a video served
 * without ranges). `headers` are the route's own (content type, caching, …).
 *
 * Pure over a `Blob`, so it serves on every host — a disk file
 * (`Bun.file`), a data-files read, or a blob in a browser host's memory.
 */
export function rangedBlobResponse(
  body: Blob,
  rangeHeader: string | null,
  headers: Record<string, string>,
): Response {
  const size = body.size;
  const base = { ...headers, "Accept-Ranges": "bytes" };
  const range = parseRange(rangeHeader, size);
  if (range.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...base, "Content-Range": `bytes */${size}` },
    });
  }
  if (range.kind === "range") {
    const { start, end } = range.range;
    return new Response(body.slice(start, end + 1), {
      status: 206,
      headers: {
        ...base,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }
  return new Response(body, { headers: base });
}
