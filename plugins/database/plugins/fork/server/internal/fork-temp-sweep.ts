import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import {
  listDatabases,
  isForkTempName,
  reclaimForkTemp,
} from "@plugins/database/plugins/admin/server";

// Reaps orphaned `f_*__forking` temp DBs: those whose fork died before renaming
// or dropping its temp (killed, crashed, host rebooted). Runs every 15 min on
// the main runtime only (no perWorktree) — DBs are a global cluster resource,
// so a single sweep covers all worktrees.
export const forkTempSweepJob = defineJob({
  name: "database.fork-temp-sweep",
  description:
    "Drops half-finished temporary database copies left behind by interrupted worktree forks.",
  // instant: catalog queries plus a `DROP DATABASE` per orphan — no subprocess,
  // no dump/restore. The sweep runs beside `database.fork`, but it does none of
  // that job's work.
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "*/15 * * * *" },
  async run() {
    const temps = (await listDatabases()).filter(isForkTempName);
    for (const temp of temps) {
      // A live fork holds its temp's lease from before CREATE to after the
      // rename; a temp whose lease is free is an orphan. (Not "zero
      // connections": a live fork has none while it queues for its slot and
      // dumps the source.)
      await reclaimForkTemp(temp);
    }
  },
});
