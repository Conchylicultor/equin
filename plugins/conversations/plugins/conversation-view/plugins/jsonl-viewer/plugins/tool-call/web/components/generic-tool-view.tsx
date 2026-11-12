import { inputSummary, type ToolRendererProps } from "../../core";
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

export function GenericToolView({ event }: ToolRendererProps) {
  const input = event.input != null ? formatJson(event.input) : undefined;
  return (
    <ToolCallCard event={event} summary={inputSummary(event.input)}>
      {input !== undefined && (
        <ToolSection label="Input" copyText={input}>
          <ToolCode>{input}</ToolCode>
        </ToolSection>
      )}
      <ToolOutput event={event} />
    </ToolCallCard>
  );
}
