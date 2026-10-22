import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { subagentActivityServed } from "./internal/activity-resource";
import { subagentTranscriptServed } from "./internal/transcript-resource";

// Discovery, for a consumer that accounts over a conversation's whole tree (its
// usage totals): the sub-agent directory beside each ANCHORED session file, and
// every agent below those roots. Hand `subagentDirOf` only paths that came from
// `resolveConversationTranscriptPaths` — that derivation is the ownership guard.
export { subagentDirOf, listSubagentEntries } from "./internal/discovery";

export default {
  description:
    "The sub-agents' desktop-only half: discovery of a conversation's sub-agents from the `subagents/` directory beside each of its anchored session transcripts (what conversations/usage accounts over), and the live values — what every sub-agent of a conversation is doing right now and one sub-agent's own transcript, both read and watched from the `subagents/` directories on disk, so a host without the computer answers them unavailable.",
  contributions: [
    ...subagentActivityServed.declare,
    ...subagentTranscriptServed.declare,
  ],
} satisfies MachinePluginDefinition;
