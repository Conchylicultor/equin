import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { sinkHandler } from "@plugins/framework/plugins/server-core/core";
import { interactiveMandate } from "@plugins/tasks/plugins/mandate-presets/core";
import { createTask, getTask } from "@plugins/tasks/plugins/tasks-core/server";
import { setTaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { reportInvestigationSink } from "@plugins/reports/server";

// The category investigation tasks are stamped with; the plugin contributes the
// matching TaskCategory registration.
export const REPORTS_CATEGORY_ID = "reports";

// The task-creating handler on reports' investigation sink. reports emits into
// the sink on its investigate path; this bridge holds the `tasks` dependency, so
// a standalone composition that doesn't ship it simply leaves the sink without
// a handler (emit → undefined → investigateReport throws loudly). Idempotency
// lives here: a report already linked to a live (non-dropped) task reuses it.
export const reportInvestigationHandler = sinkHandler(
  reportInvestigationSink,
  () =>
    async ({ existingTaskId, title, description, filedFrom }) => {
      if (existingTaskId) {
        const linked = await getTask(existingTaskId);
        if (linked && linked.status !== "dropped") return { taskId: linked.id };
      }
      const task = await createTask({
        title,
        description,
        // A person clicked Investigate: the task is theirs.
        filing: { author: { kind: "human" }, filedFrom: asPluginId(filedFrom) },
        mandate: interactiveMandate,
      });
      await setTaskCategory(task.id, REPORTS_CATEGORY_ID);
      return { taskId: task.id };
    },
);
