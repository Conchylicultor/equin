import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import {
  choose,
  removeRow,
  upsertRow,
} from "@plugins/network/plugins/live/core";
import { swings } from "./resources";
import { MAX_SWING_RATIO, MIN_SWING_RATIO } from "../core";

const SwingSchema = z.object({
  unit: z.union([z.literal(8), z.literal(16)]),
  ratio: z.number().min(MIN_SWING_RATIO).max(MAX_SWING_RATIO),
});

export const SwingOverrideBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("score") }),
  z.object({ kind: z.literal("straight"), feel: SwingSchema }),
  z.object({ kind: z.literal("swing"), swing: SwingSchema }),
]);

/**
 * Set a song's swing override. `score` deletes the row (back to the song's own
 * feel); `straight` / `swing` upsert it — a straight row keeps the feel turning
 * swing back on plays.
 */
export const setSwingEndpoint = defineEndpoint({
  route: "POST /api/sonata/songs/:id/swing",
  body: SwingOverrideBodySchema,
  // `score` deletes the song's row; the others upsert it whole. The row is an
  // extension shape's (`from: null`): the collection is the target.
  effect: (on) =>
    choose(on, ({ body }) => body.kind, {
      score: removeRow(on, swings, ({ params }) => params.id),
      straight: upsertRow(
        on,
        swings,
        ({ params }) => params.id,
        (_row, { params, body }) => ({
          songId: params.id,
          swung: false,
          ...(body.kind === "straight" ? body.feel : { unit: 8, ratio: 2 }),
        }),
      ),
      swing: upsertRow(
        on,
        swings,
        ({ params }) => params.id,
        (_row, { params, body }) => ({
          songId: params.id,
          swung: true,
          ...(body.kind === "swing" ? body.swing : { unit: 8, ratio: 2 }),
        }),
      ),
    }),
});
