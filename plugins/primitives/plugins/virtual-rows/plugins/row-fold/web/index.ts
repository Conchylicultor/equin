import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useRowFold } from "./internal/use-row-fold";
export type {
  RowFold,
  RowFoldHostProps,
  RowFoldProps,
  UseRowFoldOptions,
} from "./internal/use-row-fold";

export default {
  description:
    "Disclosure motion for flat lists: useRowFold — given the rows and the open keys they were flattened under, rows a disclosure reveals grow in, rows it hides fold out (kept drawn until gone) and the rows below slide; any other change (scroll, search, live data, paging) lands as is. Owned by the flat renderers (VirtualRows, DataTable). Core: the pure disclosure diff; the fold timing is collapsible's (FOLD_MS / FOLD_EASING), one clock for every fold.",
  contributions: [],
} satisfies PluginDefinition;
