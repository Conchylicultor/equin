import { uniqueIndex } from "drizzle-orm/pg-core";
import {
  defaultNow,
  defineEntity,
} from "@plugins/infra/plugins/entities/server";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { islePlotEntityRef } from "../../core";

/**
 * Isle's plots, one row per plot of a world (seed). Keyed by the plot, never by
 * the app: a plot outlives its app as an empty lot. One app stands on at most
 * one plot of a world (the unique index over `(world, occupant)`; NULLs —
 * empty lots — are distinct, so any number of lots may be empty).
 */
export const islePlots = defineEntity(
  islePlotEntityRef,
  { createdAt: dateField(), updatedAt: dateField() },
  {
    primaryKey: ["world", "plotId"],
    updatedAt: {
      touchedBy: {
        world: false,
        plotId: false,
        slot: false,
        n: false,
        seq: false,
        category: false,
        geometry: true,
        occupant: true,
        movedByUser: true,
        createdAt: false,
      },
    },
    columns: {
      movedByUser: { default: false },
      createdAt: { default: defaultNow() },
      updatedAt: { default: defaultNow() },
    },
    indexes: (t) => [
      uniqueIndex("isle_plots_world_occupant_idx").on(t.world, t.occupant),
    ],
  },
);

// drizzle-kit schema-glob discovery.
export const _islePlots = islePlots.table;
