import { and, isNotNull, lt, not, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@plugins/database/server";
import { Log } from "@plugins/primitives/plugins/log-channels/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { AttachmentBlobs } from "./blobs";
import { _attachmentHolds, _attachments } from "./tables";
import { getRegisteredLinks } from "./define-link";

const TTL_MS = 60 * 60 * 1000; // 1 hour orphan age before delete
const log = Log.channel("attachments");

// Reclaims attachment rows that no registered link table references, past a
// TTL grace period. Runs hourly via the jobs cron primitive. The schedule is
// main-only by default (not `perWorktree`), so a single sweep runs on the main
// runtime — attachments live on the shared ~/.singularity filesystem, so
// running this per-worktree would race N sweeps over the same global dir.
export const orphanSweepJob = defineJob({
  name: "attachments.orphan-sweep",
  description:
    "Deletes uploaded files that nothing references any more once they are past a grace period.",
  // instant: one bounded DELETE plus an unlink per reclaimed file. The 2.2s hold
  // this shows in the profile is almost entirely admission-gate wait — 62ms of it
  // is work — and the class is declared from the work.
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "5 * * * *" }, // hourly, offset 5 min
  async run() {
    const cutoff = new Date(Date.now() - TTL_MS);
    const links = getRegisteredLinks();
    // An attachment is "referenced" if any registered link table has a row
    // pointing at its id, or a live hold keeps it (an unsent draft — see
    // `_attachmentHolds`). Build NOT (EXISTS … OR EXISTS …) across all
    // sources. Single statement → Postgres snapshot keeps us from racing a
    // just-inserted link.
    const held = sql`exists (select 1 from ${_attachmentHolds} where ${_attachmentHolds.attachmentId} = ${_attachments.id} and (${_attachmentHolds.expiresAt} is null or ${_attachmentHolds.expiresAt} > now()))`;
    const unreferenced = not(
      or(
        held,
        ...links.map(
          (l) =>
            sql`exists (select 1 from ${l.table} where ${l.attachmentIdCol} = ${_attachments.id})`,
        ),
      )!,
    );
    // Expired holds are dead weight whether or not their attachment goes.
    await db
      .delete(_attachmentHolds)
      .where(
        and(
          isNotNull(_attachmentHolds.expiresAt),
          lt(_attachmentHolds.expiresAt, new Date()),
        ),
      );
    const rows = await db
      .delete(_attachments)
      .where(and(lt(_attachments.createdAt, cutoff), unreferenced))
      .returning({ diskPath: _attachments.diskPath });
    // Best-effort blob cleanup, AFTER the DB rows are already deleted: a
    // per-blob failure must not abort the sweep of the remaining orphans, which
    // is the store's own contract (`AttachmentBlobs.delete` never throws for a
    // missing or undeletable blob).
    const blobs = AttachmentBlobs.get();
    await Promise.all(rows.map((r) => blobs.delete(r.diskPath)));
    if (rows.length > 0) {
      log.publish(`orphan sweep removed ${rows.length} files`);
    }
  },
});
