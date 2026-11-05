import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { compileCreateView } from "@plugins/database/plugins/derived-views/core";
import { installRollups } from "@plugins/database/plugins/derived-tables/server/testing";
import { installDbTriggers } from "@plugins/database/plugins/db-triggers/server";
import { TASK_ROLLUPS } from "../internal/task-rollups";
import { taskClusterTriggers } from "../internal/cluster-triggers";
import {
  attempts,
  conversations,
  taskBlocking,
  tasks,
} from "../internal/views";

// Install this plugin's derived layer — the two attempt rollups, the four
// views and the cluster triggers — onto a database that has only the migration chain: a `createTestDb`
// throwaway. At boot the same DDL comes from the schema layer's rollup install /
// `rebuildDerivedViews` over this plugin's contributions; a headless suite has
// no plugin registry, so it installs the SAME exported declarations here
// (`installRollups` is the boot rollup path itself), and the SQL under test is
// byte-identical to what a backend installs.
//
// For suites outside this plugin that drive tasks-core writes on a throwaway —
// a status batch reads `tasks_v`, and `createAttempt` / `insertConversation`
// read `attempts_v` / `conversations_v` back.
export async function installTaskDerivedSchema(
  db: NodePgDatabase,
): Promise<void> {
  // The migration chain still contains the historical CREATE VIEW statements
  // from before plain views became derived code, so drop whatever it left
  // behind first (CASCADE: tasks_v reads attempts_v).
  for (const name of [
    "tasks_v",
    "task_blocking_v",
    "conversations_v",
    "attempts_v",
  ]) {
    await db.execute(sql.raw(`DROP VIEW IF EXISTS "public"."${name}" CASCADE`));
  }

  // Every edge write unions its clusters, as at boot.
  await installDbTriggers(db, [taskClusterTriggers]);

  // attempts_v LEFT JOINs the two trigger-maintained rollups.
  await installRollups(db, TASK_ROLLUPS);

  // Dependency order: attempts_v → task_blocking_v → tasks_v.
  for (const [name, view] of [
    ["attempts_v", attempts],
    ["conversations_v", conversations],
    ["task_blocking_v", taskBlocking],
    ["tasks_v", tasks],
  ] as const) {
    await db.execute(sql.raw(compileCreateView({ name, view, dependsOn: [] })));
  }
}
