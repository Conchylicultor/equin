import { serveValue } from "@plugins/network/plugins/live/server";
import { prototypeThumbnails, type ThumbnailState } from "../../core";

/**
 * Thumbnail state per prototype slug, held in memory.
 *
 * In memory rather than in a table on purpose: every arm of it is derivable
 * from the filesystem (a fingerprint, and whether that fingerprint's PNG
 * exists), so persisting it would be a second copy of a truth the disk already
 * holds — free to rebuild at boot, and impossible to leave stale.
 */
const states = new Map<string, ThumbnailState>();

/**
 * Server side of `prototypes.thumbnails`. Push: the render job notifies on
 * completion, so a card updates itself. The loader serves the current map, so a
 * cold HTTP read still gets a value.
 */
export const prototypeThumbnailsServed = serveValue(prototypeThumbnails, {
  source: "external",
  changes: "notified",
  loader: () => Object.fromEntries(states),
});

/** What we last recorded for one prototype, if anything. */
export function readThumbnailState(name: string): ThumbnailState | undefined {
  return states.get(name);
}

/** Record one prototype's state and push it. */
export function setThumbnailState(name: string, state: ThumbnailState): void {
  states.set(name, state);
  prototypeThumbnailsServed.notify();
}

/**
 * Replace the whole map and push ONCE. The reconcile pass touches every
 * prototype, and N pushes for one edit is churn every open gallery would have
 * to re-render through.
 */
export function replaceThumbnailStates(
  next: Map<string, ThumbnailState>,
): void {
  states.clear();
  for (const [name, state] of next) states.set(name, state);
  prototypeThumbnailsServed.notify();
}
