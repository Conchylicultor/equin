import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { ExcludeFromChangeFeed } from "@plugins/network/plugins/live/plugins/change-feed/server";
import { autoResumeConfig } from "../core";
import { errorStoppedServed } from "./internal/error-stopped";
import { _sdkAgentsTable } from "./internal/tables";

export default {
  description:
    "The sdk runtime's portable half: the conversations_ext_sdk_agent side table (each agent's event cursor and the projection of its events — session id, busy/idle, the open question, the last turn and its rewind anchor — out of the change feed, being the consumer's per-batch checkpoint) and the conversations_ext_sdk_agent_stop side table (the part a live surface reads: the API-error stop and the account, written only when it changes), the pure event reducer, and the mapping of a launch onto the agent's options file; the runtime-sdk.error-stopped collection (active conversations whose agent's turn an API error stopped — a usage limit, a server error, a lost connection — with the CLI's kind of failure); the auto-resume setting (Resume agents when their usage limit resets).",
  contributions: [
    ...errorStoppedServed.declare,
    ExcludeFromChangeFeed({
      table: _sdkAgentsTable,
      reason:
        "The events consumer's private checkpoint, rewritten on every batch an agent writes; read only by its writer through the row lease. What a live surface reads of an agent (the API-error stop, the account) is conversations_ext_sdk_agent_stop, written only when it changes.",
    }),
    ConfigV2.Register({ descriptor: autoResumeConfig }),
  ],
} satisfies ServerPluginDefinition;
