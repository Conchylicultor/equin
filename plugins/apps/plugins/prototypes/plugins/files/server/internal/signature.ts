import { prototypesFiles } from "@plugins/apps/plugins/prototypes/server";
import { listPrototypeDirNames } from "../../shared/read-folder";
import { readFolderSignature } from "../../shared/folder-signature";

/**
 * What the prototypes tree looks like right now, one comparable string per
 * prototype folder: every file in it with its size and mtime.
 *
 * This is the answer to "did anything actually change?", and it is what the
 * list re-broadcast is gated on. A watch event is a hint that something MIGHT
 * have changed — the desktop's watcher also reports a touch, a chmod, and a
 * reconcile tick — and nothing may be re-read for a tree that did not move.
 *
 * Each folder's string is {@link readFolderSignature} — the same one the lister
 * hashes into `PrototypeMeta.rev`, so "the watcher saw this prototype move" and
 * "its live frames reload" are one fact.
 *
 * Per folder rather than one string for the tree, because a prototype's
 * version history cares WHICH prototype moved: the diff of two signatures
 * ({@link changedPrototypes}) is the set whose `dirty` flag may have flipped.
 */
export async function readPrototypesSignature(): Promise<Map<string, string>> {
  const dirNames = await listPrototypeDirNames(prototypesFiles);

  // Every folder at once, not one after another: each listing is a few
  // stats (~20 ms for the whole tree), but read in series each await queues
  // behind whatever else holds the event loop — 2 s of wall on a main boot.
  const read = await Promise.all(
    dirNames.map(
      async (dirName) =>
        [dirName, await readFolderSignature(prototypesFiles, dirName)] as const,
    ),
  );
  const signature = new Map<string, string>();
  for (const [dirName, sig] of read)
    if (sig !== null) signature.set(dirName, sig);
  return signature;
}

/** The prototypes added, removed or edited between two signatures. */
export function changedPrototypes(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const changed: string[] = [];
  for (const [name, sig] of after) {
    if (before.get(name) !== sig) changed.push(name);
  }
  for (const name of before.keys()) {
    if (!after.has(name)) changed.push(name);
  }
  return changed;
}
