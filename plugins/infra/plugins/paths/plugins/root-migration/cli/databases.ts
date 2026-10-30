import {
  buildConnectionString,
  type DatabaseConfig,
} from "@plugins/database/core";
import {
  createDbClient,
  withQueryDeadline,
} from "@plugins/database/plugins/connection/server";
import { z } from "zod";
import { queryOne, queryRows } from "@plugins/database/plugins/sql-rows/core";
import { LIVE_STATE_HANDOFF_TABLE } from "@plugins/database/plugins/derived-views/core";
import type { Move } from "./plan";

// Every stored path in every database of the cluster — main AND each worktree's
// fork, which carries its own copy of the same rows — rewritten by one rule
// (`rewriteDbValue`'s, in SQL): a value that STARTS with a moved prefix is a
// path. The columns come from `information_schema`, so no table is listed and a
// fork on an older schema is covered too.

/** A column still holding a stored path after the rewrite. */
export interface DbLeftover {
  database: string;
  column: string;
  rows: number;
}

interface Column {
  name: string;
  /** `text` covers text and varchar; json and jsonb are matched in their text form. */
  kind: "text" | "json" | "jsonb";
}

interface Table {
  schema: string;
  name: string;
  columns: Column[];
}

/** A one-shot over a whole cluster: hours, not the per-statement minute. */
const MIGRATION_DEADLINE = {
  ms: 6 * 60 * 60_000,
  reason: "data-dir migrate rewrites every stored path in a whole database",
};

function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A LIKE pattern matching `s` literally. */
function likeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Push `value` as the next parameter; its placeholder, typed (Postgres cannot infer a bare one). */
function param(params: unknown[], value: string): string {
  params.push(value);
  return `$${params.length}::text`;
}

/** Whether one column holds a stored path under `move`, as SQL (parameters appended to `params`). */
function matchesSql(column: Column, move: Move, params: unknown[]): string {
  const c = ident(column.name);
  if (column.kind === "text") {
    return `(${c} = ${param(params, move.from)} OR ${c} LIKE ${param(params, `${likeLiteral(move.from)}/%`)})`;
  }
  // A JSON string value that is a path opens with `"<from>/` (or is exactly
  // `"<from>"`); a mention inside a longer string does not.
  return `(${c}::text LIKE ${param(params, `%${likeLiteral(`"${move.from}/`)}%`)} OR ${c}::text LIKE ${param(params, `%${likeLiteral(`"${move.from}"`)}%`)})`;
}

/** One column's value with `move` applied, as SQL (parameters appended to `params`). */
function rewrittenSql(column: Column, move: Move, params: unknown[]): string {
  const c = ident(column.name);
  if (column.kind === "text") {
    return `${param(params, move.to)} || substr(${c}, length(${param(params, move.from)}) + 1)`;
  }
  return `replace(replace(${c}::text, ${param(params, `"${move.from}/`)}, ${param(params, `"${move.to}/`)}), ${param(params, `"${move.from}"`)}, ${param(params, `"${move.to}"`)})::${column.kind}`;
}

/** One UPDATE per table and move: every column rewritten in a single scan. */
export function tableUpdateSql(
  table: Table,
  move: Move,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const set = table.columns
    .map((column) => {
      const c = ident(column.name);
      return `${c} = CASE WHEN ${matchesSql(column, move, params)} THEN ${rewrittenSql(column, move, params)} ELSE ${c} END`;
    })
    .join(", ");
  const where = table.columns
    .map((column) => matchesSql(column, move, params))
    .join(" OR ");
  return {
    sql: `UPDATE ${ident(table.schema)}.${ident(table.name)} SET ${set} WHERE ${where}`,
    params,
  };
}

/** One SELECT per table counting, per column, the rows still holding a moved prefix. */
export function tableScanSql(
  table: Table,
  moves: readonly Move[],
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const counts = table.columns.map((column, i) => {
    const matches = moves
      .map((move) => matchesSql(column, move, params))
      .join(" OR ");
    return `(count(*) FILTER (WHERE ${matches}))::int AS c${i}`;
  });
  return {
    sql: `SELECT ${counts.join(", ")} FROM ${ident(table.schema)}.${ident(table.name)}`,
    params,
  };
}

const COLUMN_ROW = z.object({
  schema: z.string(),
  name: z.string(),
  column: z.string(),
  type: z.string(),
});

