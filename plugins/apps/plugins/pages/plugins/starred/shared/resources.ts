import type { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

// One row per starred page, in the `page_blocks_ext_starred` entity-extension
// table that `server/internal/tables.ts` builds from this shape. Presence in the
// table = starred, so the plugin has no fields of its own; the row carries no
// order of its own either — the Favorites view's row order lives in data-view's
// `view-order`. `createdAt` (when the page was starred) rides on the wire as a
// plain field of the shape.
export const starredPageShape = defineExtensionShape({
  key: "blockId",
  fields: {},
  wireTimestamps: ["createdAt"],
});
export const StarredPageRowSchema = starredPageShape.schema;
export type StarredPageRow = z.infer<typeof StarredPageRowSchema>;

// The favorites, as the WHOLE ordered set (`all`), NOT a lookup by id: the
// dominant consumer is `StarredField`, which needs starred-ness for EVERY row
// the `pages-sidebar` DataView filters over. An id-set read would have to name
// every page id; the favorites set holds at most one row per page, so its
// reader holds it entire — no favorite ever reads as unstarred past a
// window's edge. Mirrors the sibling `agent-origin` plugin, which contributes
// the same kind of Set-backed field into the same `PageTree.Fields` slot.
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
        "at most one row per page, and the pages sidebar projects starred-ness for every page",
    },
  },
});
