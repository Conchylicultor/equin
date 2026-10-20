import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import { EventLine } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { FilePath } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web";

const historyIcon = symbol("history");

type FileCheckpointEvent = Extract<JsonlEvent, { kind: "file-checkpoint" }>;

// Harness bookkeeping, not conversation: the Edit/Write that follows already
// shows the change itself. What the row adds is that a rewind past this point
// restores the file — or deletes it, when the agent created it — so that is
// all it says, on the ambient EventLine grammar.
export function FileCheckpointRow({ event }: { event: JsonlEvent }) {
  const e = event as FileCheckpointEvent;
  return (
    <EventLine
      icon={<Icon icon={historyIcon} className="size-3.5" />}
      label="Checkpoint"
    >
      <span className={yieldClass("x")}>
        <FilePath filePath={e.path} />
      </span>
      {e.created && <Rigid as="span">· new file</Rigid>}
    </EventLine>
  );
}
