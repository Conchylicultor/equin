// Compositions over the Mount operations — every host gets them for free, and
// none is a provider surface of its own.

import type { WriteOrigin } from "@plugins/infra/plugins/request-origin/core";
import { joinRel, relName, relParent, type RelPath } from "./rel-path";
import type { FileEntry, Missing, Mount, RenameResult } from "./types";

export type ReadTextResult =
  { readonly kind: "text"; text: string; entry: FileEntry } | Missing;

/** A file's bytes as UTF-8 text. */
export async function readText(
  mount: Mount,
  path: RelPath,
): Promise<ReadTextResult> {
  const read = await mount.read(path);
  if (read.kind === "missing") return read;
  return { kind: "text", text: await read.blob.text(), entry: read.entry };
}

/**
 * Copy the tree at `fromDir` (in `from`) to `toDir` (in `to`), file by file —
 * the two may be different mounts. A missing `fromDir` throws: there is nothing
 * to copy, and a caller asking for it has the wrong path.
 */
export async function copyTree(
  from: Mount,
  fromDir: RelPath,
  to: Mount,
  toDir: RelPath,
  writer: WriteOrigin,
): Promise<void> {
  const listed = await from.list(fromDir);
  if (listed.kind === "missing") {
    throw new Error(`copyTree: nothing at "${fromDir}" to copy`);
  }
  for (const entry of listed.entries) {
    const src = joinRel(fromDir, entry.name);
    const dest = joinRel(toDir, entry.name);
    if (entry.kind === "dir") {
      await copyTree(from, src, to, dest, writer);
      continue;
    }
    const read = await from.read(src);
    // Removed between the listing and the read: a concurrent writer's move,
    // not this copy's to absorb.
    if (read.kind === "missing") {
      throw new Error(`copyTree: "${src}" vanished while it was being copied`);
    }
    await to.write(dest, read.blob, { writer });
  }
}

/**
 * Build a directory out of sight, then move it to `final` in one rename — so
 * `final` never exists half-built, and is never overwritten: `target-exists`
 * when somebody else got there first (the staging copy is removed). `build`
 * writes into the staging directory it is handed, a hidden sibling of `final`.
 */
export async function stageThenRename(
  mount: Mount,
  final: RelPath,
  build: (staging: RelPath) => Promise<void>,
  writer: WriteOrigin,
): Promise<Exclude<RenameResult, "missing">> {
  const staging = joinRel(
    relParent(final),
    `.staging-${relName(final)}-${crypto.randomUUID()}`,
  );
  let outcome: RenameResult;
  try {
    await build(staging);
    outcome = await mount.rename(staging, final, { writer });
  } catch (err) {
    await mount.remove(staging, { writer, recursive: true });
    throw err;
  }
  if (outcome === "target-exists") {
    await mount.remove(staging, { writer, recursive: true });
  }
  if (outcome === "missing") {
    throw new Error(
      `stageThenRename: "${final}" was built but its staging directory "${staging}" is gone — nothing was written to it, or something removed it`,
    );
  }
  return outcome;
}
