import {
  attemptTasksServed,
  taskDescriptionsServed,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  serveCollection,
  serveValue,
} from "@plugins/network/plugins/live/server";
import { splitUiContext } from "@plugins/primitives/plugins/ui-context/core";
import { attemptSourceUrl, taskSourceUrls } from "../../core";
import { tasksSourceUrl } from "./tables";

// Each task's stored source url, by task id.
export const taskSourceUrlsServed = serveCollection(taskSourceUrls, {
  from: tasksSourceUrl,
});

// The attempt's task, then that task's stored url and its description (the
// fallback's `<ui-context>`), each followed by the task id the attempt names
// (`follow.from`): a url stored or a description edited for this task
// recomputes the attempts of it, and another task's reach none.
export const attemptSourceUrlServed = serveValue(attemptSourceUrl, {
  source: "db",
  follows: (follow) => {
    const attempt = follow(attemptTasksServed, ({ attemptId }) => ({
      ids: [attemptId],
    }));
    const taskOf = (rows: readonly { taskId: string }[]) =>
      rows[0] === undefined ? null : { ids: [rows[0].taskId] };
    return {
      attempt,
      stored: follow.from({ attempt }, taskSourceUrlsServed, (_p, r) =>
        taskOf(r.attempt),
      ),
      task: follow.from({ attempt }, taskDescriptionsServed, (_p, r) =>
        taskOf(r.attempt),
      ),
    };
  },
  loader: (_params, { followed }) => ({
    url:
      followed.stored[0]?.url ??
      uiContextUrl(followed.task[0]?.description ?? null),
  }),
});

/**
 * The page the first `<ui-context>` in a task's prompt was picked on. A task
 * filed with no page URL but with a picked element (the Improve element
 * picker, or an agent quoting one into `add_task`) was still filed about that
 * page, so "Open app" lands there rather than on `/`.
 */
function uiContextUrl(description: string | null): string | null {
  if (!description) return null;
  for (const segment of splitUiContext(description)) {
    if (segment.kind === "tag") return segment.meta.url;
  }
  return null;
}
