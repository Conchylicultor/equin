import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { TranscriptStats } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/web";
import { ContextStat } from "./components/context-stat";

export default {
  collapsed: true,
  description:
    "The context window as a transcript stat: a ring at the end of the strip showing how full the agent's window is against where the harness compacts it (the harness's own measure, conversations.context-usage), opening a card with the breakdown — the conversation's messages, the setup it starts with (system prompt, tools, memory files, skills, MCP) and what is free — and a Compact action that sends /compact with optional compaction instructions.",
  contributions: [
    TranscriptStats.Item({ id: "context", component: ContextStat }),
  ],
} satisfies PluginDefinition;
