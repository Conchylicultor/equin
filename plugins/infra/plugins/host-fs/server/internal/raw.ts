import { constants } from "node:fs";
import { access, stat } from "@plugins/packages/plugins/timed-fs/core";
import { basename } from "node:path";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { rangedBlobResponse } from "@plugins/infra/plugins/endpoints/core";
import { locateHostPath, type HostLocation } from "./archive/locate";
import { openArchiveMember } from "./archive/read";
import { classifyFsError, resolveHostPath } from "./path";
import type { UserPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

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
  path: UserPath,
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
  path: UserPath,
  rangeHeader: string | null,
): Promise<Response> {
  const located = await locateHostPath(path);
  return located.kind === "archive"
    ? await serveArchiveMember(path, located, rangeHeader)
    : await serveHostFile(path, rangeHeader);
}

export async function serveHostFile(
  path: UserPath,
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

  // Sliced to the stat'd size, so the response knows its length without
  // the file blob stat'ing again (a file growing meanwhile serves what was stat'd).
  const type = Bun.file(path).type;
  const file = Bun.file(path).slice(0, size, type);
  return rangedBlobResponse(file, rangeHeader, inertHeaders(path, type));
}

/**
 * Serve an archive member's bytes. A member stored uncompressed is a byte
 * window of the archive file, so it honours `Range` like a disk file; a
 * compressed one streams whole (200). The content type comes from the
 * member's own name.
 */
export async function serveArchiveMember(
  path: UserPath,
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
  return rangedBlobResponse(body, rangeHeader, headers);
}
