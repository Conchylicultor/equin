import type { SQL } from "drizzle-orm";
import { PgDialect, QueryBuilder, type PgTable } from "drizzle-orm/pg-core";
import type { QueryDb, SelectMap } from "../internal/spec";

/** One query the fake ran: its rendered SQL and bound params. */
export interface RecordedQuery {
  sql: string;
  params: unknown[];
}

/**
 * A `QueryDb` that renders every query through drizzle's real `PgDialect` —
 * the SQL a compiler would send — records it, and answers with `script`'s rows
 * instead of running it. The whole `QueryStep` surface is here (joins,
 * `groupBy` included), and the raw `execute` (answered as a full `SqlResult`),
 * so a suite can read exactly which relations each shape reads.
 */
export function recordingQueryDb(
  script: (query: RecordedQuery) => unknown[] = () => [],
): { db: QueryDb; calls: RecordedQuery[] } {
  const dialect = new PgDialect();
  const calls: RecordedQuery[] = [];
  // drizzle's builder is generic past what a fake needs; `any` stays inside.
  const wrap = (q: any): any => ({
    leftJoin: (t: PgTable, on: SQL) => wrap(q.leftJoin(t, on)),
    innerJoin: (t: PgTable, on: SQL) => wrap(q.innerJoin(t, on)),
    where: (p: SQL) => wrap(q.where(p)),
    groupBy: (...cols: unknown[]) => wrap(q.groupBy(...cols)),
    orderBy: (...o: SQL[]) => wrap(q.orderBy(...o)),
    limit: (n: number) => wrap(q.limit(n)),
    getSQL: () => q.getSQL(),
    then: (
      resolve: (v: unknown[]) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      const rendered = dialect.sqlToQuery(q.getSQL());
      const call = { sql: rendered.sql, params: rendered.params };
      calls.push(call);
      return Promise.resolve()
        .then(() => script(call))
        .then(resolve, reject);
    },
  });
  const qb = new QueryBuilder();
  const makeFrom = (builder: any) => ({
    from: (t: any) => wrap(builder.from(t)),
  });
  const db = {
    select: (fields?: SelectMap) =>
      makeFrom(fields ? qb.select(fields) : qb.select()),
    selectDistinct: (fields: SelectMap) => makeFrom(qb.selectDistinct(fields)),
    // A raw statement: rendered and recorded like a builder's, answered as a
    // full `SqlResult` (rows as the script returns them — raw, undecoded, as
    // a driver hands them back).
    execute: (query: SQL): ReturnType<QueryDb["execute"]> => {
      const rendered = dialect.sqlToQuery(query);
      const call = { sql: rendered.sql, params: rendered.params };
      calls.push(call);
      return Promise.resolve()
        .then(() => script(call))
        .then((rows) => ({ rows, rowCount: rows.length, fields: [] }));
    },
  } as unknown as QueryDb;
  return { db, calls };
}
