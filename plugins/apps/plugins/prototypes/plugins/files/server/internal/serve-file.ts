import { prototypesFiles } from "@plugins/apps/plugins/prototypes/server";
import {
  InvalidRelPathError,
  relPath,
  type RelPath,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { PROTOTYPE_ENTRY_FILE, protoIdKind } from "../../core";
import { PICKS_DIR_NAME } from "../../shared/picks";
import { isRetiredDirName } from "../../shared/retired";
import {
  HISTORY_DIR_NAME,
  PrototypeHistoryStore,
  isFlatFileName,
  isVersionSha,
} from "./history-store";
import { contentTypeForPath } from "./paths";
import { hasPicks, servePickedDocument } from "./picked-document";

// The prototypes tree's raw files over HTTP, on every host: read through the
// `prototypesFiles` root (the disk on the desktop, memory in a browser host)
// and, for a recorded version, through the host's history store. Raw handlers
// (`rawEndpointHandler` in the barrel): per-file bytes with a custom
// Content-Type, or a redirect, which `implement()`'s JSON contract does not fit.

/**
 * `GET /api/prototypes/:name` → 302 to `…/:name/index.html`, carrying the query
 * (`?v=`) across.
 *
 * The folder-shaped URL is the real one — it is what makes a relative
 * `href="styles.css"` inside the document resolve to that prototype's own file.
 * This bare form exists only so a hand-typed or older URL still lands somewhere
 * sensible.
 */
export function handlePrototypeFile(
  req: Request,
  params: Record<string, string>,
): Response {
  const name = params.name;
  if (!name) return new Response("missing name", { status: 400 });
  if (isInternalDir(name)) return notFound();

  const { search } = new URL(req.url);
  // RELATIVE (`<name>/index.html`): served on the content host, under its
  // `/<ns>/` routing prefix the backend never sees — an absolute `/api/…`
  // would leave it.
  const location = `${encodeURIComponent(name)}/${PROTOTYPE_ENTRY_FILE}${search}`;
  return new Response(null, { status: 302, headers: { location } });
}

/**
 * `GET /api/prototypes/:name/:file` → `<name>/<file>` verbatim, with a
 * Content-Type by extension — except that `index.html` asked for with option
 * picks (`?palette=azure`) comes back with them stamped onto `<html>`; see
 * {@link servePickedDocument}.
 *
 * `Cache-Control: no-store` is load-bearing: the version query only cache-busts
 * the document, so without it the browser would keep serving the previously
 * fetched `styles.css` and an agent's edit would appear not to have landed.
 *
 * Path guard: each param is ONE segment of a path inside the root — a `..`,
 * a separator or NUL has no `RelPath` spelling (400); the router has already
 * decoded it, so `%2e%2e` arrives as `..`. Missing files (and directories) → 404.
 */
export async function handlePrototypeAsset(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const name = params.name;
  const fileName = params.file;
  if (!name || !fileName) return new Response("missing name", { status: 400 });
  if (isInternalDir(name)) return notFound();

  const path = filePath(name, fileName);
  if (path === null) return new Response("invalid path", { status: 400 });

  const stat = await prototypesFiles.stat(path);
  if (stat.kind === "missing" || stat.entry.kind !== "file") return notFound();
  const read = await prototypesFiles.read(path);
  // Removed between the stat and the read: as missing as it was never there.
  if (read.kind === "missing") return notFound();

  const headers = {
    "content-type": contentTypeForPath(fileName),
    "cache-control": "no-store",
  };
  const search = new URL(req.url).searchParams;
  if (fileName === PROTOTYPE_ENTRY_FILE && hasPicks(search)) {
    return servePickedDocument(await read.blob.text(), search, headers);
  }
  return new Response(read.blob, { headers });
}

/**
 * `GET /api/prototypes/:name/versions/:sha/:file` → that file as it was in that
 * version. The sha addresses the content, so it is cacheable forever —
 * `immutable`, the opposite of the live route's `no-store` — and so is each
 * picked variant of it: `index.html?palette=azure` is stamped exactly as on
 * the live route, judged against the options THIS version declares. A
 * malformed name, sha or file is a 404 like an unknown one: none of them names
 * a version.
 */
export async function handlePrototypeVersionFile(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const { name, sha, file } = params;
  if (
    name === undefined ||
    sha === undefined ||
    file === undefined ||
    !protoIdKind.is(name) ||
    !isVersionSha(sha) ||
    !isFlatFileName(file)
  ) {
    return notFound();
  }

  const read = await PrototypeHistoryStore.get().readVersionFile(
    name,
    sha,
    file,
  );
  if (read.kind === "not-found") return notFound();
  const headers = {
    "content-type": contentTypeForPath(file),
    "cache-control": "public, max-age=31536000, immutable",
  };
  const search = new URL(req.url).searchParams;
  if (file === PROTOTYPE_ENTRY_FILE && hasPicks(search)) {
    const html = new TextDecoder().decode(read.bytes);
    return servePickedDocument(html, search, headers);
  }
  return new Response(read.bytes, { headers });
}

/** `<name>/<file>` inside the root, or `null` when either is no one segment. */
function filePath(name: string, file: string): RelPath | null {
  try {
    return relPath(name, file);
  } catch (err) {
    if (err instanceof InvalidRelPathError) return null;
    throw err;
  }
}

/**
 * `_history/` and `_picks/` sit in the served tree beside the prototypes: each
 * one's version history and option picks. Their internals are never served —
 * a version's files are, through the versions route, which reads them from the
 * history store; the picks are, through the `prototypes.picks` resource. A
 * retired dir (`shared/retired.ts`) is never served either.
 */
function isInternalDir(name: string): boolean {
  return (
    name === HISTORY_DIR_NAME ||
    name === PICKS_DIR_NAME ||
    isRetiredDirName(name)
  );
}

function notFound(): Response {
  return new Response("not found", { status: 404 });
}
