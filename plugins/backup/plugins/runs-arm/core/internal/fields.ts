import { z } from "zod";
import { nullable } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { enumTextField } from "@plugins/fields/plugins/text/plugins/config/core";
import { liveArm } from "@plugins/network/plugins/live/core";
import { BACKUP_RUN_KIND } from "@plugins/backup/core";
import { runs } from "@plugins/runs/core";
import {
  BackupSourceReportSchema,
  BackupTargetResultSchema,
} from "./payload-schemas";
import { BACKUP_RUN_STATUSES, type BackupRunStatus } from "./status";

/**
 * The fields only a backup run has — its slice of the `runs` union
 * (`$columns.backup`), ids and wire names `backup.<field>`, listed under the
 * "Backup" band of every list of the union.
 *
 * `status` is the arm's **native** status, kept beside the shared `outcome`
 * rather than instead of it — and the reason the shared vocabulary has a
 * `partial` at all: a backup that reached three of four targets is neither a
 * success nor a failure.
 *
 * `targetResults` and `sources` (carried, never listed) are the raw jsonb
 * columns the detail pane reads — *which* target failed and what it said, and
 * what went into the archive. Neither filters nor sorts: a blob has no
 * comparable projection. Both are bounded by things a person configures
 * (targets, sources).
 */
export const backupRunArm = liveArm(runs, BACKUP_RUN_KIND, {
  label: "Backup",
  fields: {
    /** `running` / `ok` / `partial` / `failed` — the arm's own vocabulary. */
    status: enumTextField(
      BACKUP_RUN_STATUSES as [BackupRunStatus, ...BackupRunStatus[]],
      {
        label: "Backup status",
        options: {
          running: { label: "running" },
          ok: { label: "ok" },
          partial: { label: "partial" },
          failed: { label: "failed" },
        },
      },
    ),
    /** Archive bytes. Null while the run has not produced an archive yet. */
    archiveSize: nullable(intField({ label: "Archive size" })),
    /** Sources that actually went in (skipped ones excluded). Null pre-manifest. */
    sourceCount: nullable(intField({ label: "Sources" })),
    /** Storage targets dispatched to. Null until the run has dispatched. */
    targetCount: nullable(intField({ label: "Targets" })),
  },
  carry: {
    /** Per-target outcomes, verbatim. */
    targetResults: nullable(
      jsonField({ schema: z.array(BackupTargetResultSchema), default: [] }),
    ),
    /** The manifest's source reports (v2+ array form only). */
    sources: nullable(
      jsonField({ schema: z.array(BackupSourceReportSchema), default: [] }),
    ),
  },
  sortable: ["status", "archiveSize", "sourceCount", "targetCount"],
});
