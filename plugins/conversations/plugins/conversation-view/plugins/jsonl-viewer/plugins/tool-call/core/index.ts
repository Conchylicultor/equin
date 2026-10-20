import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

export type ToolCallEvent = Extract<JsonlEvent, { kind: "tool-call" }>;

export interface ToolRendererProps {
  event: ToolCallEvent;
}

export { toolName, type ToolName } from "./tool-name";
