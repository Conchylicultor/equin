import {
  relPath,
  type ReadResult,
  type RelPath,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { thumbnailCache } from "./roots";

// Where rendered thumbnails live: the `thumbnailCache` root over the
// `cache/prototypes-thumbnails` data dir this plugin declares — on the desktop
// host-global, outside every worktree, exactly like `asset-mirror`'s cache.
//
// Host-global is safe *because* the filename is the content fingerprint — two
// worktrees holding a byte-identical prototype address the same PNG and share one
// render, while a worktree that has edited its copy addresses a different one. It
// also has to live outside `prototypes/`: the `prototypes:self-contained` check
// rejects any subdirectory in a prototype folder, and a derived artifact has no
// business being committed anyway.

/** Every write here is this plugin's own bookkeeping, never a user's or agent's. */
const writer = systemOrigin("prototype thumbnail cache");

function thumbnailPath(key: string): RelPath {
  return relPath(`${key}.png`);
}

/** Is this fingerprint already rendered? */
export async function hasThumbnail(key: string): Promise<boolean> {
  const stat = await thumbnailCache.stat(thumbnailPath(key));
  return stat.kind === "found" && stat.entry.kind === "file";
}

/** The cached PNG for a fingerprint, for the serving route. */
export function readThumbnail(key: string): Promise<ReadResult> {
  return thumbnailCache.read(thumbnailPath(key));
}

/**
 * Store a rendered PNG under its fingerprint. The root's write is atomic, so a
 * concurrent reader never observes a half-written image — the same atomicity
 * `asset-mirror` relies on.
 */
export async function writeThumbnail(
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  await thumbnailCache.write(thumbnailPath(key), bytes, { writer });
}

/**
 * Drop thumbnails untouched for `maxAgeMs`. Age, not reachability: a prototype
 * that is deleted and restored, or an old fingerprint that becomes current
 * again, is simply re-rendered — so the cheap sweep can never delete something
 * unrecoverable. Returns how many files were removed.
 */
export async function sweepThumbnails(maxAgeMs: number): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  const listed = await thumbnailCache.list(relPath());
  // Nothing rendered yet on this host.
  if (listed.kind === "missing") return 0;

  let removed = 0;
  for (const entry of listed.entries) {
    if (entry.kind !== "file" || entry.mtimeMs >= cutoff) continue;
    await thumbnailCache.remove(relPath(entry.name), {
      writer,
      recursive: false,
    });
    removed++;
  }
  return removed;
}
