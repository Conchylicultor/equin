import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { Separator } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

type SummaryEvent = Extract<JsonlEvent, { kind: "summary" }>;

export function SummaryRow({ event }: { event: JsonlEvent }) {
  const e = event as SummaryEvent;
  return (
    // eslint-disable-next-line spacing/no-adhoc-spacing -- vertical self-margin spacing the summary separator from adjacent transcript rows; the jsonl list parent owns no per-row gap
    <div className="my-2">
      <Separator label={e.text} />
    </div>
  );
}
