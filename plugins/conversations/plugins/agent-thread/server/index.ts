import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { threadRunsServed } from "./internal/runs";

export default {
  description:
    "Serves `agent-thread.runs` — the recent conversations launched in a scratch workspace, newest first, filterable by profile — over `_conversations` with the attempt joined (routed: a conversation write refills its own row).",
  contributions: [...threadRunsServed.declare],
} satisfies ServerPluginDefinition;
