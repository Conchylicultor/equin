import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { Timestamp } from "./timestamp";

export function TimestampAction({ event }: { event: JsonlEvent }) {
  return (
    <Timestamp
      at={event.at}
      className="tabular-nums text-2xs text-muted-foreground"
    />
  );
}
