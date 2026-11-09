import { resolve } from "node:path";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { isAllowedRef, resolveRef } from "./resolve-ref";
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
import { asUserPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  FILE_BYTES_MAX,
  contentTypeOf,
} from "@plugins/infra/plugins/paths/plugins/file-systems/core";

// Every git read in this file serves an open HTTP request from the code
// explorer: a local, metadata-or-blob read that finishes in milliseconds. The
// request is the deadline, and thirty seconds is well past the point where an
// answer still helps whoever is looking at the pane — so only a wedged child
// reaches it, and it fails as a named error instead of holding the request open
// forever.
const GIT_TIMEOUT_MS = 30_000;

/**
 * `GET /api/files/checkout/raw?checkout=&path=&version=` (file-systems'
 * `checkoutFileRaw`): one checkout file's bytes — on disk now, or as of
 * `version` (the blob that ref names).
 */
export async function handleCheckoutFileRaw(req: Request): Promise<Response> {
  try {
    return await serveCheckoutFile(req);
  } catch (err) {
    if (err instanceof HttpError)
      return new Response(err.message, { status: err.status });
    throw err;
  }
}

async function serveCheckoutFile(req: Request): Promise<Response> {
  const url = new URL(req.url, "http://localhost");
  const checkout = url.searchParams.get("checkout");
  if (!checkout) return new Response("Missing checkout", { status: 400 });
  const path = url.searchParams.get("path");
  if (!path || path.includes("\0"))
    return new Response("Invalid path", { status: 400 });
  const ref = url.searchParams.get("version");

  // The file as it is on disk now: any workspace kind, served by host-fs's
  // byte server (inert headers, `Range`) once the path is known to sit inside
  // the workspace.
  if (!ref) {
    const root = await resolveWorkspacePath(checkout);
    if (!root) return new Response("Not found", { status: 404 });
    const absTarget = resolveInsideRoot(root, path);
    if (absTarget === null)
      return new Response("Invalid path", { status: 400 });
    return await serveHostPath(asUserPath(absTarget), req.headers.get("range"));
  }

  // As of a revision: a git read, so the workspace must be a checkout.
  const wtPath = await resolveWorktreePath(checkout);
  if (!wtPath) return new Response("Not found", { status: 404 });
  if (resolveInsideRoot(wtPath, path) === null)
    return new Response("Invalid path", { status: 400 });
  if (!isAllowedRef(ref)) return new Response("Invalid ref", { status: 400 });
  const object = `${await resolveRef(wtPath, ref)}:${path}`;
  const git = (args: string[]) =>
    spawnCaptured(
      [GIT, "--no-optional-locks", "-C", resolve(wtPath), ...args],
      {
        timeoutMs: GIT_TIMEOUT_MS,
      },
    );
  // A blob only (a folder at that version is a tree), its size gated before
  // it is buffered — the bytes read's own limit.
  const kind = await git(["cat-file", "-t", object]);
  if (kind.exitCode !== 0 || kind.stdout.trim() !== "blob")
    return new Response("File not found", { status: 404 });
  const size = await git(["cat-file", "-s", object]);
  if (size.exitCode !== 0) {
    throw new Error(`git cat-file -s ${object} failed: ${size.stderr}`);
  }
  if (Number(size.stdout.trim()) > FILE_BYTES_MAX)
    return new Response("File too large", { status: 413 });
  const blob = await git(["cat-file", "blob", object]);
  if (blob.exitCode !== 0) {
    throw new Error(`git cat-file blob ${object} failed: ${blob.stderr}`);
  }
  return new Response(new Uint8Array(blob.stdoutBytes), {
    headers: inertHeaders(asUserPath(path), contentTypeOf(path)),
  });
}
