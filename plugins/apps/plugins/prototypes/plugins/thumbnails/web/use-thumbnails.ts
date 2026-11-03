import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { prototypeThumbnails, type ThumbnailState } from "../core";

/**
 * Thumbnail state for every prototype, keyed by directory slug.
 *
 * Exported as a hook, rather than hidden inside the card, so the surface that
 * owns the cards subscribes at the SAME moment it subscribes to the list they
 * come from. That ordering is the whole point: a value is filled by the
 * subscription's first answer, which is asked for when its first subscriber
 * mounts, so a card that subscribed to its own picture could only ever ask
 * AFTER the list it belongs to had already painted — one guaranteed round trip
 * of stand-in cover on every single load, which is exactly the flicker
 * (gradient, then screenshot) this replaces.
 *
 * Gate the cards on this together with the list (`useCombinedResources`) and
 * the cover is right the first time it is painted.
 */
export function usePrototypeThumbnails(): ResourceResult<
  Record<string, ThumbnailState>
> {
  return useLive(prototypeThumbnails);
}
