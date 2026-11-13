import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { TranscriptStats } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/web";
import { CostStat } from "./components/cost-stat";

export default {
  collapsed: true,
  description:
    "The session's API cost as a transcript stat: what the whole conversation has cost at API prices — its own transcripts and every sub-agent it launched, workflow agents included — read live from the conversation's usage totals (conversations.usage), with the tokens behind it on hover.",
  contributions: [TranscriptStats.Item({ id: "cost", component: CostStat })],
} satisfies PluginDefinition;
