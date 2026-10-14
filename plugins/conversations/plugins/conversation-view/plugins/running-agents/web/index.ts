import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/web";
import { TranscriptStats } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/web";
import { RunningAgentsBand } from "./components/running-agents-band";
import { AgentsStat } from "./components/agents-stat";

export default {
  description:
    "The sub-agents working for this conversation, in a card above the prompt box: a summary line (how many are working, how long the longest has been going) that folds the list, and one row per agent — what it was asked to do, what it is, what it last did and how many tokens it has produced. A finished agent lingers a few seconds showing 'done m:ss'; the card is not there at all when nothing is running. The transcript's stats strip carries an agents reading (how many agents, and the output tokens the conversation and they produced in all) that toggles the card to list every agent, finished or not",
  contributions: [
    Conversation.AbovePromptInput({
      id: "running-agents",
      requires: [],
      component: RunningAgentsBand,
    }),
    TranscriptStats.Item({ id: "agents", component: AgentsStat }),
  ],
} satisfies PluginDefinition;
