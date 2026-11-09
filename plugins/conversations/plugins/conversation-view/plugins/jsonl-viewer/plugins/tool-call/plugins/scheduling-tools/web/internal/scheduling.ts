import { z } from "zod";
import type { ToolCallEvent } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/core";

const WakeupSchema = z.object({
  delaySeconds: z.number().optional(),
  prompt: z.string().optional(),
  reason: z.string().optional(),
  noop: z.boolean().optional(),
  stop: z.boolean().optional(),
});

const MonitorSchema = z.object({
  command: z.string().optional(),
  description: z.string().optional(),
  timeout_ms: z.number().optional(),
  ws: z.object({ url: z.string().optional() }).optional(),
});

export type Wakeup = z.infer<typeof WakeupSchema>;
export type MonitorInput = z.infer<typeof MonitorSchema>;

export function readWakeup(event: ToolCallEvent): Wakeup {
  return WakeupSchema.parse(event.input ?? {});
}

export function readMonitor(event: ToolCallEvent): MonitorInput {
  return MonitorSchema.parse(event.input ?? {});
}

/** 90 -> "1m 30s", 1200 -> "20m", 3600 -> "1h". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s}s`;
  const parts: string[] = [];
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec) parts.push(`${sec}s`);
  return parts.join(" ");
}

export function wakeupSummary(w: Wakeup): string | undefined {
  if (w.stop) return "stop loop";
  const when =
    w.delaySeconds === undefined
      ? undefined
      : `in ${formatDuration(w.delaySeconds)}`;
  if (when && w.reason) return `${when} — ${w.reason}`;
  return when ?? w.reason;
}
