import {
  setTaskAutoStart,
  taskAutoStartArmed,
} from "@plugins/tasks/plugins/auto-start/server";
import type { ModelChoice } from "@plugins/conversations/plugins/model-provider/core";

// Mark a task as queued for auto-launch, then wake the launcher.
//
// The wake-up is the `tasks.autoStartArmed` trigger event: the launcher (the
// conversations plugin's `maybeLaunchTaskJob`, through its static trigger)
// subscribes, as it does to `tasks.statusChanged`, so this plugin never names
// it — and a host with no launcher (an in-browser server) arms the task and
// wakes nothing.
//
// The wake-up is unconditional. `maybeLaunchTaskJob` already checks whether
// anything is blocking the task (along with dropped/held, the marker, the CAS
// and existing attempts), so a `hasBlockingDep` pre-check here would be a
// second copy of that gate — one that can only drift from the real one. A wake
// for a task that turns out to be blocked costs one indexed read and stops.
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
export async function armTaskAutoStart(args: {
  taskId: string;
  model: ModelChoice;
  prompt?: string;
  cause: string;
}): Promise<void> {
  const { taskId, model, prompt, cause } = args;
  await setTaskAutoStart(taskId, { model, prompt });
  await taskAutoStartArmed.emit({ taskId, cause });
}
