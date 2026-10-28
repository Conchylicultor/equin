import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useClaudeCliCalls } from "./internal/use-claude-cli-calls";
export { ClaudeCliCallDetail } from "./components/claude-cli-call-detail";
export { SLOW_CALL_MS } from "./internal/format-call-duration";

export default {
  description:
    "Consumer half of the claude-cli call log: useClaudeCliCalls({correlationId, occurredAt}) answers 'which model calls produced this record?' as a calls / none / not-retained result, <ClaudeCliCallDetail> is the one rendering of a recorded call (header, meta grid, context with id chips, output or error, prompt, system — each copyable), and SLOW_CALL_MS is the duration past which a call reads as slow.",
  contributions: [],
} satisfies PluginDefinition;
