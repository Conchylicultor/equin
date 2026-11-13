import {
  setTaskAutoStart,
  taskAutoStartArmed,
} from "@plugins/tasks/plugins/auto-start/server";
import { autoStartDecision } from "@plugins/tasks/plugins/auto-start/core";
import { getTask } from "@plugins/tasks/plugins/tasks-core/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import type { ModelChoice } from "@plugins/conversations/plugins/model-provider/core";
import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";

// Mark a task as queued for auto-launch, then wake the launcher.
//
// The wake-up is the `tasks.autoStartArmed` trigger event: the launcher (the
// conversations plugin's `maybeLaunchTaskJob`, through its static trigger)
// subscribes, as it does to `tasks.statusChanged`, so this plugin never names
// it — and a host with no launcher (an in-browser server) arms the task and
// wakes nothing.
//
// The wake-up is unconditional. `maybeLaunchTaskJob` decides from the task's
// status (AUTO_START_DECISIONS: launch / wait / disarm), the marker, the CAS
// and open attempts, so a blocked pre-check here would be a second copy of
// that gate — one that can only drift from the real one. A wake for a task
// that turns out to be blocked costs one read and stops.
//
// The one refusal: a task whose status decides `disarm` (done, dropped, an
// agent running) cannot be armed — the launcher would only delete the marker,
// so the arm would vanish without a word. Another run of such a task is a
// person's explicit launch (POST /api/tasks/launch), which does not arm.
//
// Setting the marker first is load-bearing: the job bails when it finds no
// marker, so waking it before the write would race a fast worker.
//
// From this point on, the task is re-checked whenever its derived status
// changes, via the static `tasks.statusChanged` → `tasks.maybe-launch-on-status`
// trigger the conversations plugin registers. (There are no per-dep oneShot
// triggers any more — the dependency graph lives solely in task_dependencies,
// and the status event now covers every task an edit affected.)
//
// `prompt` is what the agent starts with (an automation's filled template),
// stored ON the marker so whichever path claims it launches with it; absent ⇒
// the task's own text, and any prompt an earlier arm stored is cleared.
//
// `armedFrom` is the plugin arming it (`tasks` for add_task / edit_task,
// `tasks.automations`, the filing surface, …), stored on the marker: it is the
// launched conversation's `launchedFrom`, whatever wakes the launcher.
export async function armTaskAutoStart(args: {
  taskId: string;
  model: ModelChoice;
  prompt?: string;
  armedFrom: PluginId;
}): Promise<void> {
  const { taskId, model, prompt, armedFrom } = args;
  const task = await getTask(taskId);
  if (!task) throw new HttpError(404, `task ${taskId} not found`);
  if (autoStartDecision(task.status) === "disarm") {
    throw new HttpError(
      409,
      `Task ${taskId} is ${task.status}: auto-start cannot be armed (launch it explicitly to run it again)`,
    );
  }
  await setTaskAutoStart(taskId, { model, prompt, armedFrom });
  await taskAutoStartArmed.emit({ taskId, armedFrom });
}
