import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { parentFactsServed } from "./internal/served";

// Discovery, for a consumer that accounts over a conversation's whole tree (its
// usage totals): the sub-agent directory beside each ANCHORED session file, and
// every agent below those roots. Hand `subagentDirOf` only paths that came from
// `resolveConversationTranscriptPaths` — that derivation is the ownership guard.
export { subagentDirOf, listSubagentEntries } from "./internal/discovery";

export default {
  description:
    "Discovers a conversation's sub-agents from the `subagents/` directory beside each of its anchored session transcripts (the discovery conversations/usage accounts over), plus the reads behind the two live values the machine half serves: what every sub-agent is doing right now (one bounded tail read per change), and one sub-agent's own transcript, parsed by the same reader as the main conversation; it serves the parent-transcript facts sub-agent state joins on (Agent / Workflow calls, task notifications, idle and resume times), folded over the whole parent transcript.",
  contributions: [...parentFactsServed.declare],
} satisfies ServerPluginDefinition;
