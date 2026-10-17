import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { compactionContext } from "../core/endpoints";
import { handleCompactionContext } from "./internal/handler";

export { CompactionContext } from "./internal/registry";
export type { CompactionContextSource } from "./internal/registry";
export { compactionHookEntry } from "./internal/hook-entry";

export default {
  description:
    "The compaction-context backend: the CompactionContext contribution (a plugin's restore(conversationId) — re-record what the compacted agent no longer holds, return the text to hand back) and the POST /api/conversations/:id/compaction-context endpoint the SessionStart(compact) hook calls, joining every contribution's part.",
  httpRoutes: {
    [compactionContext.route]: handleCompactionContext,
  },
} satisfies ServerPluginDefinition;
