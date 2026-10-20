import { z } from "zod";
import { libpqEnv } from "@plugins/database/core";
import {
  queryRows,
  SqlRowError,
} from "@plugins/database/plugins/sql-rows/core";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import {
  DEFAULT_TASK_TRACK,
  TaskTrackSchema,
  type TaskTrack,
} from "../../core";

// The track of the task a checkout works on, read by a CLI process — which has
// no backend, no drizzle `db` and no worktree identity of its own, only a
// checkout. A CLI op asks it to decide its host-admission priority (the
// sidequest track yields to the main track).
//
// Read from the MAIN database, never the checkout's fork: the fork is a copy
// taken when the worktree was created, so a track switched since then would
// read stale. The names below are the drizzle tables' own, pinned to them by
// `checkout-track.test.ts` — a raw `pg` query, because loading the server
// barrels that own the tables would boot their module graph in a CLI process.

/** The `attempts` table, owned by `tasks/tasks-core`. */
export const ATTEMPTS_TABLE = { name: "attempts", id: "id", taskId: "task_id" };
/** This plugin's `tasks_ext_track` side-table (absence = the default track). */
export const TRACK_TABLE = {
  name: "tasks_ext_track",
  taskId: "parent_id",
  track: "track",
};

/** What `checkoutTrack` found out. */
export type CheckoutTrack =
  /** The checkout is an attempt's worktree; its task is on `track`. */
  | { kind: "track"; track: TaskTrack }
  /** No attempt is named after this checkout (main, a clone, a hand-made worktree). */
  | { kind: "no-task" }
  /** The main database could not answer — it is down, or this host has none. */
  | { kind: "unavailable"; reason: string };

/**
 * The track of the task whose attempt this checkout is. An attempt's worktree
 * is named after the attempt (`att-…`), so `worktreeName` is the checkout's
 * directory name (`checkoutWorktreeName`).
 *
 * Never throws for a database it cannot reach: the caller decides what an
 * unanswerable question means for it, and must say so.
 */
export async function checkoutTrack(
  worktreeName: string,
): Promise<CheckoutTrack> {
  const env = libpqEnv();
  const { Client } = await import("pg");
  const client = new Client({
    host: env.PGHOST,
    port: parseInt(env.PGPORT ?? "", 10),
    user: env.PGUSER,
    database: MAIN_WORKTREE_NAME,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
  });
  let rows: { track: TaskTrack | null }[];
  try {
    await client.connect();
    const a = ATTEMPTS_TABLE;
    const t = TRACK_TABLE;
    rows = await queryRows(client, {
      sql:
        `SELECT tr.${t.track} AS track FROM ${a.name} a ` +
        `LEFT JOIN ${t.name} tr ON tr.${t.taskId} = a.${a.taskId} ` +
        `WHERE a.${a.id} = $1`,
      params: [worktreeName],
      // A row with no track row is on the default track (absence = main).
      row: z.object({ track: TaskTrackSchema.nullable() }),
    });
  } catch (err) {
    // A row that fails to parse is a broken invariant, not an unreachable
    // database — let it throw.
    if (err instanceof SqlRowError) throw err;
    if (!(err instanceof Error)) throw err;
    return { kind: "unavailable", reason: err.message };
  } finally {
    await client.end().catch((err: unknown) => {
      // The connection may never have opened; that failure is reported above.
      if (!(err instanceof Error)) throw err;
    });
  }
  const row = rows[0];
  if (!row) return { kind: "no-task" };
  return {
    kind: "track",
    track:
      row.track === null
        ? DEFAULT_TASK_TRACK
        : TaskTrackSchema.parse(row.track),
  };
}
