import { z } from "zod";
import { libpqEnv } from "@plugins/database/core";
import {
  queryRows,
  SqlRowError,
} from "@plugins/database/plugins/sql-rows/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";

// Which prototypes the user deleted, read by a CLI process — which has no
// backend, no drizzle `db` and no runtime namespace of its own, only a
// checkout. `./equin prototype list` asks it, so the terminal leaves out what
// the checkout's gallery has in its Trash.
//
// Read from the CHECKOUT'S database — the one its own app serves, whose gallery
// the listed URLs open: main's on main, a worktree's fork in a worktree (the
// state is per instance on purpose). A database is named after its namespace.
// The names below are the drizzle table's own, pinned to it by
// `deleted-prototypes.test.ts` — a raw `pg` query, because loading the server
// barrel that owns the table would boot its module graph in a CLI process.

/** This plugin's `prototype_state` table (no row = not deleted). */
export const PROTOTYPE_STATE_TABLE = {
  name: "prototype_state",
  id: "id",
  deletedAt: "deleted_at",
};

/** What `readDeletedPrototypes` found out. */
export type DeletedPrototypes =
  /** The ids (`proto-…`) of every prototype deleted in this instance. */
  | { kind: "read"; ids: ReadonlySet<string> }
  /** The database could not answer — `reason` says why, for the user. */
  | { kind: "unavailable"; reason: string };

/** Postgres: the database named in the connection does not exist. */
const NO_DATABASE = "3D000";
/** Postgres: the relation does not exist. */
const NO_TABLE = "42P01";

/**
 * The prototypes deleted in `namespace`'s instance.
 *
 * Never throws for a database it cannot consult — unreachable, never created
 * (a checkout that was never built), or older than the table: the caller
 * decides what an unanswerable question means for it, and must say so. A query
 * that fails otherwise, or a row that does not parse, is a broken invariant and
 * throws.
 */
export async function readDeletedPrototypes(
  namespace: Namespace,
): Promise<DeletedPrototypes> {
  const env = libpqEnv();
  const { Client } = await import("pg");
  const client = new Client({
    host: env.PGHOST,
    port: parseInt(env.PGPORT ?? "", 10),
    user: env.PGUSER,
    database: namespace,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
  });
  try {
    try {
      await client.connect();
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      return {
        kind: "unavailable",
        reason:
          pgCode(err) === NO_DATABASE
            ? `database "${namespace}" does not exist (this checkout was never built)`
            : err.message,
      };
    }
    const t = PROTOTYPE_STATE_TABLE;
    try {
      const rows = await queryRows(client, {
        sql: `SELECT ${t.id} AS id FROM ${t.name} WHERE ${t.deletedAt} IS NOT NULL`,
        row: z.object({ id: z.string() }),
      });
      return { kind: "read", ids: new Set(rows.map((r) => r.id)) };
    } catch (err) {
      if (err instanceof SqlRowError) throw err;
      if (err instanceof Error && pgCode(err) === NO_TABLE) {
        return {
          kind: "unavailable",
          reason: `database "${namespace}" has no ${t.name} table yet (./equin build migrates it)`,
        };
      }
      throw err;
    }
  } finally {
    await client.end().catch((err: unknown) => {
      // The connection may never have opened; that failure is reported above.
      if (!(err instanceof Error)) throw err;
    });
  }
}

function pgCode(err: Error): unknown {
  return (err as { code?: unknown }).code;
}
