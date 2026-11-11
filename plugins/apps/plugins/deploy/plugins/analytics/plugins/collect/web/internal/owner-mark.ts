import { z } from "zod";
import {
  defineStore,
  type Store,
} from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { OWNER_MARK_FRAGMENT, OWNER_UNMARK_FRAGMENT } from "../../core";

/**
 * This browser's owner mark (`core/internal/audience.ts`): one `true` entry
 * while the browser is marked as the site owner's, none otherwise.
 */
export const ownerMarkStore = defineStore({
  owner: "analytics.owner-mark",
  pageWide: {
    reason:
      "whether this browser is the site owner's, for the site's own visit counts",
  },
  label: "Site owner mark",
  area: "local",
  cap: "1 KB",
  ttl: Infinity,
  whenFull: "refuse",
  schema: z.literal(true),
});

/** The slice of the store the mark needs (the real one in the page, a map in a test). */
export type MarkStore = Pick<Store<true>, "read" | "write" | "remove">;

/**
 * Applies a mark link's fragment (`#equin-me` / `#equin-not-me`) to `store`;
 * any other fragment is left alone. A refused write is announced by the store
 * itself, and the browser then simply stays unmarked.
 */
export function applyOwnerFragment(hash: string, store: MarkStore): void {
  const fragment = hash.replace(/^#/, "");
  if (fragment === OWNER_MARK_FRAGMENT) store.write("", true);
  else if (fragment === OWNER_UNMARK_FRAGMENT) store.remove("");
}

/** Whether this browser is marked as the site owner's. */
export function isOwnerMarked(store: MarkStore): boolean {
  return store.read("").kind === "value";
}
