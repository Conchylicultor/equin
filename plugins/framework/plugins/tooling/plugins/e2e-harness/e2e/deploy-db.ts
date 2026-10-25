import { Pool } from "pg";
import {
  buildConnectionString,
  readDatabaseConfig,
} from "@plugins/database/core";
import { targetNamespace } from "./target";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";

/**
 * The database of the deploy a run targets, for a script that seeds rows the
 * page under test then shows (a worktree carries no release history, no mail
 * corpus): a plain `pg.Pool` on the direct connection, `@plugins/database/core`'s
 * config helpers — the e2e runtime reaches only `core` / `e2e` barrels.
 *
 * It REFUSES main: a seeding script writes into the database
 * the backend serves, and main's is the user's real data. A script that seeds
 * must also delete what it seeded (`onBeforeFinish`).
 */
export interface DeployDb {
  /** The namespace (and database) it points at. */
  readonly namespace: string;
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]>;
  /** Close the pool. Idempotent. */
  close(): Promise<void>;
}

export function openDeployDb(): DeployDb {
  const namespace = String(targetNamespace());
  if (namespace === MAIN_WORKTREE_NAME) {
    throw new Error(
      "refusing to seed rows into main's database — run this against a worktree deploy",
    );
  }
  const config = readDatabaseConfig();
  const pool = new Pool({
    connectionString: buildConnectionString(
      {
        host: process.env.PGHOST ?? config.connection.host,
        port: Number(process.env.PGPORT ?? config.connection.port),
        user: process.env.PGUSER ?? config.connection.user,
      },
      namespace,
    ),
    max: 2,
  });
  let closed = false;
  return {
    namespace,
    query: async <R extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<R[]> => (await pool.query<R>(sql, [...params])).rows,
    close: async () => {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}
