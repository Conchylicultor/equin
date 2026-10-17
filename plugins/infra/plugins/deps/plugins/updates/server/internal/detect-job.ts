import { and, eq, like } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { _tasks } from "@plugins/tasks/plugins/tasks-core/server";
import { tasksCategory } from "@plugins/tasks/plugins/task-category/server";
import { defineAutomation } from "@plugins/tasks/plugins/automations/server";
import {
  assertHoldsBounded,
  isActionable,
  outdatedSections,
  upgradeTaskTitle,
  type OutdatedUpdater,
  type Updater,
} from "../../core";
import { depsUpgradesConfig } from "../../shared/config";

/** The task category every upgrade task is filed under. */
export const DEPS_CATEGORY_ID = "dependencies";

/**
 * The set of updaters: each lists `UpdaterDeclare({ updater })` in its server
 * `contributions`. The automation and `./singularity deps upgrade` read only
 * this generic set.
 */
export const UpdaterDeclare = defineServerContribution<{ updater: Updater }>(
  "updater",
  { docLabel: (c) => c.updater.id },
);

/** Every declared updater. */
export function declaredUpdaters(): Updater[] {
  return UpdaterDeclare.getContributions().map((c) => c.updater);
}

/**
 * Upgrade tasks filed before automations recorded where a task came from:
 * authored `deps.upgrade` (batched) or `deps.<updater>` (one per updater), in
 * the Dependencies category. Transition only — delete once none can be open.
 */
async function legacyUpgradeTaskIds(): Promise<string[]> {
  const c = tasksCategory.table;
  const rows = await db
    .select({ id: _tasks.id })
    .from(c)
    .innerJoin(_tasks, eq(_tasks.id, c.taskId))
    .where(
      and(eq(c.category, DEPS_CATEGORY_ID), like(_tasks.author, "deps.%")),
    );
  return rows.map((r) => r.id);
}

/**
 * On the configured schedule (weekly by default): ask every included updater
 * what is newer than its lock records and, when anything is, file ONE
 * auto-started task covering all of it, whose agent runs
 * `./singularity deps upgrade` (every updater at once) in its own worktree —
 * and pushes what landed on an `upgraded` or `partial` verdict as far as the
 * Push setting allows.
 *
 * Detection only — it installs nothing and moves no lock. One updater failing
 * to detect does not stop the others: the task still covers the ones that
 * answered, and the failures are thrown together after it is filed.
 */
export const depsUpgradesAutomation = defineAutomation({
  id: "deps-upgrades",
  label: "Dependency upgrades",
  icon: symbol("upgrade"),
  description:
    "Checks each declared updater for a newer release and files one upgrade task covering every outdated one.",
  categoryId: DEPS_CATEGORY_ID,
  config: depsUpgradesConfig,
  triggers: { kinds: ["schedule"] },
  inProcess:
    "A read-only detection pass (one release query per updater, then at most one task insert) that a restart can abort and the next scheduled tick simply repeats; each query is bounded by its own spawn timeout.",
  sources: () => declaredUpdaters().map((u) => ({ id: u.id, label: u.id })),
  promptVariables: [
    {
      name: "outdated",
      description:
        "Each outdated updater, its holds file and every release move it found",
    },
  ],
  detect: async ({ sources, partialFailure }) => {
    const included = new Set(sources.map((s) => s.id));
    const batch: OutdatedUpdater[] = [];
    for (const updater of declaredUpdaters()) {
      if (!included.has(updater.id)) continue;
      try {
        await assertHoldsBounded(updater, REPO_ROOT, new Date());
        const outdated = await updater.detect(REPO_ROOT);
        // Held rows ride along with work but never file a task on their own:
        // a hold is bounded by its `until`, after which its row is actionable.
        if (outdated.some(isActionable))
          batch.push({
            updaterId: updater.id,
            outdated,
            holdsFile: updater.holds.file,
          });
      } catch (err) {
        partialFailure(err);
      }
    }
    if (batch.length === 0) return null;
    return {
      title: upgradeTaskTitle(batch),
      variables: { outdated: outdatedSections(batch) },
      sourceKeys: batch.map((u) => u.updaterId),
    };
  },
  adoptLegacy: legacyUpgradeTaskIds,
});
