import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { EventLine } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  API_ERROR,
  stopErrorLabel,
  USAGE_LIMIT_ERROR,
} from "@plugins/conversations/plugins/runtime-sdk/core";
import { ResumeOnStop } from "./resume-on-stop";

const warningIcon = symbol("warning");

type ApiErrorEvent = Extract<JsonlEvent, { kind: "api-error" }>;

/** The eyebrow for the CLI's kind of failure: a usage limit reads as one. */
function labelOf(error: string | undefined): string {
  if (error === USAGE_LIMIT_ERROR) return "Usage limit";
  const kind = stopErrorLabel(error);
  return kind === API_ERROR ? API_ERROR : `${API_ERROR} · ${kind}`;
}

export function ApiErrorRow({ event }: { event: JsonlEvent }) {
  const e = event as ApiErrorEvent;
  // The CLI's text says everything the user needs (the limit and when it
  // resets, or what failed), so it is shown whole, never truncated.
  return (
    <EventLine
      icon={<Icon icon={warningIcon} className="size-3.5 text-warning" />}
      label={<span className="text-warning">{labelOf(e.error)}</span>}
    >
      <span className="text-foreground">{e.text}</span>
      <ResumeOnStop />
    </EventLine>
  );
}
