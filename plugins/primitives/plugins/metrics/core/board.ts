import { z } from "zod";
import { DISPLAY_CHARTS } from "./engine";

// A board is authored data — a view-core instance's `options` — naming metrics
// by their global id. The refs are validated against the served catalog when
// the board renders (an unknown one is an error card), since the browser never
// imports a provider.
//
// A board holds WHAT it shows. How it is being looked at (range, compare, the
// selected tile, the table toggle) is device-local and never stored here.

export const MetricRefSchema = z
  .object({
    /** A metric global id, `<source>.<metric>`. */
    metric: z.string(),
    /** One of the metric's split ids; absent = the unsplit total. */
    split: z.string().optional(),
    /** How the card draws it; absent = the card's default for the metric's measure. */
    chart: z.enum(DISPLAY_CHARTS).optional(),
  })
  .strict();
export type MetricRef = z.infer<typeof MetricRefSchema>;

export const BreakdownRefSchema = z
  .object({
    /** A breakdown global id, `<source>.<breakdown>`. */
    breakdown: z.string(),
  })
  .strict();
export type BreakdownRef = z.infer<typeof BreakdownRefSchema>;

export const CardRefSchema = z.union([MetricRefSchema, BreakdownRefSchema]);
export type CardRef = z.infer<typeof CardRefSchema>;

export const BoardSectionSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    /** Tiles that choose which of them is drawn as the section's lead card. */
    focus: z
      .object({ items: z.array(MetricRefSchema).min(1) })
      .strict()
      .optional(),
    cards: z.array(CardRefSchema).default([]),
  })
  .strict();
export type BoardSection = z.infer<typeof BoardSectionSchema>;

export const BoardSpecSchema = z
  .object({
    /** Tab-level param values, keyed `<source>.<param>` — a source's params are shared by all its metrics. */
    params: z.record(z.string(), z.unknown()).default({}),
    sections: z.array(BoardSectionSchema).min(1),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    for (const [i, section] of spec.sections.entries()) {
      if (seen.has(section.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["sections", i, "id"],
          message: `section id "${section.id}" is used twice`,
        });
      }
      seen.add(section.id);
    }
  });
export type BoardSpec = z.infer<typeof BoardSpecSchema>;

/**
 * The raw params a query for one metric sends: the board's `<source>.<param>`
 * values for the params that metric reads. The server parses them (defaults,
 * types), so a param the board does not set is simply omitted.
 */
export function boardParamsFor(
  boardParams: Readonly<Record<string, unknown>>,
  entry: { source: string; params: readonly string[] },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of entry.params) {
    const key = `${entry.source}.${name}`;
    if (Object.hasOwn(boardParams, key)) out[name] = boardParams[key];
  }
  return out;
}
