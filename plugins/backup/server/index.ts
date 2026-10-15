import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { TaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { BACKUP_CATEGORY_ID } from "../core/task-category";
import { backupConfig } from "../shared/config";
import { runBackup } from "../shared/endpoints";
import { backupRunJob } from "./internal/backup-job";
import { handleRun } from "./internal/handle-run";
import { backupIncompleteKind } from "./internal/report-kind";
import { reconcileBackups } from "./internal/reconcile-backups";

export { BackupSource, BackupTarget } from "./internal/contribution";
export { backupIncompleteKind } from "./internal/report-kind";
export type { BackupIncompletePayload } from "./internal/report-kind";
export { _backupRuns } from "./internal/tables";

export default {
  description:
    "Backup orchestrator: assembles archives from registered backup sources, dispatches to registered storage targets. The assembly runs OUT OF PROCESS as a supervised job's `run` body, so a backend restart mid-`tar` no longer kills the backup.",
  httpRoutes: {
    [runBackup.route]: handleRun,
  },
  contributions: [
    ConfigV2.Register({ descriptor: backupConfig }),
    TaskCategory({ id: BACKUP_CATEGORY_ID, label: "Backup", order: 14 }),
    // The kind has to exist on MAIN's backend, which is what drains the outbox
    // the child writes into — the child itself only writes a file. Registering
    // it here (rather than in the child alone) is what makes the drain able to
    // resolve it.
    backupIncompleteKind,
  ],
  onReady: async () => {
    // BACKUPS_DIR is host-global; only the main runtime owns backup lifecycle.
    // A filesystem sweep only — closing rows belongs to the supervised job now.
    if (isMain()) await reconcileBackups();
  },
  // One token: `backupRunJob` mounts the queue job (with its nightly schedule),
  // its supervised-run kind — which is what makes a backup reconcilable after a
  // restart — and the `run` body's task, which `./singularity supervised-exec`
  // resolves in the child.
  register: [backupRunJob],
} satisfies ServerPluginDefinition;
