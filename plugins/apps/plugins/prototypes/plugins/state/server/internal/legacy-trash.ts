import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import { protoIdKind } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { _prototypeState } from "./tables";

// The trash as it used to be: a delete renamed the folder into
// `<prototypes>/_trash/<id>/`, so the id named nothing any more. A delete is now
// a field of the prototype's state (`deletedAt`) and the folder stays where it
// is. This brings the old trash back into that model: each folder in `_trash/`
// returns to the tree, recorded deleted in THIS instance's DB first, so it never
// reappears as live here.
//
// Main only (`scope: "host"`): the folders are host-global but the state is per
// instance, so whichever DB adopts a folder is the only one that knows it was
// deleted — that must be main's (a worktree forked after inherits the row).
// Kept while branches with the old move-to-trash delete may still run against
// the shared tree.

/** The old trash dir's name inside the prototypes data dir. */
const TRASH_DIR = "_trash";

/**
 * Move every `_trash/<id>/` back to `<root>/<id>/`, recording it deleted at the
 * folder's ctime (when the rename into `_trash/` happened) — an already-deleted
 * row keeps its first instant. A hand-made folder name has no state to record
 * and stays; a live folder already at `<root>/<id>` throws — an id is minted
 * once, so two folders under one is a broken assumption, never something to
 * overwrite.
 */
export async function adoptLegacyTrash(root: string): Promise<void> {
  const trash = join(root, TRASH_DIR);
  if (!existsSync(trash)) return;
  for (const entry of readdirSync(trash, { withFileTypes: true })) {
    if (!entry.isDirectory() || !protoIdKind.is(entry.name)) continue;
    const from = join(trash, entry.name);
    const to = join(root, entry.name);
    if (existsSync(to)) {
      throw new Error(
        `prototype ${entry.name} is both in the old trash (${from}) and live (${to}); move one aside by hand`,
      );
    }
    const deletedAt = statSync(from).ctime;
    await db
      .insert(_prototypeState)
      .values({ id: entry.name, deletedAt })
      .onConflictDoUpdate({
        target: _prototypeState.id,
        set: {
          deletedAt: sql`COALESCE(${_prototypeState.deletedAt}, excluded.deleted_at)`,
        },
      });
    renameSync(from, to);
  }
}

export const adoptLegacyTrashWarmup = defineWarmup({
  name: "prototypes.adopt-legacy-trash",
  description:
    "Brings each prototype folder an old build moved into _trash/ back into the gallery, recorded as deleted (in its Trash).",
  scope: "host",
  run: () => adoptLegacyTrash(prototypesDir.path),
});
