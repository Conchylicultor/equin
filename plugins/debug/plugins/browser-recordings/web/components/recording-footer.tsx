import type { ToolFooterProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { ThumbnailPlaceholder } from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  browserRecordedCalls,
  browserRecordingRuns,
  isRecordedToolCall,
} from "../../core";
import { RunStrip } from "./run-strip";

/**
 * The recording of the browser a tool call drove, as its card's footer: one
 * filmstrip per run — an e2e script's steps, or a browser_* call's frame.
 * Its frames join the transcript's gallery, so the viewer steps from one
 * call's screenshot to the next.
 */
export function RecordingFooter({ event }: ToolFooterProps) {
  if (!isRecordedToolCall(event.name, event.input)) return null;
  return <RecordedCall toolUseId={event.toolUseId} />;
}

/**
 * Whether the call still has a recording is known up front (the preloaded
 * set): a call whose runs were pruned — most of an older conversation's —
 * draws nothing from its first frame instead of a placeholder that then
 * collapses. A call still running joins the set when its manifest lands.
 */
function RecordedCall({ toolUseId }: { toolUseId: string }) {
  const recorded = useLive(browserRecordedCalls);
  if (
    recorded.status === "ready" &&
    recorded.data.kind === "indexed" &&
    !recorded.data.toolUseIds.includes(toolUseId)
  )
    return null;
  return <Recordings toolUseId={toolUseId} />;
}

function Recordings({ toolUseId }: { toolUseId: string }) {
  const result = useLive(browserRecordingRuns, { toolUseId });
  // Held at a filmstrip's height — a browser_* call's one frame, the common
  // run — so the card is already its final size when the runs land, and a
  // transcript opening on it does not grow under the reader.
  if (result.status === "loading")
    return (
      <Stack gap="xs" className="pt-sm" aria-busy>
        <ThumbnailPlaceholder size="chip" />
      </Stack>
    );
  if (result.status === "error")
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the browser recording"
        error={result.error}
        refetch={result.refetch}
      />
    );
  // Pushed when a run's manifest lands: none yet (still running, or killed
  // before it wrote one) is nothing to show.
  if (result.data.runs.length === 0) return null;
  return (
    <Stack gap="xs" className="pt-sm">
      {result.data.runs.map((run) => (
        <RunStrip key={run.dir} run={run} />
      ))}
    </Stack>
  );
}
