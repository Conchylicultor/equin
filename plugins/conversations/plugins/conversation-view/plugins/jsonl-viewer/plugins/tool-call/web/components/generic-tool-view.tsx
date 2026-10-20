import type { ToolRendererProps } from "../../core";
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

function inputDescription(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("description" in input))
    return undefined;
  const desc = (input as Record<string, unknown>).description;
  return typeof desc === "string" ? desc : undefined;
}

export function GenericToolView({ event }: ToolRendererProps) {
  return (
    <ToolCallCard event={event} summary={inputDescription(event.input)}>
      {event.input != null && (
        <Scroll
          axis="both"
          // eslint-disable-next-line spacing/no-adhoc-spacing -- mt-2 offsets the input block from the card header
          className="mt-2 max-h-96 rounded-md bg-muted/60"
        >
          <Text as="pre" variant="caption" className="p-sm">
            {formatJson(event.input)}
          </Text>
        </Scroll>
      )}
      {event.result && (
        <Scroll
          // eslint-disable-next-line spacing/no-adhoc-spacing -- mt-2 separates the result block from the input block above
          className={`mt-2 max-h-96 rounded-md ${
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
