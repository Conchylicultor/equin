import { z } from "zod";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { floatField } from "@plugins/fields/plugins/float/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { defineExtensionShape } from "@plugins/infra/plugins/entity-extensions/core";

/**
 * One song's swing override, stored in the `sonata_songs_ext_swing`
 * entity-extension table (1:1 per song). An absent row is the song's own feel
 * (`{ kind: "score" }`); `swung: false` plays it straight, keeping `unit` /
 * `ratio` as the feel turning swing back on plays; `swung: true` plays them.
 */
export const swingShape = defineExtensionShape({
  key: "songId",
  fields: {
    swung: boolField(),
    unit: intField({ default: 8 }),
    ratio: floatField({ default: 2 }),
  },
});
export const SwingRowSchema = swingShape.schema;
export type SwingRow = z.infer<typeof SwingRowSchema>;

/**
 * The swing override of ONE song, read by the song's id: a lookup-only
 * collection over the extension table. The observer reads the open song's row
 * with `useLiveRow(swings, songId)`; `found: false` is the song's own feel.
 */
export const swings = liveCollection("sonata-swing", {
  row: SwingRowSchema,
  id: "songId",
});
