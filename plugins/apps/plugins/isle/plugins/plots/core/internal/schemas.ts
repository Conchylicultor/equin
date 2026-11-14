import { z } from "zod";
import { fieldsToZodObject, nullable } from "@plugins/fields/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  cappedList,
  wholeList,
} from "@plugins/packages/plugins/list-bound/core";
import { SETTINGS } from "@plugins/apps/plugins/isle/plugins/buildings/core";
import type { Plot } from "@plugins/apps/plugins/isle/plugins/world/core";
import { APP_CATEGORIES } from "@plugins/primitives/plugins/pane/core";

const BoxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .readonly();
const PtSchema = z.tuple([z.number(), z.number()]).readonly();
const SettingSchema = z.enum(SETTINGS);

/**
 * A plot's geometry: everything `world/core`'s `Plot` holds but its identity
 * (id, n, seq, district) and the category it was made for, which are columns.
 * Opaque to SQL — only the pure world reads it — so it is one jsonb value.
 */
export const PlotGeometrySchema = z.object({
  x: z.number(),
  y: z.number(),
  g: BoxSchema,
  u: BoxSchema,
  k: BoxSchema,
  sx: z.number(),
  side: z.union([z.literal(1), z.literal(-1)]),
  lane: wholeList(PtSchema, {
    reason: "one door's path to its road: a spline of a few dozen points",
  }).readonly(),
  ring: z.boolean(),
  street: z.number().nullable(),
  arc: z.number().nullable(),
  edge: z.number().nullable(),
  landing: z.number().nullable(),
  row: z.string().nullable(),
  tags: cappedList(SettingSchema, { max: SETTINGS.length }).readonly(),
  feat: SettingSchema.nullable(),
});
export type PlotGeometry = z.infer<typeof PlotGeometrySchema>;

/**
 * One plot of one world (a seed): where a building stands or stood. Keyed
 * `(world, plotId)` — a plot outlives its app as an empty lot (`occupant`
 * null, or an app no longer installed), which a later app may take, so the
 * key is the plot, never the app. `occupant` is unique per world (an app
 * stands on one plot at most). `seq` is the world-wide order plots were made
 * in; `n` the plot's index in its district (`plotId` is `<district>:<n>`).
 */
export const islePlotFields = {
  world: textField(),
  plotId: textField(),
  slot: textField(),
  n: intField(),
  seq: intField(),
  category: textField(),
  geometry: jsonField({ schema: PlotGeometrySchema }),
  occupant: nullable(textField()),
  movedByUser: boolField(),
};

export const islePlotEntityRef = entityRef("isle_plots", islePlotFields);

export const IslePlotRowSchema = fieldsToZodObject(islePlotFields);
export type IslePlotRow = z.infer<typeof IslePlotRowSchema>;

/** A whole `world/core` Plot on the wire (a write carries the plot it makes or refits). */
export const PlotSchema = PlotGeometrySchema.extend({
  id: z.string(),
  n: z.number().int(),
  seq: z.number().int(),
  slot: z.string(),
  category: z.enum(APP_CATEGORIES),
}) satisfies z.ZodType<Plot>;
