import { liveCollection } from "@plugins/network/plugins/live/core";
import { compositeKey } from "@plugins/network/plugins/live/plugins/query-resource/core";
import { islePlotEntityRef } from "./schemas";

/**
 * Every plot of one world (`world` = the seed, as text), in the order they were
 * made: a scoped whole set (`all: { by: ["world"] }`), because the pure world
 * needs ALL of them to place, lay out and walk — a window would move buildings
 * past its edge. Bounded by construction: the archipelago is finite (18
 * islands of at most 5 districts, each holding a few dozen plots at most), so
 * `max` is a checked cap, not a hope — a load past it is a loud error.
 * Writes reach it through the change feed (the table is ordinary).
 */
export const islePlots = liveCollection("isle.plots", {
  from: islePlotEntityRef,
  carry: {
    pick: [
      "world",
      "plotId",
      "slot",
      "n",
      "seq",
      "category",
      "geometry",
      "occupant",
      "movedByUser",
    ],
  },
  id: compositeKey(["world", "plotId"]),
  all: {
    by: ["world"],
    orderBy: [["seq", "asc"]],
    max: 2000,
  },
});

/** The `world` scope of a seed: one set of plots per seed. */
export const worldOfSeed = (seed: number): string => String(seed);
