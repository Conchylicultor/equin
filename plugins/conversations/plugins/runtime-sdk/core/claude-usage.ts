import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { liveValue } from "@plugins/network/plugins/live/core";

// The claude.ai subscription's usage limits, as last read: by an agent's turn,
// or on demand (`refreshClaudeUsage`, below).
//
// Every turn of an SDK agent gets a `rate_limit_event` whose `rate_limit_info`
// carries `unifiedWindows` — each limit window's utilization and reset time.
// The Agent SDK's types do not declare that field yet, so it is parsed here,
// never cast. The limits are the Claude account's, not one agent's or one
// namespace's: whichever agent on an account reported last speaks for it.

/**
 * The file in `claudeUsageDir` (data-dirs) every agent on `accountId`
 * overwrites (`infra/claude-cli/accounts` names the accounts).
 */
export function claudeUsageFileName(accountId: string): string {
  return `${accountId}.json`;
}

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

/**
 * What the backend serves: each Claude account's last report, by account id.
 * An account no agent has reported for yet has no entry.
 */
export const ClaudeUsageReadSchema = z.object({
  byAccount: z.record(z.string(), ClaudeUsageSchema),
});
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
 * Each Claude account's usage limits as the machine's agents last reported
 * them (one file per account, every agent on it overwrites). Read off the computer, so only the
 * desktop app answers it (`needsMachine`).
 */
export const claudeUsage = liveValue("runtime-sdk.claude-usage", {
  schema: ClaudeUsageReadSchema,
  needsMachine: { feature: "Reading the Claude usage limits" },
});

// The same limits read on demand — no agent turn, no model call: the SDK's
// `get_usage` control request (what `/usage` shows), answered by Claude Code
// from the claude.ai usage endpoint under the account's own sign-in. Its
// windows are percentages and ISO times; only the fields read here are parsed.
const ReplyWindowSchema = z
  .object({
    utilization: z.number().nonnegative().nullable(),
    resets_at: z.string().nullable(),
  })
  .nullable()
  .optional();
export const UsageReplySchema = z.object({
  rate_limits_available: z.boolean(),
  rate_limits: z
    .object({ five_hour: ReplyWindowSchema, seven_day: ReplyWindowSchema })
    .nullable(),
});

const replyWindow = (
  w: z.infer<typeof ReplyWindowSchema>,
): ClaudeUsageWindow | null => {
  if (!w || w.utilization === null || w.resets_at === null) return null;
  const resetsAt = Date.parse(w.resets_at);
  if (Number.isNaN(resetsAt))
    throw new Error(`get_usage: unreadable resets_at "${w.resets_at}"`);
  return { utilization: w.utilization / 100, resetsAt };
};

/**
 * An account's limits as one `get_usage` reply reads them, or why there are
 * none: plan limits do not apply to it (an API key, or a token without the
 * profile scope), or the reply carries no window. Throws when the reply
 * changed shape.
 */
export function claudeUsageOfReply(
  reply: unknown,
  observedAt: number,
): ClaudeUsageRefresh {
  const parsed = UsageReplySchema.parse(reply);
  if (!parsed.rate_limits_available || !parsed.rate_limits)
    return {
      kind: "unavailable",
      reason:
        "Claude Code reports no plan limits for this account (an API key, or a token that cannot read usage)",
    };
  const session = replyWindow(parsed.rate_limits.five_hour);
  const week = replyWindow(parsed.rate_limits.seven_day);
  if (!session && !week)
    return {
      kind: "unavailable",
      reason: "Claude Code's usage reply carries no session or weekly window",
    };
  return { kind: "read", usage: { observedAt, session, week } };
}

export const ClaudeUsageRefreshSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), usage: ClaudeUsageSchema }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);
export type ClaudeUsageRefresh = z.infer<typeof ClaudeUsageRefreshSchema>;

/**
 * Read `accountId`'s limits now and record them in its usage file (pushed
 * through {@link claudeUsage}) — after adding or switching to an account, whose
 * file no agent has written yet or wrote under another sign-in.
 */
export const refreshClaudeUsage = defineEndpoint({
  route: "POST /api/claude-usage/refresh",
  body: z.object({ accountId: z.string().min(1) }),
  response: ClaudeUsageRefreshSchema,
  needsMachine: { feature: "Reading the Claude usage limits" },
});
