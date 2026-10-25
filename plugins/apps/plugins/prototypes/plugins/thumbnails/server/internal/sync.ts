import { listPrototypeNames } from "@plugins/apps/plugins/prototypes/plugins/files/server";
import type { ThumbnailState } from "../../core";
import { hasThumbnail } from "./cache";
import { decideThumbnail } from "./decide";
import { fingerprintPrototype } from "./fingerprint";
import { renderThumbnailJob } from "./jobs";
import {
  patchThumbnailStates,
  readThumbnailState,
  replaceThumbnailStates,
} from "./state";

/**
 * Reconcile every prototype's thumbnail state against the filesystem, and
 * enqueue whatever is missing — at boot, and when the browser install settles.
 *
 * This and {@link syncChangedThumbnails} are the only places that decide what
 * needs rendering, and both decide from the fingerprint alone — so they are
 * idempotent. A prototype that vanished loses its state by construction (the
 * map is rebuilt, not patched).
 *
 * It needs the prototypes' NAMES, nothing else, so it reads the folder listing
 * (`listPrototypeNames`) — never `listPrototypeMetas`, which reads, validates
 * and parses every folder and was 2–4 s of this pass's ~3 s on main.
 */
export async function syncThumbnails(): Promise<void> {
  const next = new Map<string, ThumbnailState>();
  const pending = await decideAll(await listPrototypeNames(), next);
  replaceThumbnailStates(next);
  await enqueueRenders(pending);
}

/**
 * Re-decide only the prototypes a tree change named (`onPrototypesChanged`
 * hands them over) — an edit to one prototype re-fingerprints that one folder,
 * not all of them. A named prototype that is gone loses its state.
 */
export async function syncChangedThumbnails(
  changed: readonly string[],
): Promise<void> {
  const next = new Map<string, ThumbnailState>();
  const pending = await decideAll(changed, next);
  const gone = changed.filter((name) => !next.has(name));
  patchThumbnailStates(next, gone);
  await enqueueRenders(pending);
}

/** Decide each named prototype into `next`; returns the renders it needs. */
async function decideAll(
  names: readonly string[],
  next: Map<string, ThumbnailState>,
): Promise<{ name: string; key: string }[]> {
  const pending: { name: string; key: string }[] = [];
  for (const name of names) {
    let key: string;
    try {
      key = await fingerprintPrototype(name);
    } catch (err) {
      // Not on disk: deleted between the listing and the hash (the watcher
      // fires again for the removal), or a change that named a removed
      // prototype. Either way it has no state.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }

    const decision = decideThumbnail(
      key,
      await hasThumbnail(key),
      readThumbnailState(name),
    );
    next.set(name, decision.state);
    if (decision.render) pending.push({ name, key });
  }
  return pending;
}

// Enqueue after the push, so an open gallery shows `rendering` immediately
// rather than after the queue round-trip.
async function enqueueRenders(
  pending: readonly { name: string; key: string }[],
): Promise<void> {
  for (const item of pending) {
    await renderThumbnailJob.enqueue(item);
  }
}
