import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export type { ColumnExpr, SortKey } from "./internal/seek";
export {
  atOrBeforePredicate,
  orderByClauses,
  seekPredicate,
} from "./internal/seek";

export default {
  description:
    "Field-agnostic keyset pagination machinery: a null-aware keyset seek / at-or-before / order-by compiler over drizzle SQL, over keys the caller builds from declared columns. No data-view dependency, so any server-delegated windowed query can reuse it.",
} satisfies ServerPluginDefinition;
