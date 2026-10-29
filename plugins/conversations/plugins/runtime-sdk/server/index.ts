import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { autoResumeConfig } from "../core";
import { errorStoppedServed } from "./internal/error-stopped";

export default {
  portable: true,
  description:
    "The sdk runtime's portable half: the conversations_ext_sdk_agent side table (each agent's event cursor and the projection of its events — session id, busy/idle, the open question, the last turn and its rewind anchor), the pure event reducer, and the mapping of a launch onto the agent's options file; the runtime-sdk.error-stopped collection (active conversations whose agent's turn an API error stopped — a usage limit, a server error, a lost connection — with the CLI's kind of failure); the auto-resume setting (Resume agents when their usage limit resets).",
  contributions: [
    ...errorStoppedServed.declare,
    ConfigV2.Register({ descriptor: autoResumeConfig }),
  ],
} satisfies ServerPluginDefinition;
