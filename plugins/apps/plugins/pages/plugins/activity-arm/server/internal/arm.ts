import { and, eq, isNull, sql } from "drizzle-orm";
import { activityServed } from "@plugins/activity/server";
import { expr } from "@plugins/infra/plugins/query-resource/core";
import { PAGE_BLOCK_TYPE } from "@plugins/page/plugins/editor/core";
import { _blocks } from "@plugins/page/plugins/editor/server";
import { pageActivityArm } from "../../core";

/**
 * Pages, bound into the activity union: the live page rows of `page_blocks`
 * (`type = 'page'`, not trashed — the membership `pagesTree` spells).
 *
 * `updatedAt` is the page ROW's own: it moves on a rename, a move, a kind
 * change — not on a content edit. A page's edit time (`editedAt`) reads the
 * `page_content_edited_at` rollup, a join only the `all` compiler takes; a
 * union arm's joins are window joins, so that is a follow-up.
 */
export const pageActivityServed = activityServed.arm(pageActivityArm, {
  from: _blocks,
  id: _blocks.id,
  base: (j) => ({
    title: expr(sql`(${j.base.data} ->> 'title')`, {
      decoder: String,
      sqlType: "text",
    }),
    updatedAt: j.base.updatedAt,
    createdAt: j.base.createdAt,
  }),
  extra: () => ({}),
  where: (j) =>
    and(eq(j.base.type, PAGE_BLOCK_TYPE), isNull(j.base.deletedAt))!,
});