const TABLES_SQL = `
  SELECT c.table_schema::text AS schema, c.table_name::text AS name, c.column_name::text AS column, c.data_type::text AS type
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
  WHERE t.table_type = 'BASE TABLE'
    AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
    AND c.table_schema NOT LIKE 'pg_toast%'
    AND c.is_generated = 'NEVER'
    AND c.data_type IN ('text', 'character varying', 'json', 'jsonb')
  ORDER BY 1, 2, 3`;

function tablesOf(rows: z.infer<typeof COLUMN_ROW>[]): Table[] {
  const byKey = new Map<string, Table>();
  for (const row of rows) {
    const key = `${row.schema}.${row.name}`;
    let table = byKey.get(key);
    if (!table) {
      table = { schema: row.schema, name: row.name, columns: [] };
      byKey.set(key, table);
    }
    table.columns.push({
      name: row.column,
      kind:
        row.type === "json" ? "json" : row.type === "jsonb" ? "jsonb" : "text",
    });
  }
  return [...byKey.values()];
}

async function withDatabase<T>(
  conn: DatabaseConfig["connection"],
  database: string,
  fn: (client: ReturnType<typeof createDbClient>) => Promise<T>,
): Promise<T> {
  const client = createDbClient({
    name: "admin-short-lived",
    connectionString: buildConnectionString(conn, database),
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Every database a client can connect to, templates excluded. */
export async function listDatabases(
  conn: DatabaseConfig["connection"],
): Promise<string[]> {
  return withDatabase(conn, "postgres", async (client) => {
    const rows = await queryRows(client, {
      sql: "SELECT datname::text AS datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname",
      row: z.object({ datname: z.string() }),
    });
    return rows.map((r) => r.datname);
  });
}

/**
 * Rewrite one database, in one transaction, with its triggers off
 * (`session_replication_role = replica`): moving the bytes a path names is not
 * a change to the row — a derived `updated_at`, a rollup or the change feed
 * must not see it. So nothing a backend handed its successor at shutdown (the
 * epoch handoff) can be proven current after it: the same transaction drops
 * the handoff, and the next backend's tabs load. Returns the rows rewritten.
 */
export async function rewriteDatabase(
  conn: DatabaseConfig["connection"],
  database: string,
  moves: readonly Move[],
): Promise<number> {
  return withQueryDeadline(MIGRATION_DEADLINE, () =>
    withDatabase(conn, database, async (client) => {
      const tables = tablesOf(
        await queryRows(client, { sql: TABLES_SQL, row: COLUMN_ROW }),
      );
      let rewritten = 0;
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(
          `DO $$ BEGIN
             IF to_regclass('public.${LIVE_STATE_HANDOFF_TABLE}') IS NOT NULL THEN
               DELETE FROM ${LIVE_STATE_HANDOFF_TABLE};
             END IF;
           END $$`,
        );
        for (const table of tables) {
          for (const move of moves) {
            const { sql, params } = tableUpdateSql(table, move);
            rewritten += (await client.query(sql, params)).rowCount ?? 0;
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      return rewritten;
    }),
  );
}

/** Every column of one database still holding a stored path under a moved prefix. */
export async function scanDatabase(
  conn: DatabaseConfig["connection"],
  database: string,
  moves: readonly Move[],
): Promise<DbLeftover[]> {
  return withQueryDeadline(MIGRATION_DEADLINE, () =>
    withDatabase(conn, database, async (client) => {
      const tables = tablesOf(
        await queryRows(client, { sql: TABLES_SQL, row: COLUMN_ROW }),
      );
      const leftovers: DbLeftover[] = [];
      for (const table of tables) {
        const { sql, params } = tableScanSql(table, moves);
        const row = await queryOne(client, {
          sql,
          params,
          row: z.record(z.string(), z.number()),
        });
        table.columns.forEach((column, i) => {
          const rows = row[`c${i}`];
          if (rows === undefined) {
            throw new Error(
              `count over ${table.schema}.${table.name} has no c${i}`,
            );
          }
          if (rows > 0) {
            leftovers.push({
              database,
              column: `${table.schema}.${table.name}.${column.name}`,
              rows,
            });
          }
        });
      }
      return leftovers;
    }),
  );
}
