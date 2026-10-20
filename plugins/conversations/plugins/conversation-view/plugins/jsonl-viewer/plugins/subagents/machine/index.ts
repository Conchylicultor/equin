import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { subagentActivityServed } from "./internal/activity-resource";
import { subagentTranscriptServed } from "./internal/transcript-resource";

export default {
  description:
    "The sub-agent live values, desktop-only half: what every sub-agent of a conversation is doing right now and one sub-agent's own transcript, both read and watched from the `subagents/` directories on disk, so a host without the computer answers them unavailable.",
  contributions: [
    ...subagentActivityServed.declare,
    ...subagentTranscriptServed.declare,
  ],
} satisfies MachinePluginDefinition;
