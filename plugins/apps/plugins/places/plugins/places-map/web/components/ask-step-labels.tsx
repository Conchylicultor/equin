import type { StepLabelProps } from "@plugins/conversations/plugins/agent-thread/web";
import { searchCountOf } from "@plugins/apps/plugins/places/plugins/ask/core";

function queryOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const q = (input as Record<string, unknown>).query;
  return typeof q === "string" ? q : undefined;
}

/** "Searched Google for “chinese restaurant” around this map → 12 places". */
export function SearchStepLabel({ event }: StepLabelProps) {
  const query = queryOf(event.input);
  const count =
    event.result === undefined || event.result.isError === true
      ? null
      : searchCountOf(event.result.content);
  return (
    <>
      Searched Google
      {query === undefined ? null : (
        <span className="text-muted-foreground"> for “{query}”</span>
      )}{" "}
      around this map
      {count === null ? null : (
        <span className="text-muted-foreground">
          {" "}
          → {count} place{count === 1 ? "" : "s"}
        </span>
      )}
    </>
  );
}

/** A picks call the tool refused (an accepted one is a result, not a step). */
export function PicksStepLabel() {
  return <>Showed picks on the map</>;
}
