import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { compactionContext } from "../core";
import { handleCompactionContext } from "./internal/handler";

export { CompactionContext } from "./internal/registry";
export type { CompactionContextSource } from "./internal/registry";
export { _compactionContextSends } from "./internal/tables";
export {
  onCompactionContextSent,
  pendingSends,
  settleSend,
} from "./internal/sends";
export type { CompactionContextSend } from "./internal/sends";

export default {
  description:
    "The compaction-context backend: the CompactionContext contribution (a plugin's restore — re-record what the compacted agent no longer holds, return the text to hand back; a `whole` part is never cut, a `fit` part is given the room left under the hook's cap) and the POST /api/conversations/:id/compaction-context endpoint the SessionStart(compact) hook calls, joining every part and recording the answer (compaction_context_sends) for delivery-check to confirm against the transcript.",
  httpRoutes: {
    [compactionContext.route]: handleCompactionContext,
  },
} satisfies ServerPluginDefinition;
