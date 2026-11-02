import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import { starredPagesServed } from "./internal/resource";
import { handlePutPageStarred } from "./internal/routes";
import { putPageStarred } from "../shared/endpoints";
import { pageBlocksStarred } from "./internal/tables";

export { pageBlocksStarred } from "./internal/tables";
export { setPageStarred } from "./internal/mutations";

export default {
  description:
    "Starred-pages side-table (page_blocks_ext_starred): presence-only marker plus the star toggle endpoint, and its presence exposed as the `starred` field of every list whose rows are blocks (LiveColumns.Expose).",
  contributions: [
    ...starredPagesServed.declare,
    // `starred`, folded into every list whose rows are blocks (pages.tree).
    LiveColumns.Expose(pageBlocksStarred),
  ],
  httpRoutes: {
    [putPageStarred.route]: handlePutPageStarred,
  },
} satisfies ServerPluginDefinition;
