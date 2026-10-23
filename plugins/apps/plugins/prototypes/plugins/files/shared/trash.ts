import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

// Where a deleted prototype goes: `<prototypes>/_trash/<id>/`, the folder moved
// whole, untouched. `_`-prefixed, so it is never listed as a prototype
// (`read-folder.ts`), never served (`isInternalDir`) and never part of the
// reload signature. Its history repo (`_history/<id>.git`) and its records
// (`_picks/`, `_status/`) stay where they are, so moving the folder back
// restores the prototype exactly as it was — versions, picks and Done included.
//
// `shared/`, beside the mint, because it touches `fs` and is the inverse of it.

/** The trash dir's name inside the prototypes data dir. */
export const TRASH_DIR_NAME = "_trash";

export class PrototypeNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`no such prototype: ${id}`);
  }
}

/**
 * Move prototype `id` from the tree at `root` into its trash. Throws
 * {@link PrototypeNotFoundError} when there is no such prototype, and a plain
 * error when the trash already holds one by that id (an id is minted once, so
 * that is a broken assumption, not something to overwrite).
 *
 * A single `rename` within one dir tree: atomic, so the gallery never sees half
 * a prototype. Returns the folder's new path.
 */
export function trashPrototype(root: string, id: string): string {
  const from = join(root, id);
  if (
    !isPrototypeFolderName(id) ||
    !statSync(from, { throwIfNoEntry: false })?.isDirectory()
  ) {
    throw new PrototypeNotFoundError(id);
  }
  const trash = join(root, TRASH_DIR_NAME);
  mkdirSync(trash, { recursive: true });
  const to = join(trash, id);
  if (existsSync(to)) {
    throw new Error(`prototype trash already holds ${id} (${to})`);
  }
  renameSync(from, to);
  return to;
}

/**
 * A name the gallery lists as a prototype (`read-folder.ts`): one path segment,
 * not an internal `_` dir or a dot-dir. Not `protoIdKind.is` — a hand-made
 * folder is listed too, so it must be deletable too.
 */
function isPrototypeFolderName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.startsWith("_") &&
    !name.startsWith(".")
  );
}
