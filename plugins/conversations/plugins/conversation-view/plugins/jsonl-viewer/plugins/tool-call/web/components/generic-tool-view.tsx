import { inputSummary, type ToolRendererProps } from "../../core";
import { ToolCallCard } from "./tool-call-card";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return String(value);
  }
}

export function GenericToolView({ event }: ToolRendererProps) {
  return (
    <ToolCallCard event={event} summary={inputSummary(event.input)}>
      {event.input != null && (
        <Scroll axis="both" className="max-h-96 rounded-md bg-muted/60">
          <Text as="pre" variant="caption" className="p-sm">
            {formatJson(event.input)}
          </Text>
        </Scroll>
      )}
      {event.result && (
        <Scroll
          className={`max-h-96 rounded-md ${
            event.result.isError && !event.result.outcomeUnknown
              ? "bg-destructive/10"
              : "bg-muted/60"
          }`}
        >
          <Text
            as="pre"
            variant="caption"
            className={`whitespace-pre-wrap break-words p-sm ${
              event.result.isError && !event.result.outcomeUnknown
                ? "text-destructive"
                : ""
            }`}
          >
            {event.result.content || "(empty)"}
          </Text>
        </Scroll>
      )}
    </ToolCallCard>
  );
}
