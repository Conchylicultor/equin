import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { REWIND_BACKUP_TTL_DAYS, rewindBackupsDir } from "../../data-dirs";

const log = Log.channel("conversation-rewind");

// Every rewind leaves a full transcript behind, and transcripts run to tens of
// megabytes — so the folder is bounded by age. A scheduled job rather than a
// timer: a directory has no change signal that says "a file just turned 30 days
// old". Main-only (the default): the folder is host-global, and N worktree
// backends sweeping it would only race each other.
export const rewindBackupSweepJob = defineJob({
  name: "conversations.rewind-backup-sweep",
  description:
    "Deletes rewind transcript backups that are past their retention age to free disk space.",
  // seconds: one readdir + a stat per file, no bound on the file count.
  hold: "seconds",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "30 4 * * *" }, // daily at 04:30 UTC
  async run() {
    const dir = rewindBackupsDir.ensure();
    const cutoff = Date.now() - REWIND_BACKUP_TTL_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      if ((await stat(path)).mtimeMs >= cutoff) continue;
      await unlink(path);
      removed++;
    }
    log.publish(
      `removed ${removed} rewind backup(s) older than ${REWIND_BACKUP_TTL_DAYS} days`,
    );
  },
});
