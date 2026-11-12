import { inputSummary, type ToolCallEvent } from "../../core";
import { ToolCallCard } from "./tool-call-card";
import { ToolCode, ToolOutput, ToolSection } from "./tool-section";

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return String(value);
  }
}

/**
 * Any tool call, drawn from its raw input: the card of a tool no renderer
 * knows, and of a call whose input its renderer does not draw (`mismatch`:
 * what did not match the renderer's schema — a call the model got wrong,
 * which the tool refused, or a tool whose input changed since).
 */
export function GenericToolView({
  event,
  mismatch,
}: {
  event: ToolCallEvent;
  mismatch?: string;
}) {
  const input = event.input != null ? formatJson(event.input) : undefined;
  return (
    <ToolCallCard
      event={event}
      summary={inputSummary(event.input)}
      note={mismatch !== undefined ? "· unexpected input" : undefined}
    >
      {input !== undefined && (
        <ToolSection label="Input" copyText={input}>
          <ToolCode>{input}</ToolCode>
        </ToolSection>
      )}
      {mismatch !== undefined && (
        <ToolSection label="Not what this tool's card draws">
          <ToolCode>{mismatch}</ToolCode>
        </ToolSection>
      )}
      <ToolOutput event={event} />
    </ToolCallCard>
  );
}
