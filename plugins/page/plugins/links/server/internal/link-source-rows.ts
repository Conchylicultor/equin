import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { parsed } from "@plugins/database/plugins/sql-projection/server";
import {
  aggregate,
  childrenJoin,
} from "@plugins/infra/plugins/query-resource/core";
import type { ServeAllCollectionOptions } from "@plugins/network/plugins/live/server";
import { _blocks, PAGE_BLOCK_TYPE } from "@plugins/page/plugins/editor/server";
import type { PageLinkSourcesRow } from "../../core";
import { _pageLinks } from "./tables";

// How `pageLinkSources` (core: every live page with the pages linking to it,
// key `page-links.sources`) binds to the database — the ONE spelling both the
// served collection (`./resources.ts`) and the tests
// (`./link-sources-oracle.test.ts`, which compiles it against a throwaway
// database and holds it equal to the old per-edge loader) read, so neither can
// drift from what ships.
//
// It reads the `page_blocks` TABLE, never `liveBlocks` (a routed compile reads
// a base table): the membership is spelled here — a page row (`type = 'page'`)
// that is not trashed (`deleted_at IS NULL`), the same set `pagesTree`
// serves. `linkedFrom` is a children join over `page_links` on
// `target_page_id` (led by `page_links_target_idx`): the distinct source pages
// of the page's edges, a self-link excluded — an edge row is per linking
// BLOCK, and this list is per page pair, so a page linking from three blocks
// is still one source.
//
// So an edge insert or delete — the reindexer's diff, the trash hook's drop,
// an FK cascade — is the refill of its target's row alone; a write to any
// page_blocks column but `id`, `type` and `deleted_at` (the ~1s `data.text`
// typing projection, a rename, a re-mint of `doc_rank`) reaches nothing.

const links = childrenJoin({
  alias: "links",
  table: _pageLinks,
  fk: _pageLinks.targetPageId,
  where: (c) => sql`${c.links.sourcePageId} <> ${c.links.targetPageId}`,
  aggregates: (c) => ({
    sources: aggregate(
      sql`array_agg(DISTINCT ${c.links.sourcePageId} ORDER BY ${c.links.sourcePageId})`,
      {
        decoder: parsed(z.array(z.string()), "page-links.sources"),
        sqlType: "text[]",
        notNull: true,
        ifNone: sql`ARRAY[]::text[]`,
      },
    ),
  }),
});

const joins = [links] as const;

export const linkSourceRowsServeOptions = {
  from: _blocks,
  where: and(eq(_blocks.type, PAGE_BLOCK_TYPE), isNull(_blocks.deletedAt))!,
  joins,
  columns: {
    linkedFrom: (j) => j.links.sources,
  },
} satisfies ServeAllCollectionOptions<
  typeof _blocks,
  PageLinkSourcesRow,
  typeof joins
>;
