import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { setRowOrder } from "../core";
import { handleSetRowOrder } from "./internal/handle-set-row-order";
import { rowOrderServed } from "./internal/resource";

export { _dataViewRowOrder } from "./internal/tables";
export { applyRowOrder } from "./internal/handle-set-row-order";

export default {
  description:
    "Persists a per-view-instance manual row order keyed by (dataViewId, viewId, rowKey): a generic DB table, a push live resource, and a validating upsert endpoint that writes only the drag's bounded set (the moved row plus the seeds now ahead of it) rank-ascending — O(gesture), never a full replace, nothing deleted.",
  httpRoutes: {
    [setRowOrder.route]: handleSetRowOrder,
  },
  contributions: [...rowOrderServed.declare],
} satisfies ServerPluginDefinition;
