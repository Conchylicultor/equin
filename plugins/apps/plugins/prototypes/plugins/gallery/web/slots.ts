import {
  defineDataViewSources,
  defineItemActions,
} from "@plugins/primitives/plugins/data-view/web";
import type { PrototypeMeta } from "@plugins/apps/plugins/prototypes/plugins/files/core";

/**
 * One gallery card: the prototype as listed, joined with its state — whether
 * the user has marked it Done, pinned or deleted it, and its one tag
 * (`state`'s `prototypes.state.all`, per-instance DB rows) — and its version
 * count (`prototypes.versionCounts`). Joined once, in the gallery, so the
 * `status` and `tag` fields, the muted tone and every card action read the
 * same value.
 */
export type PrototypeGalleryRow = PrototypeMeta & {
  done: boolean;
  pinned: boolean;
  tagId: string | null;
  /** When it was deleted — `null` for a live prototype. */
  deletedAt: Date | null;
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

/**
 * Per-card actions in the gallery's Trash view, where a card is a deleted
 * prototype. The gallery ships Restore.
 */
export const PrototypeTrashActions = defineItemActions<PrototypeGalleryRow>();

/**
 * What the gallery hands its sources: nothing — each source reads its own
 * prototypes. A named shape so a source's props say whose surface it feeds.
 */
export type PrototypeGalleryHostProps = Record<string, never>;

/**
 * The gallery's sources: one view bar over the live prototypes (`gallery`) and
 * the deleted ones (`trash`); each config row binds to one by its `source`.
 */
export const PrototypeGallerySources =
  defineDataViewSources<PrototypeGalleryHostProps>();
