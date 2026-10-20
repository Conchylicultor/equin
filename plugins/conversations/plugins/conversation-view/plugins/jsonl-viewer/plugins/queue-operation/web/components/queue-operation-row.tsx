import { Icon } from "@plugins/ui/plugins/icons/web";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { EventLine } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { QueuedPromptCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/queued-prompt-card/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";

const playlistAddIcon = symbol("playlist-add");
const northEastIcon = symbol("north-east");
const closeIcon = symbol("close");

type QueueOperationEvent = Extract<JsonlEvent, { kind: "queue-operation" }>;

const OPERATIONS: Record<string, { icon: IconRef; label: string }> = {
  enqueue: { icon: playlistAddIcon, label: "Queued" },
  dequeue: { icon: northEastIcon, label: "Sent to agent" },
  remove: { icon: closeIcon, label: "Removed from queue" },
};

// Background-task completions are split out into structured `task-notification`
// rows by the transcript parser, so this renderer only ever sees plain queued
// prompts. An `enqueue` with content shares the QueuedPromptCard appearance with
// the `queued_command` attachment (closed by default — this is the lifecycle
// marker, not the user's standing intent); the dequeue/remove markers stay
// compact one-liners on the ambient EventLine grammar.
export function QueueOperationRow({ event }: { event: JsonlEvent }) {
  const e = event as QueueOperationEvent;

  if (e.operation === "enqueue" && e.content) {
    return <QueuedPromptCard prompt={e.content} />;
  }

  const op = OPERATIONS[e.operation] ?? {
    icon: playlistAddIcon,
    label: e.operation,
  };
  const icon = op.icon;

  return (
    <EventLine
      icon={<Icon icon={icon} className="size-3.5" />}
      label={op.label}
    >
      {e.content ? <span className="truncate">{e.content}</span> : null}
    </EventLine>
  );
}
