import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";

const HOUR_MS = 3_600_000;

/** The UTC hour `t` (epoch ms) falls in, as the instant it starts. */
export function hourStartOf(t: number): string {
  return new Date(t - (((t % HOUR_MS) + HOUR_MS) % HOUR_MS)).toISOString();
}

const UnpricedModels = cappedList(z.string(), { max: 64 });

const CostByHourSchema = z.object({
  before: z.object({ costUsd: z.number(), unpricedModels: UnpricedModels }),
  steps: cappedList(z.object({ t: z.number(), costUsd: z.number() }), {
    max: 20_000,
  }),
  unpricedFrom: cappedList(z.object({ model: z.string(), t: z.number() }), {
    max: 64,
  }),
});

export type ConversationCostByHour = z.infer<typeof CostByHourSchema>;

/**
 * What a conversation had cost through one UTC hour — its own transcripts and
 * every sub-agent's, at API prices — for the transcript's cost stat while the
 * reader is scrolled back (at the end the stat reads the totals,
 * `conversationUsageById`). The stat prices its reading position from it
 * (`costAtInstant`), so scrolling within an hour reads the same key: it changes
 * only when the reading position crosses an hour.
 *
 * `before` is the priced ledger's hours before `hour` (`claude_spend_hours_v`,
 * the one pricing function). `steps` is the cost at every instant of the hour
 * a usage line moves it — `before` plus the stretch so far, folded from the
 * transcripts with the ledger's own fold and priced with the rates in force at
 * that hour — so a sub-agent's spend lands where it happened, and the reading
 * meets the totals at the end. `unpricedFrom`: each model with no price
 * (left out of the cost, never counted as $0), from the instant it is first
 * used in the hour.
 *
 * BOUND: `steps` — one per instant a usage line lands in one hour of one
 * conversation, sub-agents included: a few hundred for one busy agent, a few
 * thousand for a large workflow fan-out. `unpricedModels` / `unpricedFrom` —
 * the models a conversation used, a handful.
 */
export const conversationCostByHour = liveValue(
  "conversations.usage.cost-by-hour",
  {
    schema: CostByHourSchema,
    params: {
      id: z.string().min(1),
      /** The hour's first instant (`hourStartOf`) — one key per hour. */
      hour: z
        .string()
        .datetime({ offset: true })
        .refine((h) => hourStartOf(Date.parse(h)) === h, {
          message: "not an hour start (hourStartOf)",
        }),
    },
    // The stretch of an hour is read from the transcripts on disk.
    needsMachine: { feature: "Cost while scrolling" },
  },
);

/** The cost by `at` (epoch ms, within the value's hour): the last step at or before it. */
export function costAtInstant(
  value: ConversationCostByHour,
  at: number,
): { costUsd: number; unpricedModels: string[] } {
  const { steps } = value;
  let lo = 0;
  let hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (steps[mid]!.t <= at) lo = mid + 1;
    else hi = mid;
  }
  const unpriced = new Set(value.before.unpricedModels);
  for (const { model, t } of value.unpricedFrom)
    if (t <= at) unpriced.add(model);
  return {
    costUsd: lo === 0 ? value.before.costUsd : steps[lo - 1]!.costUsd,
    unpricedModels: [...unpriced].sort(),
  };
}
