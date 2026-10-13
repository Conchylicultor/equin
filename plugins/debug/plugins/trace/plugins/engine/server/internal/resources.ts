import { sql } from "drizzle-orm";
import { expr } from "@plugins/infra/plugins/query-resource/core";
import { serveCollection } from "@plugins/network/plugins/live/server";
import { traceById, traceEvents } from "../../core";
import { _traces } from "./tables";

// Both read `traces`, whose changes arrive from the engine's change producer
// (./producer), never a trigger: the routes these compile are identity routes
// over `traces.id`, which carry no column, so the ids a producer emits are all
// they need (A3p). A new trace or the sweep's delete reaches every open window
// and lookup within the producer's 2 s window.
//
// The list row binds its flat metadata columns by name and never projects the
// (tens-of-KB) `snapshot` blob; `wallTime` and `windowSpanMs` are two scalar
// extractions off it, for read-side incident grouping. Every persisted
// snapshot carries both keys.
export const traceEventsServed = serveCollection(traceEvents, {
  from: _traces,
  columns: {
    wallTime: (j) =>
      expr(sql`${j.base.snapshot} ->> 'wallTime'`, {
        decoder: String,
        sqlType: "text",
        notNull: true,
      }),
    windowSpanMs: (j) =>
      expr(
        sql`(${j.base.snapshot} ->> 'atMs')::float8 - (${j.base.snapshot} ->> 'windowStartMs')::float8`,
        { decoder: Number, sqlType: "float8", notNull: true },
      ),
  },
});

export const traceByIdServed = serveCollection(traceById, {
  from: _traces,
});
