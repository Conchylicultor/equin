import { defineItemActions } from "@plugins/primitives/plugins/data-view/web";
import type { PrototypeMeta } from "@plugins/apps/plugins/prototypes/plugins/files/core";

/**
 * One gallery card: the prototype as listed, joined with its status — whether
 * the user has marked it Done and whether they pinned it (`files`'
 * `prototypes.statuses`) — and its version count (`prototypes.versionCounts`).
 * Joined once, in the gallery, so the `status` field, the muted tone and every
 * card action read the same value.
 */
export type PrototypeGalleryRow = PrototypeMeta & {
  done: boolean;
  pinned: boolean;
  /** How many versions it has; `undefined` when no count is known (never 0). */
  versions: number | undefined;
};

/**
 * Per-card actions in the gallery (cards and list rows alike). The gallery
 * ships two — the pin and the Done circle, hover actions that rest while set —
 * and anything else a card grows is a contribution (`present`'s Open in a new
 * tab).
 */
export const PrototypeCardActions = defineItemActions<PrototypeGalleryRow>();
