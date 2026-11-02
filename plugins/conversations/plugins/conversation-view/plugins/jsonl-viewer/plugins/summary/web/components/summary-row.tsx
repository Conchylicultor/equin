import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Separator } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

type SummaryEvent = Extract<JsonlEvent, { kind: "summary" }>;

export function SummaryRow({ event }: { event: JsonlEvent }) {
  const e = event as SummaryEvent;
  return (
    <Inset y="sm">
      <Separator label={e.text} />
    </Inset>
  );
}
