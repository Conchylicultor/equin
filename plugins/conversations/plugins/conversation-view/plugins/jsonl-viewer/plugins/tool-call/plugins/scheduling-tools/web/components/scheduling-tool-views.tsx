import type { ToolViewProps } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";
import {
  ToolCallCard,
  ToolCode,
  ToolOutput,
  ToolSection,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/web";
import {
  formatDuration,
  wakeupSummary,
  type MonitorInput,
  type Wakeup,
} from "../internal/scheduling";

/** ScheduleWakeup: when the loop wakes next, why, and the prompt it wakes with. */
export function ScheduleWakeupToolView({
  event,
  input: w,
}: ToolViewProps<Wakeup>) {
  return (
    <ToolCallCard
      event={event}
      summary={wakeupSummary(w)}
      note={w.noop ? "· no-op" : undefined}
    >
      {w.prompt && (
        <ToolSection label="Prompt" copyText={w.prompt}>
          <ToolCode>{w.prompt}</ToolCode>
        </ToolSection>
      )}
      {event.result?.content && <ToolOutput event={event} />}
    </ToolCallCard>
  );
}

/** Monitor: what is watched (its description), the command or socket behind it, its time limit. */
export function MonitorToolView({
  event,
  input: m,
}: ToolViewProps<MonitorInput>) {
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
      {source && (
        <ToolSection label="Input" copyText={source}>
          <ToolCode>{source}</ToolCode>
        </ToolSection>
      )}
      {event.result?.content && <ToolOutput event={event} />}
    </ToolCallCard>
  );
}
