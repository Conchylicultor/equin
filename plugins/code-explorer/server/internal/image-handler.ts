import { resolve } from "node:path";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { ALLOWED_REFS, resolveRef } from "./resolve-ref";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  inertHeaders,
  serveHostPath,
} from "@plugins/infra/plugins/host-fs/server";
import {
  resolveWorkspacePath,
  resolveWorktreePath,
} from "./resolve-worktree-path";
import { resolveInsideRoot } from "./contained-path";

// Every git read in this file serves an open HTTP request from the code
// explorer: a local, metadata-or-blob read that finishes in milliseconds. The
// request is the deadline, and thirty seconds is well past the point where an
// answer still helps whoever is looking at the pane — so only a wedged child
// reaches it, and it fails as a named error instead of holding the request open
// forever.
const GIT_TIMEOUT_MS = 30_000;
// A ref read buffers `git show`'s output; the on-disk read streams, uncapped.
const MAX_BYTES = 20 * 1024 * 1024;

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif",
};

function extForPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1);
}

function mimeForPath(path: string): string | null {
  return EXT_TO_MIME[extForPath(path)] ?? null;
}

export async function handleImageContent(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    return await serveImage(req, params);
  } catch (err) {
    if (err instanceof HttpError)
      return new Response(err.message, { status: err.status });
    throw err;
  }
}

async function serveImage(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const worktree = params.worktree;
  if (!worktree) return new Response("Missing worktree", { status: 400 });

  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path || path.includes("\0"))
    return new Response("Invalid path", { status: 400 });

  const ref = url.searchParams.get("ref");

  const mime = mimeForPath(path);
  if (!mime) return new Response("Unsupported media type", { status: 415 });

  // The file as it is on disk now: any workspace kind, served by host-fs's
  // byte server (inert headers, `Range`) once the path is known to sit inside
  // the workspace. An image elsewhere on the host is host-fs's to address too
  // (file-viewer's `host` FileRef).
  if (!ref) {
    const root = await resolveWorkspacePath(worktree);
    if (!root) return new Response("Not found", { status: 404 });
    const absTarget = resolveInsideRoot(root, path);
    if (absTarget === null)
      return new Response("Invalid path", { status: 400 });
    return await serveHostPath(absTarget, req.headers.get("range"));
  }

  // As of a revision: a git read, so the workspace must be a checkout.
  const wtPath = await resolveWorktreePath(worktree);
  if (!wtPath) return new Response("Not found", { status: 404 });
  if (resolveInsideRoot(wtPath, path) === null)
    return new Response("Invalid path", { status: 400 });
  if (!ALLOWED_REFS.has(ref))
    return new Response("Invalid ref", { status: 400 });
  const resolvedRef = await resolveRef(wtPath, ref);
  const result = await spawnCaptured(
    [
      GIT,
      "--no-optional-locks",
      "-C",
      resolve(wtPath),
      "show",
      `${resolvedRef}:${path}`,
    ],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (result.exitCode !== 0)
    return new Response("File not found", { status: 404 });
  const bytes = new Uint8Array(result.stdoutBytes);
  if (bytes.length > MAX_BYTES)
    return new Response("File too large", { status: 413 });

  return new Response(bytes, { headers: inertHeaders(path, mime) });
}
