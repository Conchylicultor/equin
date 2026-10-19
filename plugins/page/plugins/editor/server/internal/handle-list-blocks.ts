import { and, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { listBlocks } from "../../core/endpoints";
import { PAGE_BLOCK_TYPE } from "../../core/schemas";
import { liveBlocks } from "./live-blocks";
import { pageBlocksServed } from "./resources";

export const handleListBlocks = implement(listBlocks, async ({ params }) => {
  const [page] = await db
    .select({ id: liveBlocks.id })
    // A trashed page is not addressable (404, like an unknown id).
    .from(liveBlocks)
    .where(
      and(
        eq(liveBlocks.id, params.pageId),
        eq(liveBlocks.type, PAGE_BLOCK_TYPE),
      ),
    )
    .limit(1);
  if (!page) throw new HttpError(404, "Page not found");
  // The page's content forest, sub-page rows included — read THROUGH the
  // served `pageBlocks` scope (`pageBlocksServed`), so this endpoint, the HTTP
  // twin of that resource, cannot project, filter or order the forest
  // differently: `(parent_id, rank)` is one ordering space, and a consumer that
  // sees only part of it mints fractional keys that collide with the rows it
  // cannot see. A sub-page is a leaf here — its own content is keyed
  // `page_id = <the sub-page>`, a different partition. The load is parsed by
  // the collection's row schema (`Block`, field for field).
  return pageBlocksServed.all.load({ pageId: params.pageId });
});
