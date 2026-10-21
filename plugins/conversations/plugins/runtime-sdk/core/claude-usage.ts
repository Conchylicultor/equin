import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

// The claude.ai subscription's usage limits, as the agents last saw them.
//
// Every turn of an SDK agent gets a `rate_limit_event` whose `rate_limit_info`
// carries `unifiedWindows` — each limit window's utilization and reset time.
// The Agent SDK's types do not declare that field yet, so it is parsed here,
// never cast. The limits are the account's, not one agent's or one
// namespace's: whichever agent reported last speaks for the machine.

/** The one file in `claudeUsageDir` (data-dirs) every agent overwrites. */
export const CLAUDE_USAGE_FILE = "latest.json";

const WindowSchema = z.object({
  /** Fraction of the window used, 0..1 (1 = the limit is reached). */
  utilization: z.number().nonnegative(),
  /** When the window resets, epoch milliseconds. */
  resetsAt: z.number().int().positive(),
});
export type ClaudeUsageWindow = z.infer<typeof WindowSchema>;

export const ClaudeUsageSchema = z.object({
  /** When an agent reported it, epoch milliseconds. */
  observedAt: z.number().int().positive(),
  /** The rolling 5-hour session limit. */
  session: WindowSchema.nullable(),
  /** The weekly limit, all models. */
  week: WindowSchema.nullable(),
});
export type ClaudeUsage = z.infer<typeof ClaudeUsageSchema>;

/** What the backend serves: the last report, or none yet on this machine. */
export const ClaudeUsageReadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("reported"), usage: ClaudeUsageSchema }),
]);
export type ClaudeUsageRead = z.infer<typeof ClaudeUsageReadSchema>;

// The SDK's wire shape: seconds, and only the fields read here.
const WireWindowSchema = z.object({
  utilization: z.number().nonnegative(),
  resetsAt: z.number().int().positive(),
});
const RateLimitEventSchema = z.object({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.object({
    unifiedWindows: z
      .object({
        five_hour: WireWindowSchema.optional(),
        seven_day: WireWindowSchema.optional(),
      })
      .optional(),
  }),
});

const toWindow = (
  w: z.infer<typeof WireWindowSchema> | undefined,
): ClaudeUsageWindow | null =>
  w ? { utilization: w.utilization, resetsAt: w.resetsAt * 1000 } : null;

/**
 * The usage an SDK message reports: a `rate_limit_event` carrying at least one
 * window, else `null` (any other message; an event without windows — an API
 * key session, or an older CLI). A `rate_limit_event` whose windows do not
 * parse throws: the CLI changed the shape and the meter must say so loudly.
 */
export function claudeUsageOf(
  msg: { type: string },
  observedAt: number,
): ClaudeUsage | null {
  if (msg.type !== "rate_limit_event") return null;
  const windows =
    RateLimitEventSchema.parse(msg).rate_limit_info.unifiedWindows;
  if (!windows) return null;
  const session = toWindow(windows.five_hour);
  const week = toWindow(windows.seven_day);
  if (!session && !week) return null;
  return { observedAt, session, week };
}

/**
 * The subscription's usage limits as the machine's agents last reported them
 * (one file every agent overwrites). Read off the computer, so only the
 * desktop app answers it (`needsMachine`).
 */
export const claudeUsage = liveValue("runtime-sdk.claude-usage", {
  schema: ClaudeUsageReadSchema,
  needsMachine: { feature: "Reading the Claude usage limits" },
});
