import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import {
  compactionStopWaiver,
  contextCompactCapability,
} from "./internal/capability";
import { PendingTurn } from "@plugins/conversations/plugins/automatic-turn/server";
import { compactionTurn } from "./internal/compaction";
import { sendCompactionJob } from "./internal/jobs";
import { compactContextTool } from "./internal/tool";

export default {
  description:
    "An agent compacting its own context: the compact_context MCP tool (granted by context.compact) records the request in conversation_compactions; when the agent can take an automatic turn, self-compact.send types `/compact <keep>` then the continuation as an event turn. A pending request is a PendingTurn (every other automatic sender holds until it went out) and waives the stop gate; the capability's describe joins the Mandate section.",
  contributions: [
    contextCompactCapability,
    compactionStopWaiver,
    PendingTurn(compactionTurn),
    Trigger({
      on: conversationStatusChanged,
      do: sendCompactionJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [sendCompactionJob, compactContextTool],
} satisfies ServerPluginDefinition;
