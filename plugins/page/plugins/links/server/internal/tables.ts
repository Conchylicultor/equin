import { index } from "drizzle-orm/pg-core";
import { defineEntity } from "@plugins/infra/plugins/entities/server";
import { _blocks } from "@plugins/page/plugins/editor/server";
import { pageLinksEntityRef } from "../../core";

// Edge table: one row per (source page → target page, linking block). Built by
// the reindexer from the source page's blocks via the extractor registry. Both
// page endpoints are `type="page"` blocks, and `sourceBlockId` is the content
// block whose data carried the link (the block a backlink's snippet is read
// from). All three FK → page_blocks with ON DELETE CASCADE, so deleting a page
// — or purging the one block that linked — removes the edges it carried.
// Backlinks are queried by `targetPageId`, hence the dedicated index.
//
// `first` marks, per (source page, target page) pair, the edge of the FIRST
// linking block in the source page's document order — the block a backlink's
// snippet is read from. Written by the reindexer (which reads the page's whole
// forest anyway), so a backlinks reader follows one block per source page and
// never reads a page's forest to rank them; it moves only when which block
// comes first does.
//
// An entity (`defineEntity` over the one field record in `../../core`), so the
// backlinks' edge read (`pageBacklinkEdges`) is a collection `from` it.
export const pageLinksEntity = defineEntity(pageLinksEntityRef, {
  primaryKey: ["sourcePageId", "targetPageId", "sourceBlockId"],
  columns: {
    sourcePageId: {
      references: { column: () => _blocks.id, onDelete: "cascade" },
    },
    targetPageId: {
      references: { column: () => _blocks.id, onDelete: "cascade" },
    },
    sourceBlockId: {
      references: { column: () => _blocks.id, onDelete: "cascade" },
    },
    first: { default: false },
  },
  indexes: (t) => [index("page_links_target_idx").on(t.targetPageId)],
});

// drizzle-kit schema-glob discovery, and the name every reader and writer uses.
export const _pageLinks = pageLinksEntity.table;
