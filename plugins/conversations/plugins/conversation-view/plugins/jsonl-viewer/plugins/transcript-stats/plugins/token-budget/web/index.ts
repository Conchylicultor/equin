import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { JsonlViewer } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { TranscriptStats } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/web";
import { TokenBudgetStat } from "./components/token-budget-stat";
import { isTotalTokensReminder } from "../core";

export default {
  collapsed: true,
  description:
    "The agent's work allowance as a transcript stat: how many tokens the harness has charged against it up to the reading position, summed across the re-anchor it performs on every new request. Reports the total spent rather than the number the harness prints, which is a padded per-request allowance handed to the model and so reads as a constant. Owns both halves of the move — the stat, and the filter that takes the harness's repeated reminder rows out of the transcript flow they were cluttering.",
  contributions: [
    TranscriptStats.Item({ id: "token-budget", component: TokenBudgetStat }),
    JsonlViewer.EventFilter({
      id: "total-tokens-reminder",
      hide: isTotalTokensReminder,
    }),
  ],
} satisfies PluginDefinition;
