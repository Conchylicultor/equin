import { z } from "zod";
import { nullable } from "@plugins/fields/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { liveArm } from "@plugins/network/plugins/live/core";
import {
  BACKUP_RUN_KIND,
  BackupSourceReportSchema,
  backupRunFields,
  backupRunsEntityRef,
} from "@plugins/backup/core";
import { runs } from "@plugins/runs/core";

/**
 * The fields only a backup run has — its slice of the `runs` union
 * (`$columns.backup`), ids and wire names `backup.<field>`, listed under the
 * "Backup" band of every list of the union.
 *
 * Declared FROM the backup-run entity (`backupRunsEntityRef`): `status` is picked
 * with the entity's label and options, and the raw `targetResults` column is
 * carried as the entity's own field. The arm's own fields are the computed ones, and `archiveSize`,
 * which keeps its persisted id over the `archiveSizeBytes` column.
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
  // Last: host-global and orthogonal to build → release → deploy, with its own
  // pinned surface (`runs` core, "Arm order").
  order: 40,
  from: backupRunsEntityRef,
  // `running` / `ok` / `partial` / `failed` — the arm's own vocabulary.
  pick: ["status"],
  fields: {
    /** Archive bytes. Null while the run has not produced an archive yet. */
    archiveSize: nullable(intField({ label: "Archive size" })),
    /** Sources that actually went in (skipped ones excluded). Null pre-manifest. */
    sourceCount: nullable(intField({ label: "Sources" })),
    /** Storage targets dispatched to. Null until the run has dispatched. */
    targetCount: nullable(intField({ label: "Targets" })),
  },
  // An arm's `carry` is a plain fields record (no `pick`): the raw
  // `targetResults` column is carried as the entity's own field, by name.
  carry: {
    // Per-target outcomes, verbatim.
    targetResults: backupRunFields.targetResults,
    /** The manifest's source reports (v2+ array form only). */
    sources: nullable(
      jsonField({ schema: z.array(BackupSourceReportSchema), default: [] }),
    ),
  },
  sortable: ["status", "archiveSize", "sourceCount", "targetCount"],
});
