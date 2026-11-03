import { z } from "zod";
import { READ_ALIAS_SCHEMA } from "@plugins/database/plugins/derived-views/core";
import {
  queryRows,
  type SqlQueryable,
} from "@plugins/database/plugins/sql-rows/core";

// What `query_db` tells an agent about the read aliases it queries through
// (derived-views' `agent_read` schema: `tasks` answers with `tasks_v`), and the
// hint it adds to an unknown-column error. Both are read off the catalog, so a
// new `<table>_v` view is covered without an edit here.

/** One alias: the name it shadows, the view it reads, the columns only the view has. */
export interface ReadAlias {
  readonly name: string;
  readonly view: string;
  readonly added: readonly string[];
}

/** Every live read alias of the database `client` is connected to. */
export async function readAliases(client: SqlQueryable): Promise<ReadAlias[]> {
  // `information_schema` name columns are domains over `name`; cast to text so
  // `pg` decodes them (it cannot decode `name[]`).
  const rows = await queryRows(client, {
    sql: `
      SELECT u.view_name::text AS name,
             u.table_name::text AS view,
             coalesce((
               SELECT array_agg(c.column_name::text ORDER BY c.ordinal_position)
                 FROM information_schema.columns c
                WHERE c.table_schema = 'public' AND c.table_name = u.table_name
                  AND NOT EXISTS (
                        SELECT 1 FROM information_schema.columns b
                         WHERE b.table_schema = 'public'
                           AND b.table_name = u.view_name
                           AND b.column_name = c.column_name)
             ), ARRAY[]::text[]) AS added
        FROM information_schema.view_table_usage u
       WHERE u.view_schema = $1 AND u.table_schema = 'public'
       ORDER BY 1`,
    params: [READ_ALIAS_SCHEMA],
    row: z.object({
      name: z.string(),
      view: z.string(),
      added: z.array(z.string()),
    }),
  });
  return rows;
}

// Whether `sql` names relation `name` (bare or double-quoted, never `name_v`).
// `unqualified` also refuses `public.name` / `x.name` — the spellings that do
// not resolve through the search path.
function namesRelation(
  sql: string,
  name: string,
  { unqualified }: { unqualified: boolean },
): boolean {
  const before = unqualified ? "(?<![\\w.])" : "(?<![\\w])";
  return new RegExp(`${before}"?${name}"?(?![\\w])`, "i").test(sql);
}

/** The aliases `sql` reaches by an unqualified name. */
export function aliasesNamedIn(
  sql: string,
  aliases: readonly ReadAlias[],
): ReadAlias[] {
  return aliases.filter((a) =>
    namesRelation(sql, a.name, { unqualified: true }),
  );
}

/** The one line per alias the first use in a conversation is told. */
export function describeAliases(aliases: readonly ReadAlias[]): string {
  return aliases
    .map(
      (a) =>
        `\`${a.name}\` here is the view \`${a.view}\`` +
        (a.added.length > 0 ? ` (adds ${a.added.join(", ")})` : "") +
        `; the physical table is \`public.${a.name}\`.`,
    )
    .join(" ");
}

const UNDEFINED_COLUMN = "42703";

/** The column an undefined-column error names, or undefined for any other error. */
export function undefinedColumnOf(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  if ((err as { code?: string }).code !== UNDEFINED_COLUMN) return undefined;
  const m = /column (?:"?\w+"?\.)?"?(\w+)"? does not exist/.exec(err.message);
  return m?.[1];
}

/**
 * Where `column` does exist, among the public relations `sql` names (and each
 * one's `<name>_v`) — the hint for an undefined-column error. Empty when none
 * has it.
 */
export async function relationsWithColumn(
  client: SqlQueryable,
  sql: string,
  column: string,
): Promise<string[]> {
  const rows = await queryRows(client, {
    sql: `
      SELECT DISTINCT table_name::text AS name
        FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = $1
       ORDER BY 1`,
    params: [column],
    row: z.object({ name: z.string() }),
  });
  return rows
    .map((r) => r.name)
    .filter(
      (name) =>
        namesRelation(sql, name, { unqualified: false }) ||
        (name.endsWith("_v") &&
          namesRelation(sql, name.slice(0, -2), { unqualified: false })),
    );
}
