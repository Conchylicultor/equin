import { createTask, getTask } from "@plugins/tasks/plugins/tasks-core/server";
import { setTaskCategory } from "@plugins/tasks/plugins/task-category/server";
import {
  findSubjectTask,
  setTaskSubject,
  withSubjectLock,
} from "@plugins/tasks/plugins/task-subject/server";
import { resolveLaunchOptions } from "@plugins/tasks/plugins/launch-options/server";
import { launchTaskNow } from "@plugins/conversations/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { assertClaudeCodeReady } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { launchTask } from "../../core/endpoints";

// File a task with its launch options, and start it now — the operation the
// auto-start queue performs, invoked inline instead of from a job. So a launch
// always has its task up front, carrying the options it was launched with
// (preprompt, thinking mode, model), instead of an implicit "Untitled" task
// minted afterwards with none.
//
// Why the options are applied with `start: "now"`: auto-start's apply would
// otherwise ARM the task, which enqueues `tasks.maybe-launch` — and that job,
// running in this process's own worker, would race the claim below for the same
// marker. The claim is exactly-once, so if the job won we would have launched a
// conversation and have none to return. With `now`, the apply only records the
// model on the marker, and the claim below is the only runner.
//
// Two transactions, deliberately: the task and its options commit before the
// launch claims. A crash in between leaves a filed task still carrying its
// marker, so on main the boot reconcile finishes the launch the user asked for;
// with auto-start Off there is no marker and it stays a filed, unstarted task —
// a normal, visible state.
export const handleLaunchTask = implement(launchTask, async ({ body }) => {
  // Before any task exists, so an unknown id or a bad value leaves nothing
  // half-filed behind.
  const resolved = resolveLaunchOptions(body.options, "launch");
  // Likewise a machine that cannot run the agent: refused before the task is
  // filed, or its marker would launch it by itself the moment Claude Code
  // became ready — long after the user was told it failed.
  await assertClaudeCodeReady();

  let taskId: string;
  if ("id" in body.task) {
    // Fail loudly on a dangling id: otherwise it reads as unarmed below and
    // answers `started: false` for a task that does not exist.
    const existing = await getTask(body.task.id);
    if (!existing) throw new HttpError(400, `task ${body.task.id} not found`);
    taskId = existing.id;
  } else {
    const { title, categoryId, subject } = body.task;
    const file = async (): Promise<string> => {
      const task = await createTask({
        title,
        titleAuto: true,
        description: body.prompt,
        author: "user",
      });
      await setTaskCategory(task.id, categoryId);
      return task.id;
    };
    // About a subject: its live task is THE task — a second Investigate on
    // the same failed run starts a fresh attempt under it rather than filing a
    // duplicate. Held under the subject's lock, so two launches at once file
    // one task.
    taskId = subject
      ? await withSubjectLock(subject, async () => {
          const existing = await findSubjectTask(subject);
          if (existing) return existing;
          const id = await file();
          await setTaskSubject(id, subject);
          return id;
        })
      : await file();
  }

  for (const { entry, value } of resolved) {
    await entry.apply({ taskId, cause: "user-launch", start: "now" }, value);
  }

  // `prepareConversation` reads the preprompt and thinking mode off the rows
  // the applies just wrote, so they need no threading here. `user-launch` is
  // also what lets `conversations.notify-created` announce the launch.
  // `launch`: the user is asking for a run, even of a task that already has
  // one — a second "Fix this crash" reuses the report's live task, and must
  // start a fresh attempt under it rather than being refused as "already
  // started".
  const result = await launchTaskNow(taskId, {
    prompt: body.prompt,
    cause: "user-launch",
    ifAlreadyStarted: "launch",
  });
  return result.started
    ? { started: true as const, conversation: result.conversation }
    : { started: false as const, taskId };
});
