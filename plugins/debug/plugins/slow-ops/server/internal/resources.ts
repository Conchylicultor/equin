import { sql } from "drizzle-orm";
import { expr } from "@plugins/infra/plugins/query-resource/core";
import { serveCollection } from "@plugins/network/plugins/live/server";
import { slowOpById, slowOpCallers, slowOpsList } from "../../core";
import { _slowOpCallers, _slowOps } from "./tables";

// All three read tables whose changes arrive from the recorder's change
// producers (./producer), never a trigger: the routes these compile are
// identity routes over each table's `id`, which carry no column, so the ids a
// producer emits are all they need (A3p). A new occurrence, a new caller or the
// retention sweep reaches every open window and lookup within the producer's
// 2 s window.
//
// The list row binds the op's scalar columns by name and never projects a
// JSON list; `waitMs` (the summed `waits`) and `lastTraceId` (the newest
// sample's trace) are two scalar extractions off them.
export const slowOpsListServed = serveCollection(slowOpsList, {
  from: _slowOps,
  columns: {
    waitMs: (j) =>
      expr(
        sql`coalesce((SELECT sum(w.ms::float8) FROM jsonb_each_text(${j.base.waits}) AS w(layer, ms)), 0)`,
        { decoder: Number, sqlType: "float8", notNull: true },
      ),
    lastTraceId: (j) =>
      expr(sql`${j.base.recentSamples} -> 0 ->> 'traceId'`, {
        decoder: String,
        sqlType: "text",
        notNull: false,
      }),
  },
});

export const slowOpByIdServed = serveCollection(slowOpById, {
  from: _slowOps,
});

export const slowOpCallersServed = serveCollection(slowOpCallers, {
  from: _slowOpCallers,
});
