import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { TranscriptStats } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/web";
import { UsageStat } from "./components/usage-stat";

export default {
  description:
    "Context and output token usage as a transcript stat: the current context window and the output produced, folded from each message's own usage record up to the reading position.",
  contributions: [TranscriptStats.Item({ id: "usage", component: UsageStat })],
} satisfies PluginDefinition;
