import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { conversationSummariesServed } from "./internal/resources";
import { IdKinds } from "@plugins/ids/server";
import { summaryIdKind } from "../core";

export { _conversationSummaries } from "./internal/tables";

export default {
  portable: true,
  description:
    "On-demand structured summaries of conversations: phase, flags, next action, served live. Curated by Sonnet via MCP (the tool is the machine half's). Append-only history.",
  contributions: [
    IdKinds.Kind({ kind: summaryIdKind }),
    ...conversationSummariesServed.declare,
  ],
} satisfies ServerPluginDefinition;
