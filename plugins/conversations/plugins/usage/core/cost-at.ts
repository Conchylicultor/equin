import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

/**
 * What a conversation had cost by an instant — its own transcripts and every
 * sub-agent's, at API prices — for the transcript's cost stat while the reader
 * is scrolled back (at the end the stat reads the totals, `conversationUsageById`).
 *
 * `at` is an ISO instant: the timestamp of the last row the reader can see.
 * The whole hours before it are the priced ledger's (`claude_spend_hours_v`,
 * the one pricing function); the stretch of its own hour up to `at` is folded
 * from the transcripts with the ledger's own fold and priced with the rates in
 * force at that hour — so a sub-agent's spend lands where it happened, and the
 * reading meets the totals at the end.
 *
 * `unpricedModels` — models whose usage up to `at` has no price (left out of
 * `costUsd`, never counted as $0). BOUND: the models a conversation used — a
 * handful.
 */
export const conversationCostAt = liveValue("conversations.usage.cost-at", {
  schema: z.object({
    costUsd: z.number(),
    unpricedModels: cappedList(z.string(), { max: 64 }),
  }),
  params: { id: z.string().min(1), at: z.string().datetime({ offset: true }) },
  // The stretch of the current hour is read from the transcripts on disk.
  needsMachine: { feature: "Cost while scrolling" },
});
