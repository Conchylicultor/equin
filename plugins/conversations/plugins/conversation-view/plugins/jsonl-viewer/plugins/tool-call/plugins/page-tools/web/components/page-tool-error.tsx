import type { ToolCall } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import {
  ToolCode,
  ToolSection,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";

/**
 * A refused page write, verbatim. The server's refusals are written to be read
 * (a 403 names the block that was edited outside every card), so the sentence is
 * the whole affordance.
 *
 * Same appearance as the Edit tool's error detail: the tool-call Output
 * section, in the error tone.
 */
export function PageToolError({ result }: { result: ToolCall["result"] }) {
  if (!result || !result.isError) return null;
  return (
    <ToolSection label="Output" copyText={result.content}>
      <ToolCode tone="error">{result.content || "Error"}</ToolCode>
    </ToolSection>
  );
}
