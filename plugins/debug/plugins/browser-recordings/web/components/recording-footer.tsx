import type { ToolFooterProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { browserRecordingRuns, isRecordedToolCall } from "../../core";
import { RunStrip } from "./run-strip";

/**
 * The recording of the browser a tool call drove, under its card: one
 * filmstrip per run — an e2e script's steps, or a browser_* call's frame.
 */
export function RecordingFooter({ event }: ToolFooterProps) {
  if (!isRecordedToolCall(event.name, event.input)) return null;
  return <Recordings toolUseId={event.toolUseId} />;
}

function Recordings({ toolUseId }: { toolUseId: string }) {
  const result = useLive(browserRecordingRuns, { toolUseId });
  if (result.status === "loading")
    return <Loading label="Loading recording…" className="px-md pt-2xs" />;
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
    <Stack gap="xs" className="px-md pt-2xs">
      {result.data.runs.map((run) => (
        <RunStrip key={run.dir} run={run} />
      ))}
    </Stack>
  );
}
