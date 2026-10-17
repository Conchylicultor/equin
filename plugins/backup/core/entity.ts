import { z } from "zod";
import { nullable, type FieldsRecord } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { BackupManifestSchema, BackupTargetResultSchema } from "./run-schemas";

/**
 * A backup run's fields, in column order — the `backup_runs` table is built
 * from them (`server/internal/tables.ts`), plus `pid`, its server field.
 */
export const backupRunFields = {
  id: textField(),
  trigger: textField({ label: "Trigger" }),
  /**
   * The namespace whose backend CLAIMED this run — not a property of the
   * backup, which is host-global (the runs arm reports `namespace: null` for
   * exactly that reason). It scopes the supervised-run reconciler (a worktree
   * DB inherits main's rows) and is what the in-flight lock contends on. See
   * `server/internal/tables.ts`.
   */
  namespace: textField(),
  startedAt: dateField({ label: "Started" }),
  finishedAt: nullable(dateField({ label: "Finished" })),
  status: textField({ label: "Status" }),
  archiveSizeBytes: nullable(intField({ label: "Size" })),
  /**
   * The wide manifest decoder on purpose — see `BackupManifestSchema`: v1 rows
   * exist, and a column that decodes has to accept what is really there.
   */
  manifest: nullable(
    jsonField({ schema: BackupManifestSchema, default: null }),
  ),
  targetResults: nullable(
    jsonField({ schema: z.array(BackupTargetResultSchema), default: [] }),
  ),
} satisfies FieldsRecord;

/** The `backup_runs` entity — every backup run, host-global. */
export const backupRunsEntityRef = entityRef("backup_runs", backupRunFields);
