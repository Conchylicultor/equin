/**
 * Synthetic mail threads for the threads e2e scripts.
 *
 * A worktree's database carries no mail corpus (`mail_threads` is excluded
 * from the fork — sync is main-only), so a script that needs rows seeds them
 * for the connected account, straight into THIS deploy's database, and deletes
 * them when it is done. Every seeded id carries the run's prefix, so cleanup
 * can never touch a real thread; opening a fixture first sweeps what a killed
 * run left behind (every id under the `e2e-` prefix).
 *
 * It refuses main: seeding writes into the database the
 * backend serves, and main's is the user's real mailbox. The account it seeds
 * for is the one the app scopes the list to, read from the `mailAccount` value
 * over HTTP rather than restated as SQL.
 *
 * Postgres is reached through `@plugins/database/core`'s config helpers with a
 * plain `pg.Pool` (the e2e runtime reaches only `core` / `e2e` barrels) — the
 * shape `database/admin/e2e/fork-bench.ts` uses.
 */
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import {
  buildConnectionString,
  readDatabaseConfig,
} from "@plugins/database/core";
import { z } from "zod";
import {
  agentFetch,
  targetNamespace,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { mailAccount } from "@plugins/apps/plugins/mail/plugins/mail-core/core";

/** One seeded thread: what the script needs to find it on screen and write it. */
export interface SeededThread {
  id: string;
  subject: string;
}

export interface ThreadFixture {
  /** The connected account every seeded thread belongs to. */
  accountId: string;
  /** How many threads the account held before seeding. */
  existing: number;
  /** Seed one thread; `minutesAgo` sets its `last_message_at`. */
  seed(opts: {
    name: string;
    labels: readonly string[];
    minutesAgo: number;
  }): Promise<SeededThread>;
  /** Run one statement against this deploy's database. */
  exec(sql: string, params: readonly unknown[]): Promise<void>;
  /** Delete every thread this fixture seeded, and close the pool. Idempotent. */
  cleanup(): Promise<void>;
}

function connString(database: string): string {
  const config = readDatabaseConfig();
  return buildConnectionString(
    {
      host: process.env.PGHOST ?? config.connection.host,
      port: Number(process.env.PGPORT ?? config.connection.port),
      user: process.env.PGUSER ?? config.connection.user,
    },
    database,
  );
}

export async function openThreadFixture(): Promise<ThreadFixture> {
  const namespace = String(targetNamespace());
  if (namespace === MAIN_WORKTREE_NAME) {
    throw new Error(
      "refusing to seed synthetic threads into main's mailbox — run this against a worktree deploy",
    );
  }
  // THE account, read from the `mailAccount` value the pane scopes by — so the
  // fixture cannot drift from the choice the app makes.
  const res = await agentFetch(`/api/resources/${mailAccount.key}`);
  if (!res.ok) {
    throw new Error(
      `GET /api/resources/${mailAccount.key} → HTTP ${res.status}`,
    );
  }
  const account = mailAccount.schema.parse(
    z.object({ value: z.unknown() }).parse(await res.json()).value,
  );
  if (account === null) {
    throw new Error(
      `no mail account in "${namespace}" — the threads list has nothing to scope to`,
    );
  }
  const accountId = account.id;
  const pool = new Pool({ connectionString: connString(namespace), max: 2 });
  // A run that died before its cleanup left its threads: sweep them first.
  await pool.query(
    "DELETE FROM mail_threads WHERE account_id = $1 AND id LIKE 'e2e-%'",
    [accountId],
  );
  const counted = await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM mail_threads WHERE account_id = $1",
    [accountId],
  );
  const prefix = `e2e-${randomBytes(3).toString("hex")}`;
  let closed = false;
  return {
    accountId,
    existing: Number(counted.rows[0]?.n ?? "0"),
    seed: async ({ name, labels, minutesAgo }) => {
      const id = `${prefix}-${name}`;
      const subject = `${prefix} ${name}`;
      await pool.query(
        `INSERT INTO mail_threads
           (id, account_id, subject, snippet, participants, last_message_at,
            message_count, unread, label_ids)
         VALUES ($1, $2, $3, $4, $5::jsonb, now() - make_interval(mins => $6::int),
                 1, true, $7::jsonb)`,
        [
          id,
          accountId,
          subject,
          "seeded by an e2e script",
          JSON.stringify([{ name: "E2E", email: "e2e@example.invalid" }]),
          minutesAgo,
          JSON.stringify(labels),
        ],
      );
      return { id, subject };
    },
    exec: async (sql, params) => {
      await pool.query(sql, [...params]);
    },
    cleanup: async () => {
      if (closed) return;
      closed = true;
      await pool.query("DELETE FROM mail_threads WHERE id LIKE $1", [
        `${prefix}-%`,
      ]);
      await pool.end();
    },
  };
}
