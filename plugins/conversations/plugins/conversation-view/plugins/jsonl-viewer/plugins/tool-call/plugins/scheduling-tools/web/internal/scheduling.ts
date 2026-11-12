import { z } from "zod";

/**
 * ScheduleWakeup's input. Every field is optional, so the same schema reads a
 * call the model is still writing: the card fills in as it is written.
 */
export const WakeupSchema = z.looseObject({
  delaySeconds: z.number().optional(),
  prompt: z.string().optional(),
  reason: z.string().optional(),
  noop: z.boolean().optional(),
  stop: z.boolean().optional(),
});

/** Monitor's input. Every field is optional, as for ScheduleWakeup. */
export const MonitorSchema = z.looseObject({
  command: z.string().optional(),
  description: z.string().optional(),
  timeout_ms: z.number().optional(),
  ws: z.looseObject({ url: z.string().optional() }).optional(),
});

export type Wakeup = z.infer<typeof WakeupSchema>;
export type MonitorInput = z.infer<typeof MonitorSchema>;

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
