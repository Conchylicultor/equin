import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { openShortLivedClient } from "@plugins/database/plugins/admin/server";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import {
  closeRunOn,
  insertRunOn,
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
  const pool = openShortLivedClient(namespace);
  const db: NodePgDatabase = drizzle(pool);

  // Nothing but the pool binding lives here: both writes are the exported
  // db-parametrized bodies in `shared/recorder.ts`, so what the tests drive is
  // what the CLI runs.
  return {
    insertRun: (r) => insertRunOn(db, namespace, r),
    closeRun: (id, exitCode) => closeRunOn(db, id, exitCode),
    close: () => pool.end(),
  };
}
