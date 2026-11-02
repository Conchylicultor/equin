import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export type {
  ColumnExpr,
  KeysetColumnBinding,
  KeysetColumnMap,
  SortKey,
  Tiebreaker,
} from "./internal/seek";
export {
  atOrBeforePredicate,
  buildSortKeys,
  orderByClauses,
  seekPredicate,
  keyValuesOf,
} from "./internal/seek";

export default {
  description:
    "Field-agnostic keyset pagination machinery: the sort-rule types (core) and a null-aware keyset seek / at-or-before / order-by compiler over drizzle SQL (server). No data-view dependency, so any server-delegated windowed query can reuse it.",
} satisfies ServerPluginDefinition;
