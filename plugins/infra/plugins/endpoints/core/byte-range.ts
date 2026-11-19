/** One satisfiable byte range, inclusive at both ends (as `Content-Range` spells it). */
export type ByteRange = { start: number; end: number };

/**
 * The most an open-ended range (`bytes=N-`) a media element asks for is
 * answered with: 1 MiB.
 *
 * A media element asks `bytes=N-` — everything from N on — whether it wants
 * the whole file or only its metadata (`preload="metadata"`, a seek): it
 * stops reading once it has enough, but over HTTP/2 the transport has
 * already let the rest in — Chrome's stream window admits ~6 MB before its
 * media stack's back-pressure applies. Unbounded, a 16 MB film that nobody
 * plays cost every phone visit to equin.ai ~6 MB. Answering the open end
 * with at most a chunk (RFC 9110 lets a 206 carry less than asked: the
 * `Content-Range` says which bytes and the total) puts the reader in charge
 * of the bytes on the wire: a player that wants more asks for the next
 * range, as it does after a seek (Chrome's and Firefox's media stacks reopen
 * at the offset a short response ended at). An explicit end (`bytes=N-M`) is
 * the reader's own bound and is served as asked. Only a media element's ask
 * is bounded (`Sec-Fetch-Dest: video | audio`): a resumed download or
 * `curl -C -` asks `bytes=N-` and means it, and would stop at 1 MiB.
 */
export const OPEN_RANGE_CHUNK_BYTES = 1024 * 1024;

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

export function parseRange(
  header: string | null,
  size: number,
  /** The most an open-ended range is answered with (unbounded: `Infinity`). */
  openEndBytes: number = Infinity,
): RangeRequest {
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
  const end = Math.min(
    to === "" ? start + openEndBytes - 1 : Number(to),
    size - 1,
  );
  if (end < start) return { kind: "none" };
  return { kind: "range", range: { start, end } };
}

/** Media elements: the readers whose open-ended ranges are bounded (`Sec-Fetch-Dest`). */
const MEDIA_DESTINATIONS = new Set(["video", "audio", "track"]);

/**
 * Answer a GET for `body` honouring its `Range` header: the whole body (200),
 * the one requested window (206, `Content-Range`; a media element's
 * open-ended one at most `OPEN_RANGE_CHUNK_BYTES`), or 416 for a range past
 * the end. Takes the request's headers: the range and who reads it. Every answer says `Accept-Ranges: bytes`, so a `<video>` / `<audio>`
 * seeks by asking for the bytes it needs (Safari will not play a video served
 * without ranges). `headers` are the route's own (content type, caching, …).
 *
 * Pure over a `Blob`, so it serves on every host — a disk file
 * (`Bun.file`), a data-files read, or a blob in a browser host's memory.
 */
export function rangedBlobResponse(
  body: Blob,
  requestHeaders: Headers,
  headers: Record<string, string>,
): Response {
  const size = body.size;
  const base = { ...headers, "Accept-Ranges": "bytes" };
  const range = parseRange(
    requestHeaders.get("range"),
    size,
    MEDIA_DESTINATIONS.has(requestHeaders.get("sec-fetch-dest") ?? "")
      ? OPEN_RANGE_CHUNK_BYTES
      : Infinity,
  );
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
