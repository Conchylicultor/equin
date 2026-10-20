import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { SubagentPaneBody } from "./components/subagent-pane-body";
export { SubagentDuration } from "./components/subagent-duration";
export { SubagentLastStep } from "./components/subagent-last-step";
export { useSubagentStatus } from "./internal/use-subagent-status";
export { useConversationSubagents } from "./internal/use-subagent-statuses";
export type {
  SubagentStatus,
  SubagentEntry,
  SubagentsUnavailable,
} from "./internal/use-subagent-statuses";
export { subagentStateDisplay } from "./internal/run-state-display";
export type { SubagentStateDisplay } from "./internal/run-state-display";

export default {
  description:
    "The sub-agent surfaces: how one sub-agent is going (state, elapsed, the one thing it most recently did) for the card that launched it, and the pane body that shows its write-up and its own live transcript, drawn by the conversation's own TranscriptView.",
} satisfies PluginDefinition;
