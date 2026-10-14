import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";
import { pagesEntityRef } from "@plugins/page/plugins/block-entity/core";

// One row per starred page, in the `page_blocks_ext_starred` entity-extension
// table that `server/internal/tables.ts` builds from this shape. Presence in the
// table = starred, so the plugin has no fields of its own; the row carries no
// order of its own either — the Favorites view's row order lives in data-view's
// `view-order`. `createdAt` (when the page was starred) rides on the wire as a
// plain field of the shape.
//
// It EXPOSES its presence to every list whose rows are blocks (`exposes` — the
// pages sidebar today): `starred`, a boolean, true exactly when the page has
// a row. So the sidebar's Favorites view is a filter on it, with no code
// naming this plugin.
export const starredPageShape = defineExtensionShape({
  key: "blockId",
  fields: {},
  wireTimestamps: ["createdAt"],
  exposes: {
    parent: pagesEntityRef,
    name: "starred",
    presence: { id: "starred", label: "Starred" },
  },
});
export const StarredPageRowSchema = starredPageShape.schema;
export type StarredPageRow = z.infer<typeof StarredPageRowSchema>;

// The favorites, as the WHOLE ordered set (`all`), NOT a lookup by id: the
// star toggles (`useStarredPageIds`) read starred-ness for whichever page they
// sit on, and the set holds at most one row per page, so its reader holds it
// entire — no favorite ever reads as unstarred past a window's edge. (The
// sidebar's `starred` field is the exposure above, folded into `pages.tree`.)
//
// Rows key on `blockId` (the side-table pk — the starred page's id); the
// server half is served from the extension handle in
// `server/internal/resource.ts`. Web consumers read it through
// `useStarredPageIds` (web/internal/use-starred-ids.ts).
//
// The key is `pages-starred.all`, not the old window's `pages-starred`: no
// bundle ever declared this key with another contract, so a tab on an older
// one gets `unknown-key` (a `skew` verdict) and never parses these rows.
export const starredPages = liveCollection("pages-starred.all", {
  row: StarredPageRowSchema,
  id: "blockId",
  all: {
    orderBy: [["blockId", "asc"]],
    unbounded: {
      reason:
        "at most one row per page, and the star toggles read starred-ness for any page",
    },
  },
});
