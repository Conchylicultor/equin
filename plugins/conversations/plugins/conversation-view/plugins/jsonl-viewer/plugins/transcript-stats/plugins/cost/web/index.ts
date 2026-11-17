import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { TranscriptStats } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/web";
import { CostStat } from "./components/cost-stat";

export default {
  collapsed: true,
  description:
    "The session's API cost as a transcript stat, up to the reading position: what the conversation had cost at API prices by the last row on screen — its own transcripts and every sub-agent it launched, workflow agents included, a sub-agent's spend counted when it happened. At the end it reads the live usage totals (conversations.usage, with the tokens behind it on hover); scrolled back, the cost at that row's instant (conversations.usage.cost-at), keeping the last priced reading while the next one loads.",
  contributions: [TranscriptStats.Item({ id: "cost", component: CostStat })],
} satisfies PluginDefinition;
