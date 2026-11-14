import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { cappedList } from "@plugins/packages/plugins/list-bound/core";
import { PlotSchema } from "./schemas";

/**
 * One plot written: the plot as it now is, who stands on it (null: an empty
 * lot), and what the writer saw there — `absent` for a plot it makes, else
 * the occupant it read. The server applies a batch only if every expectation
 * still holds (compare-and-set), so a tab that computed on a stale read loses
 * and recomputes from the next push instead of overwriting.
 */
export const PlotWriteSchema = z.object({
  plot: PlotSchema,
  occupant: z.string().nullable(),
  expect: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("absent") }),
    z.object({ kind: z.literal("occupant"), appId: z.string().nullable() }),
  ]),
});
export type PlotWrite = z.infer<typeof PlotWriteSchema>;

const WritesBodySchema = z.object({
  world: z.string().min(1),
  writes: cappedList(PlotWriteSchema, { max: 400 }).min(1),
});

/** `applied`, or `stale` when an expectation no longer held (nothing written). */
export const PlotWritesResultSchema = z.object({
  outcome: z.enum(["applied", "stale"]),
});
export type PlotWritesResult = z.infer<typeof PlotWritesResultSchema>;

/**
 * Places the apps that had no plot: new plots inserted (absent), lots taken.
 * Two tabs computing the same deterministic placement converge — the first
 * batch lands, the second finds its plots no longer absent and is `stale`.
 */
export const claimPlots = defineEndpoint({
  route: "POST /api/isle/plots/claim",
  body: WritesBodySchema,
  response: PlotWritesResultSchema,
});

/**
 * A building moved by hand (drag and drop): the plot it lands on, the plot it
 * left (empty, or the swapped building's), each marked `movedByUser`. The
 * target was validated by the pure world (`moveTargets`) on the placement the
 * writer read; the compare-and-set makes sure it is still that placement.
 */
export const movePlot = defineEndpoint({
  route: "POST /api/isle/plots/move",
  body: WritesBodySchema,
  response: PlotWritesResultSchema,
});
