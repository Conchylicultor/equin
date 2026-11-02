import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  nextRankIn,
  nextRankUnder,
  rankAfterSibling,
} from "./internal/helpers";
export type { RankExecutor } from "./internal/helpers";
export { rankAdjacentTo } from "./internal/adjacent";
export type { RankAdjacentRow } from "./internal/adjacent";
// Re-exported so agents implementing a ranked table find both the column type
// and the helpers in one place. `withRank` joins them for the same reason: it is
// the read-side of a rank column (the storage->wire conversion), and every
// caller is a server read path.
export { rankText, withRank } from "@plugins/primitives/plugins/rank/core";
export type { Ranked } from "@plugins/primitives/plugins/rank/core";

export default {
  description:
    "Fractional-indexing rank primitive. THE authoritative source for sortable rank strings. Use nextRankIn() for flat tables, nextRankUnder() for parent-scoped lists. Re-exports rankText column type. Never use floats or integers for ordering.",
} satisfies ServerPluginDefinition;
