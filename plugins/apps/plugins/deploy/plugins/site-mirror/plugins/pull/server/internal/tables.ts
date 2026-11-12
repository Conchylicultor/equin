import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { externalIdColumn, idRef } from "@plugins/ids/server";
import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
import { deploymentIdKind } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { tableMirrorReplicas } from "@plugins/database/plugins/table-mirror/plugins/replica/server";

/**
 * The replicas this computer keeps of its deployments' boxes: one per
 * (deployment, mirror set), created by the first sync asked for it. It goes
 * with the deployment (the hourly pull-all then drops its replica and schema)
 * and with the replica (`dropReplica`).
 */
export const siteMirrorReplicas = pgTable(
  "site_mirror_replicas",
  {
    replicaId: externalIdColumn("replica_id", {
      reason:
        "the table-mirror replica's own id (site-mirror:<deployment>:<set>), named by this plugin",
    }).references(() => tableMirrorReplicas.id, { onDelete: "cascade" }),
    deploymentId: idRef(
      deploymentIdKind,
      "deployment_id",
      () => _deployDeployments.id,
      { onDelete: "cascade" },
    ).notNull(),
    setId: text("set_id").notNull(),
    /** When a pull was last asked for (sync, a chunk's follow-up, the hourly job). */
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    /** The last pull job threw: its message, until a run ends without throwing. */
    runError: text("run_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [unique().on(t.deploymentId, t.setId)],
);
