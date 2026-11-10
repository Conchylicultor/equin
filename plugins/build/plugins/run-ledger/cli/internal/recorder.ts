import type { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { openShortLivedClient } from "@plugins/database/plugins/admin/server";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import {
  closeRunOn,
  insertRunOn,
  lastClosedRunOn,
  type BuildRunRecorder,
} from "../../shared/recorder";

/**
 * The CLI-side `build_runs` writer for ONE namespace's database — the building
 * checkout's own. It used to be hardcoded to main's, because the only rows it
 * wrote were main's deploy and its compose-serve children; a composition is now
 * built and served from any checkout, and its row belongs with the transcript
 * and profile that checkout's backend serves.
 */
export function createBuildRunRecorder(namespace: Namespace): BuildRunRecorder {
  // Opened on first write: the pool's connection config is read async.
  let opened: Promise<{ pool: Pool; db: NodePgDatabase }> | null = null;
  const open = (): Promise<{ pool: Pool; db: NodePgDatabase }> =>
    (opened ??= openShortLivedClient(namespace).then((pool) => ({
      pool,
      db: drizzle(pool),
    })));

  // Nothing but the pool binding lives here: every statement is the exported
  // db-parametrized bodies in `shared/recorder.ts`, so what the tests drive is
  // what the CLI runs.
  return {
    insertRun: async (r) => insertRunOn((await open()).db, namespace, r),
    closeRun: async (id, exitCode) =>
      closeRunOn((await open()).db, id, exitCode),
    lastClosedRun: async (target) =>
      lastClosedRunOn((await open()).db, namespace, target),
    close: async () => {
      if (opened === null) return;
      await (await opened).pool.end();
    },
  };
}
