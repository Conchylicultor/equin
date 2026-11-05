import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import {
  aggregate,
  childrenJoin,
} from "@plugins/network/plugins/live/plugins/query-resource/core";
import { materializeJoin } from "@plugins/network/plugins/live/plugins/query-resource/server";
import type { ServeCollectionOptions } from "@plugins/network/plugins/live/server";
import { _blocks, PAGE_BLOCK_TYPE } from "@plugins/page/plugins/editor/server";
import type { PageLinkTargetsRow } from "../../core";
import { _pageLinkTargets } from "./rollup-table";
import { _pageLinks } from "./tables";

// How `pageLinkTargets` (core: a live page with the pages it links to, key
// `page-links.targets`, read by id) binds to the database — the ONE spelling
// both the served collection (`./resources.ts`) and the oracle
// (`./link-targets-oracle.test.ts`) read, so neither can drift from what ships.
//
// The targets are a MATERIALIZED children join (query-resource's
// `materializeJoin`, a derived-tables rollup on the change feed): per page,
// the distinct `target_page_id`s of its `page_links` edges by
// `source_page_id`, a self-link excluded — an edge row is per linking BLOCK,
// this list is per page pair. Materialized because an unmaterialized grouped
// join is `all`-only, and this collection is read by id: the sidebar reads the
// rows its tree windows hold, never every page.
//
// So an edge insert or delete — the reindexer's diff, the trash hook's drop,
// an FK cascade — re-aggregates its SOURCE page's row alone (one aggregate
// over that page's edges, `page_links_pkey`'s leading `source_page_id`); a
// `:rows` reader holding that page hears of it only when the stored list
// changed. The base is `page_blocks` with `pagesTree`'s membership (a live
// page row), so a trashed page reads not found; a write to a page_blocks
// column the route does not read (the ~1s `data.text` typing projection, a
// rename) reaches nothing.

/** Per page, the distinct pages it links to, stored per page (`page_link_targets`). */
export const pageLinkTargetsJoin = materializeJoin(
  childrenJoin({
    alias: "links",
    table: _pageLinks,
    fk: _pageLinks.sourcePageId,
    where: (c) => sql`${c.links.targetPageId} <> ${c.links.sourcePageId}`,
    aggregates: (c) => ({
      targets: aggregate(
        sql`array_agg(DISTINCT ${c.links.targetPageId} ORDER BY ${c.links.targetPageId})`,
        {
          decoder: parsed(z.array(z.string()), "page-links.targets"),
          sqlType: "text[]",
          notNull: true,
          ifNone: sql`ARRAY[]::text[]`,
        },
      ),
    }),
  }),
  { host: _blocks, table: _pageLinkTargets },
);

const joins = [pageLinkTargetsJoin.join()] as const;

export const linkTargetRowsServeOptions = {
  from: _blocks,
  where: and(eq(_blocks.type, PAGE_BLOCK_TYPE), isNull(_blocks.deletedAt))!,
  joins,
  columns: {
    linksTo: (j) => j.links.targets,
  },
} satisfies ServeCollectionOptions<
  typeof _blocks,
  PageLinkTargetsRow,
  typeof joins,
  never
>;
