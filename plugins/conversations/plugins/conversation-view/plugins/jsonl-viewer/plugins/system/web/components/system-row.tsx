import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { EventLine } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const infoIcon = symbol("info");

type SystemEvent = Extract<JsonlEvent, { kind: "system" }>;

export function SystemRow({ event }: { event: JsonlEvent }) {
  const e = event as SystemEvent;
  // Natural-case eyebrow consistent with the sibling lifecycle rows ("Queued",
  // "Task completed", "Resumed by harness · <source>"): a capitalized label and
  // the raw snake_case subtype de-coded behind a "·", never a `code:token`.
  const subtype = e.subtype ? e.subtype.replace(/[_-]+/g, " ") : "";
  // The full text stays available via the row's hover-only raw-JSON action, so
  // truncating the inline preview keeps the timeline quiet without hiding it.
  return (
    <EventLine
      icon={<Icon icon={infoIcon} className="size-3.5" />}
      label={`System${subtype ? ` · ${subtype}` : ""}`}
    >
      <span className="truncate">{e.text}</span>
    </EventLine>
  );
}
