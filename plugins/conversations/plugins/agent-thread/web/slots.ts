import {
  defineDispatchSlot,
  type DispatchContribution,
} from "@plugins/primitives/plugins/slot-render/web";
import {
  toolName,
  type ToolCallEvent,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { GenericStepLabel } from "./components/step-labels";

export interface StepLabelProps {
  event: ToolCallEvent;
}

export type StepLabelContribution = DispatchContribution<
  StepLabelProps,
  string
>;

export const AgentThreadSlots = {
  /**
   * How a thread's step reads: one line of words for one tool call ("Searched
   * Google for “chinese” around this map"). Keyed by the tool's OWN name — an
   * MCP tool's `mcp__<server>__<tool>` matches as `<tool>`, so a host labels
   * the tools it serves whatever the server is called. The label is inline
   * content: the step row draws it as one truncating line.
   *
   * Fallback: the tool's name and a one-line summary of its input.
   */
  StepLabel: defineDispatchSlot<StepLabelProps, string>({
    key: (p) => toolName(p.event.name).name,
    fallback: GenericStepLabel,
    docLabel: (c) =>
      typeof c.match === "string"
        ? c.match
        : c.match instanceof RegExp
          ? c.match.source
          : undefined,
  }),
};
