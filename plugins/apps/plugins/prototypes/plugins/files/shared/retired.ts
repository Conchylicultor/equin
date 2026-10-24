// Dirs of the prototypes data dir that no code writes any more, kept as
// reserved names: never served, never watched for, never a prototype.
//
// `_trash/` held deleted prototypes when a delete still moved the folder. A
// delete is now a field of the state (`deletedAt`); main's `state` plugin moves
// any folder left there back into the tree, recorded as deleted.

/** Retired dir names inside the prototypes data dir. */
export const RETIRED_DIR_NAMES: readonly string[] = ["_trash"];

/** `name` is a retired dir of the prototypes data dir. */
export function isRetiredDirName(name: string | undefined): boolean {
  return name !== undefined && RETIRED_DIR_NAMES.includes(name);
}
