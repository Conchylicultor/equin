import type { ToolRendererProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import { ToolCallCard } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  formatDuration,
  readMonitor,
  readWakeup,
  wakeupSummary,
} from "../internal/scheduling";

function ResultText({ event }: ToolRendererProps) {
  const result = event.result;
  if (!result?.content) return null;
  return (
    <Text
      as="pre"
      variant="caption"
      tone={result.isError ? "destructive" : "muted"}
      className="font-mono whitespace-pre-wrap break-words"
    >
      {result.content}
    </Text>
  );
}

/** ScheduleWakeup: when the loop wakes next, why, and the prompt it wakes with. */
export function ScheduleWakeupToolView({ event }: ToolRendererProps) {
  const w = readWakeup(event);
  return (
    <ToolCallCard
      event={event}
      summary={wakeupSummary(w)}
      note={w.noop ? "· no-op" : undefined}
    >
      <Stack gap="sm">
        {w.prompt && (
          <Text as="p" variant="caption" className="whitespace-pre-wrap">
            {w.prompt}
          </Text>
        )}
        <ResultText event={event} />
      </Stack>
    </ToolCallCard>
  );
}

/** Monitor: what is watched (its description), the command or socket behind it, its time limit. */
export function MonitorToolView({ event }: ToolRendererProps) {
  const m = readMonitor(event);
  const source = m.command ?? (m.ws?.url ? `ws ${m.ws.url}` : undefined);
  return (
    <ToolCallCard
      event={event}
      summary={m.description ?? source}
      note={
        m.timeout_ms
          ? `· up to ${formatDuration(m.timeout_ms / 1000)}`
          : undefined
      }
    >
      <Stack gap="sm">
        {source && (
          <Text
            as="pre"
            variant="caption"
            className="font-mono whitespace-pre-wrap break-words"
          >
            {source}
          </Text>
        )}
        <ResultText event={event} />
      </Stack>
    </ToolCallCard>
  );
}
