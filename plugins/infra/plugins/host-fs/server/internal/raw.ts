import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename } from "node:path";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { locateHostPath, type HostLocation } from "./archive/locate";
import { openArchiveMember } from "./archive/read";
import { classifyFsError, resolveHostPath } from "./path";

/** One satisfiable byte range, inclusive at both ends (as `Content-Range` spells it). */
export type ByteRange = { start: number; end: number };

/**
 * Read a `Range` header against a file of `size` bytes.
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
 * The headers that keep a host file's bytes inert on the app's origin: served
 * inline (so it previews) but never sniffed into another type, never allowed
 * to run script (a sandboxed document has an opaque origin, so an HTML or SVG
 * file cannot read the app's cookies, storage or APIs), and never embeddable
 * by another site (`<script src>` / `<img src>` from a page outside
 * `*.localhost`).
 *
 * A PDF is the one exception to `sandbox`: browsers refuse to run their PDF
 * viewer in a sandboxed document, and that viewer is the only way a PDF is
 * ever shown — it renders in the browser's own isolated origin, never as a
 * document on the app's, so the sandbox would protect nothing.
 */
export function inertHeaders(
  path: string,
  contentType: string,
): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
    "X-Content-Type-Options": "nosniff",
    ...(contentType === "application/pdf"
      ? {}
      : { "Content-Security-Policy": "sandbox" }),
    "Cross-Origin-Resource-Policy": "same-site",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  };
}

/**
 * Stream a host file's bytes. A raw handler rather than `implement()`: the
 * response is a byte stream with its own status (200 / 206 / 416) and headers.
 */
export async function handleRaw(req: Request): Promise<Response> {
  try {
    const raw = new URL(req.url, "http://localhost").searchParams.get("path");
    if (raw === null) return new Response("Missing path", { status: 400 });
    return await serveHostPath(resolveHostPath(raw), req.headers.get("range"));
  } catch (err) {
    if (err instanceof HttpError)
      return new Response(err.message, { status: err.status });
    throw err;
  }
}

/**
 * Stream the bytes at an absolute host path — a file on disk or a member of an
 * archive — with the inert headers and `Range` handling the `raw` route
 * answers with. The one byte server: a route addressing files another way
 * (code-api's workspace-relative paths) resolves to a host path and lands here.
 */
export async function serveHostPath(
  path: string,
  rangeHeader: string | null,
): Promise<Response> {
  const located = await locateHostPath(path);
  return located.kind === "archive"
    ? await serveArchiveMember(path, located, rangeHeader)
    : await serveHostFile(path, rangeHeader);
}

export async function serveHostFile(
  path: string,
  rangeHeader: string | null,
): Promise<Response> {
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile())
      return new Response(`Not a file: ${path}`, { status: 400 });
    size = st.size;
    // `stat` needs only search permission on the parents; reading needs read
    // permission on the file. Check it now so a denied file is a 403, not a
    // stream that fails after the 200 has gone out.
    await access(path, constants.R_OK);
  } catch (err) {
    const failure = classifyFsError(err);
    return failure === "missing"
      ? new Response(`Not found: ${path}`, { status: 404 })
      : new Response(`Permission denied: ${path}`, { status: 403 });
  }

  const file = Bun.file(path);
  const headers = inertHeaders(path, file.type);
  const range = parseRange(rangeHeader, size);
  if (range.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${size}` },
    });
  }
  if (range.kind === "range") {
    const { start, end } = range.range;
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }
  return new Response(file, { headers });
}

/**
 * Serve an archive member's bytes. A member stored uncompressed is a byte
 * window of the archive file, so it honours `Range` like a disk file; a
 * compressed one streams whole (200). The content type comes from the
 * member's own name.
 */
export async function serveArchiveMember(
  path: string,
  at: Extract<HostLocation, { kind: "archive" }>,
  rangeHeader: string | null,
): Promise<Response> {
  const opened = await openArchiveMember(path, at);
  switch (opened.kind) {
    case "missing":
      return new Response(`Not found: ${path}`, { status: 404 });
    case "denied":
      return new Response(`Permission denied: ${path}`, { status: 403 });
    case "not-a-file":
      return new Response(`Not a file: ${path}`, { status: 400 });
    case "unreadable-archive":
      return new Response(
        `Unreadable archive member (${opened.reason}): ${path}`,
        {
          status: 422,
        },
      );
    case "ok":
      break;
  }
  const { size, body } = opened;
  const headers = inertHeaders(path, Bun.file(path).type);
  if (!(body instanceof Blob)) {
    return new Response(body, {
      headers: {
        ...headers,
        "Accept-Ranges": "none",
        "Content-Length": String(size),
      },
    });
  }
  const range = parseRange(rangeHeader, size);
  if (range.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${size}` },
    });
  }
  if (range.kind === "range") {
    const { start, end } = range.range;
    return new Response(body.slice(start, end + 1), {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }
  return new Response(body, { headers });
}
