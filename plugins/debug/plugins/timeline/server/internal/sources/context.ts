import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import {
  queryRows,
  type SqlQueryable,
} from "@plugins/database/plugins/sql-rows/core";
import type { TimelineEvent, TimelineSource } from "../../../core";

// The per-DB extraction context handed to every DB-backed source. `dbName` is
// the fork DB name, which IS the worktree slug (the main DB is
// MAIN_WORKTREE_NAME) — the same identity mapping the slow-ops cluster tab
// relies on.
export interface DbSourceCtx {
  dbName: string;
  isMainDb: boolean;
  fromMs: number; // wall-clock epoch ms
  toMs: number; // wall-clock epoch ms; > fromMs
}

export interface SqlQuery {
  text: string;
  values: unknown[];
}

// One DB-backed timeline source. `build` produces the raw SQL for a DB visit
// and `load` reads it; both are on the interface because `build` is what the
// unit tests pin the SQL shape with.
//
// `load` is deliberately the ONLY row-reading member: a source's row type is
// its own business, so hiding it behind this call is what lets DB_SOURCES stay
// one heterogeneous list. Build sources with `defineDbSource` rather than by
// hand — it is what routes the read through the parsed door.
//
// A malformed row THROWS out of `load` (the zod parse at the read boundary) —
// the runner's per-source try/catch surfaces it as that cell's `ok: false`
// chunk, mirroring the cluster tab's loud-but-resilient pattern.
export interface DbSource {
  source: TimelineSource;
  build: (ctx: DbSourceCtx) => SqlQuery;
  load: (client: SqlQueryable, ctx: DbSourceCtx) => Promise<TimelineEvent[]>;
}

// Bind a source's SQL, its row schema, and its pure mapper into one `DbSource`.
// The parse happens HERE, at the read, so `map` receives rows whose shape has
// been checked rather than asserted — and stays pure, so it is unit-testable
// with no database.
export function defineDbSource<Row>(spec: {
  source: TimelineSource;
  build: (ctx: DbSourceCtx) => SqlQuery;
  row: ZodParser<Row>;
  map: (rows: Row[], ctx: DbSourceCtx) => TimelineEvent[];
}): DbSource {
  return {
    source: spec.source,
    build: spec.build,
    load: async (client, ctx) => {
      const q = spec.build(ctx);
      const rows = await queryRows(client, {
        sql: q.text,
        params: q.values,
        row: spec.row,
      });
      return spec.map(rows, ctx);
    },
  };
}
