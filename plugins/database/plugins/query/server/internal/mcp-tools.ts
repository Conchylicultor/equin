import { z } from "zod";
import { basename } from "path";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { resolveNamespaceAlias } from "@plugins/infra/plugins/namespace/core";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import {
  openShortLivedClient,
  databaseExists,
} from "@plugins/database/plugins/admin/server";
import {
  queryResult,
  type ParsedResult,
} from "@plugins/database/plugins/sql-rows/core";
import { READ_ALIAS_SCHEMA } from "@plugins/database/plugins/derived-views/core";
import {
  aliasesNamedIn,
  describeAliases,
  readAliases,
  relationsWithColumn,
  undefinedColumnOf,
} from "./read-aliases";

const MAX_ROWS = 200;

// Conversations already told what the read aliases are. In memory: after a
// restart a conversation is told once more, which costs one line.
const toldAliases = new Set<string>();

export const queryDbTool = Mcp.tool({
  name: "query_db",
  description: `Execute a read-only SQL query against a worktree's PostgreSQL database.
For debugging and inspection only. All queries run in a READ ONLY transaction.
Returns up to ${MAX_ROWS} rows.

A table with a derived \`<table>_v\` view reads as that view: \`tasks\` here is \`tasks_v\`
(with computed columns such as \`status\`), \`public.tasks\` is the physical table.

Default: queries the current conversation's worktree database.
Pass \`database\` to target a different worktree (e.g. "att-1778089188-7uvf", or "equin" for main).`,
  inputSchema: {
    sql: z.string().min(1).describe("SQL query to execute (read-only)."),
    database: z
      .string()
      .optional()
      .describe(
        'Target database: a worktree name, or "equin" for main. Defaults to the conversation\'s own worktree DB.',
      ),
  },
  async handler({ sql, database }, { conversationId }) {
    let dbName: string;
    if (database) {
      dbName = resolveNamespaceAlias(database);
    } else {
      const conv = await getConversation(conversationId);
      if (!conv) throw new Error(`Unknown conversation "${conversationId}"`);
      dbName = basename(conv.worktreePath);
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(dbName)) {
      throw new Error(`Unsafe database name: "${dbName}"`);
    }
    if (!(await databaseExists(dbName))) {
      throw new Error(`Database not found: "${dbName}"`);
    }

    const pool = openShortLivedClient(dbName);
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        await client.query("SET LOCAL statement_timeout = '5000'");
        // An unqualified table name resolves to its read alias — the view
        // that adds its computed columns (derived-views' read aliases).
        await client.query(
          `SET LOCAL search_path = "${READ_ALIAS_SCHEMA}", public`,
        );
        const aliases = await readAliases(client);
        // The SQL is written by the caller, so there is no fixed shape to
        // declare: the honest schema asserts that each row is an object and
        // nothing more. `queryResult` (rather than `queryRows`) because the
        // tool reports `fields` — the column names nobody knew ahead of time —
        // and `rowCount`.
        let result: ParsedResult<Record<string, unknown>>;
        try {
          result = await queryResult(client, {
            sql,
            row: z.record(z.string(), z.unknown()),
          });
        } catch (err) {
          await client.query("ROLLBACK");
          const column = undefinedColumnOf(err);
          if (column === undefined) throw err;
          const owners = await relationsWithColumn(client, sql, column);
          if (owners.length === 0) throw err;
          throw new Error(
            `${(err as Error).message}\nHint: \`${column}\` is a column of ${owners
              .map((o) => `\`public.${o}\``)
              .join(", ")}.`,
            { cause: err },
          );
        }
        await client.query("ROLLBACK");
        const rows = result.rows.slice(0, MAX_ROWS);
        const named = toldAliases.has(conversationId)
          ? []
          : aliasesNamedIn(sql, aliases);
        const note = named.length > 0 ? describeAliases(named) : undefined;
        if (note !== undefined) toldAliases.add(conversationId);
        const columns = result.fields.map((f) => f.name);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                database: dbName,
                columns,
                rows,
                rowCount: result.rowCount,
                truncated: (result.rowCount ?? 0) > MAX_ROWS,
                ...(note === undefined ? {} : { note }),
              }),
            },
          ],
        };
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  },
});
