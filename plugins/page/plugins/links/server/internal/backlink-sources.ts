import { and, asc, eq, ne, sql } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import { liveBlocks } from "@plugins/page/plugins/editor/server";
import { _pageLinks } from "./tables";

/** One page linking to another: its id (a page address) and its title. */
export interface BacklinkSource {
  id: string;
  title: string;
}

/**
 * The live pages that link TO `pageId` — id and title only, ordered by title
 * then id (the backlinks panel's order), one entry per page however many of its
 * blocks carry the link, a self-link excluded (as `pageLinkTargets` does).
 *
 * The plain server read for a caller that states "who links here" as text — the
 * `<page-meta>` header an agent's `read_page` opens with — where the backlinks
 * panel's live value (`./resources.ts`) also derives icons, ancestor paths and a
 * snippet per source. No snippet here on purpose: it is an excerpt of a block
 * of ANOTHER page, read without that page's audience policy, so a reader that
 * wants the context reads the source page through its own gate.
 *
 * Live rows only (`liveBlocks`): a trashed source page's edges are dropped by
 * the trash hook, and the join makes that a fact rather than a race.
 */
export async function loadBacklinkSources(
  pageId: string,
  executor: DbExecutor = db,
): Promise<BacklinkSource[]> {
  // `coalesce`: a page with no title of its own has no `title` key at all.
  const title = sql`coalesce(${liveBlocks.data} ->> 'title', '')`.mapWith(
    String,
  );
  const rows = await executor
    .selectDistinct({ id: liveBlocks.id, title })
    .from(_pageLinks)
    .innerJoin(liveBlocks, eq(_pageLinks.sourcePageId, liveBlocks.id))
    .where(
      and(
        eq(_pageLinks.targetPageId, pageId),
        ne(_pageLinks.sourcePageId, pageId),
      ),
    )
    .orderBy(asc(title), asc(liveBlocks.id));
  return rows;
}
