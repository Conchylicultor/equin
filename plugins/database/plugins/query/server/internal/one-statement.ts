import type { PoolClient } from "pg";
import type { SqlQueryable } from "@plugins/database/plugins/sql-rows/core";

const MULTIPLE_COMMANDS =
  "cannot insert multiple commands into a prepared statement";

/**
 * `client`, sending every query over the extended protocol, which Postgres
 * refuses multi-statement SQL on before running any of it.
 *
 * The simple protocol — what pg uses for a param-less query — runs every
 * statement of `ROLLBACK; DELETE …` and only then answers. For caller-written
 * SQL that would step out of the tool's READ ONLY transaction (the connection
 * is the cluster owner); one statement can only ever run inside it.
 */
export function oneStatement(client: PoolClient): SqlQueryable {
  return {
    async query(text, values) {
      try {
        return await client.query({ text, values, queryMode: "extended" });
      } catch (err) {
        if (!(err instanceof Error) || err.message !== MULTIPLE_COMMANDS) {
          throw err;
        }
        throw new Error(
          "query_db runs exactly one SQL statement — send each statement as its own call. " +
            "The tool already runs it in a READ ONLY transaction with `search_path` set to the read aliases, then `public`.",
          { cause: err },
        );
      }
    },
  };
}
