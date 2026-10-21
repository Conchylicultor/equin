import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { AgentThreadSlots as AgentThreadSlotGroup } from "./slots";
import {
  AgentStepLabel,
  AskUserQuestionStepLabel,
  BashStepLabel,
  EditStepLabel,
  GlobStepLabel,
  GrepStepLabel,
  ReadStepLabel,
  TodoWriteStepLabel,
  ToolSearchStepLabel,
  WebFetchStepLabel,
  WebSearchStepLabel,
  WriteStepLabel,
} from "./components/step-labels";

export { useThreadRuns } from "./internal/use-thread-runs";
export { useStartThread } from "./internal/use-start-thread";
export type {
  StartThreadOptions,
  StartThreadRequest,
  StartThreadResult,
} from "./internal/use-start-thread";
export { AgentThreadSlots } from "./slots";
export type { StepLabelContribution, StepLabelProps } from "./slots";
export { AgentThread } from "./components/agent-thread";
export type { AgentThreadProps } from "./components/agent-thread";
export { AgentThreadView } from "./components/agent-thread-view";
export { EndThreadButton } from "./components/end-thread-button";
export type { EndThreadButtonProps } from "./components/end-thread-button";
export type {
  AgentThreadViewProps,
  RenderThreadResult,
  ResultWords,
} from "./components/agent-thread-view";
export { StepLabel } from "./components/step-list";
export {
  useLatestResult,
  useThread,
  useThreadProgress,
  useThreadTurns,
} from "./internal/use-thread";
export type { ThreadSnapshot } from "./internal/use-thread";

export default {
  description:
    "Agent thread: the embedded conversation view apps host for the background agents they start — <AgentThread> (user bubbles, the agent's tool calls as a live step list labelled through the AgentThreadSlots.StepLabel dispatch, its answer, the host's own result cards, a composer that resumes an ended conversation), EndThreadButton (Done: close the conversation and drop its task), the hooks a host's other surfaces read (useThreadTurns, useThreadProgress, useLatestResult), generic step labels for the common built-in tools, and useThreadRuns (a host's recent runs under its scratch profile).",
  slots: AgentThreadSlotGroup,
  contributions: [
    AgentThreadSlotGroup.StepLabel({ match: "Read", component: ReadStepLabel }),
    AgentThreadSlotGroup.StepLabel({
      match: "Write",
      component: WriteStepLabel,
    }),
    AgentThreadSlotGroup.StepLabel({ match: "Edit", component: EditStepLabel }),
    AgentThreadSlotGroup.StepLabel({ match: "Bash", component: BashStepLabel }),
    AgentThreadSlotGroup.StepLabel({
      match: "WebSearch",
      component: WebSearchStepLabel,
    }),
    AgentThreadSlotGroup.StepLabel({
      match: "WebFetch",
      component: WebFetchStepLabel,
    }),
    AgentThreadSlotGroup.StepLabel({ match: "Grep", component: GrepStepLabel }),
    AgentThreadSlotGroup.StepLabel({ match: "Glob", component: GlobStepLabel }),
    AgentThreadSlotGroup.StepLabel({
      match: "ToolSearch",
      component: ToolSearchStepLabel,
    }),
    AgentThreadSlotGroup.StepLabel({
      match: "TodoWrite",
      component: TodoWriteStepLabel,
    }),
    AgentThreadSlotGroup.StepLabel({
      match: "AskUserQuestion",
      component: AskUserQuestionStepLabel,
    }),
    AgentThreadSlotGroup.StepLabel({
      match: /^(Agent|Task)$/,
      component: AgentStepLabel,
    }),
  ],
} satisfies PluginDefinition;
