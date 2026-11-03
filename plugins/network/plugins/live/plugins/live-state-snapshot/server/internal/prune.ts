import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { db } from "@plugins/database/server";
import { pruneChangelog } from "./changelog-horizon";

// Prunes the durable changelog and records the prune horizon in the same
// statement (`pruneChangelog`). Runs per-worktree because each worktree DB fork
// has its own changelog + snapshot tables.
export const liveStateChangelogPruneJob = defineJob({
  name: "database.live-state-changelog-prune",
  description:
    "Deletes old live-state changelog rows that no saved snapshot can need any more, keeping the table small.",
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "0 * * * *", perWorktree: true },
  maxAttempts: 3,
  async run() {
    await pruneChangelog(db);
  },
});
