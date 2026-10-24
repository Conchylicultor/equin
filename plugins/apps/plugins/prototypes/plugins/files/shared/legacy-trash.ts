import { readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { protoIdKind } from "../core";
import { openStatusStore } from "./status";

// The trash as it used to be: a delete renamed the folder into
// `<prototypes>/_trash/<id>/`, so the id named nothing any more — every open
// pane and link to it broke. A delete is now a field of the prototype's status
// (`deletedAt`) and the folder stays where it is. This brings the old trash
// back into that model: each folder in `_trash/` returns to the tree, recorded
// as deleted, so it shows in the gallery's Trash rather than as live.
//
// Kept while branches with the old delete still run against the shared tree:
// a backend booting on this code adopts whatever they trashed since.
//
// `shared/`, beside the status store it writes, because it touches `fs`.

/** The old trash dir's name — still never served (`isInternalDir`). */
export const TRASH_DIR_NAME = "_trash";

/**
 * Move every `_trash/<id>/` under `root` back to `<root>/<id>/`, recording it
 * deleted first — so the folder never reappears as live. Its `deletedAt` is the
 * folder's ctime (when the rename into `_trash/` happened): deterministic, so
 * backends booting together record the same instant. A folder another backend
 * moved back first is skipped; a live folder already at `<root>/<id>` throws —
 * an id is minted once, so two folders under one is a broken assumption, never
 * something to overwrite.
 */
export async function adoptLegacyTrash(root: string): Promise<void> {
  const trash = join(root, TRASH_DIR_NAME);
  const names = await readdir(trash).catch((err: unknown) => {
    if (isCode(err, "ENOENT")) return [];
    throw err;
  });
  const statuses = openStatusStore(root);
  for (const name of names) {
    // A status is keyed by a minted id; a hand-made folder trashed the old way
    // has none to record, so it stays where it is.
    if (!protoIdKind.is(name)) continue;
    const from = join(trash, name);
    const to = join(root, name);
    const trashed = await stat(from).catch((err: unknown) => {
      if (isCode(err, "ENOENT")) return null; // another backend got there first
      throw err;
    });
    if (trashed === null || !trashed.isDirectory()) continue;
    if (await exists(to)) {
      throw new Error(
        `prototype ${name} is both in the old trash (${from}) and live (${to}); move one aside by hand`,
      );
    }
    await statuses.write(name, { deletedAt: trashed.ctime.toISOString() });
    await rename(from, to).catch((err: unknown) => {
      if (isCode(err, "ENOENT")) return; // another backend moved it back first
      throw err;
    });
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (err: unknown) => {
      if (isCode(err, "ENOENT")) return false;
      throw err;
    },
  );
}

function isCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}
