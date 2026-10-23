import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { originOf } from "@plugins/infra/plugins/request-origin/core";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import {
  PROTOTYPES_API_BASE,
  PROTOTYPE_ENTRY_FILE,
  createPrototype,
  deletePrototype,
  listPrototypes,
} from "../../core";
import { HISTORY_DIR_NAME } from "../../shared/history/store";
import { PICKS_DIR_NAME } from "../../shared/picks";
import { STATUS_DIR_NAME } from "../../shared/status";
import { mintPrototype } from "../../shared/mint";
import {
  PrototypeNotFoundError,
  TRASH_DIR_NAME,
  trashPrototype,
} from "../../shared/trash";
import { listPrototypeMetas } from "./list";
import { contentTypeForPath, resolvePrototypeFile } from "./paths";
import { hasPicks, servePickedDocument } from "./picked-document";

/** `GET /api/prototypes` → the prototype list (JSON, via implement()). */
export const handleList = implement(listPrototypes, async () => {
  return listPrototypeMetas();
});

/**
 * `POST /api/prototypes` → mint a prototype, answer with its id.
 *
 * No list notification here: the mint writes a folder into the watched tree, so
 * the same file watcher that reacts to an agent's edit is what re-broadcasts the
 * list. One signal for "the tree moved", not two.
 */
export const handleCreate = implement(createPrototype, async ({ body }) => {
  const { id } = await mintPrototype({ title: body.title });
  return { id };
});

/**
 * `DELETE /api/prototypes/:name` → move the prototype to `_trash/`
 * (`shared/trash.ts`). Like the mint, it notifies nothing: the folder leaving
 * the watched tree is what re-broadcasts the list.
 *
 * Refused for an automated session. The tree is host-global — a worktree's e2e
 * run deleting a prototype deletes the user's — and the agent-write ledger
 * that puts an automated write back snapshots files, not a moved folder.
 */
export const handleDelete = implement(deletePrototype, ({ params, req }) => {
  const writer = originOf(req);
  if (writer.kind === "agent") {
    throw new HttpError(
      403,
      `an automated session (${writer.source}) may not delete a prototype: the prototypes tree is shared by every worktree and the delete could not be reverted`,
    );
  }
  try {
    trashPrototype(prototypesDir.path, params.name);
  } catch (err) {
    if (err instanceof PrototypeNotFoundError) {
      throw new HttpError(404, err.message);
    }
    throw err;
  }
});

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
  if (isInternalDir(name)) return internalNotServed();

  const { search } = new URL(req.url);
  const location = `${PROTOTYPES_API_BASE}/${encodeURIComponent(name)}/index.html${search}`;
  return new Response(null, { status: 302, headers: { location } });
}

/**
 * `GET /api/prototypes/:name/:file` → `prototypes/<name>/<file>` verbatim, with
 * a Content-Type by extension — except that `index.html` asked for with option
 * picks (`?palette=azure`) comes back with them stamped onto `<html>`; see
 * {@link servePickedDocument}.
 *
 * `Cache-Control: no-store` is load-bearing: the version query only cache-busts
 * the document, so without it the browser would keep serving the previously
 * fetched `styles.css` and an agent's edit would appear not to have landed.
 *
 * Path-traversal guard: the resolved absolute path must stay under
 * `prototypes/`; otherwise 400. Missing files → 404.
 */
export async function handlePrototypeAsset(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const name = params.name;
  const fileName = params.file;
  if (!name || !fileName) return new Response("missing name", { status: 400 });
  if (isInternalDir(name)) return internalNotServed();

  const abs = resolvePrototypeFile(name, fileName);
  if (abs === null) {
    return new Response("invalid path", { status: 400 });
  }

  const file = Bun.file(abs);
  if (!(await file.exists())) {
    return new Response("not found", { status: 404 });
  }

  const headers = {
    "content-type": contentTypeForPath(fileName),
    "cache-control": "no-store",
  };
  const search = new URL(req.url).searchParams;
  if (fileName === PROTOTYPE_ENTRY_FILE && hasPicks(search)) {
    return servePickedDocument(await file.text(), search, headers);
  }
  return new Response(file, { headers });
}

/**
 * `_history/`, `_picks/`, `_status/` and `_trash/` sit in the served tree
 * beside the prototypes: each one's private git repo, option picks and status,
 * and the deleted prototypes. Their
 * internals are never served — a version's files are, through the versions
 * route, which reads them out of git; the picks and statuses are, through the
 * `prototypes.picks` and `prototypes.statuses` resources.
 */
function isInternalDir(name: string): boolean {
  return (
    name === HISTORY_DIR_NAME ||
    name === PICKS_DIR_NAME ||
    name === STATUS_DIR_NAME ||
    name === TRASH_DIR_NAME
  );
}

function internalNotServed(): Response {
  return new Response("not found", { status: 404 });
}
