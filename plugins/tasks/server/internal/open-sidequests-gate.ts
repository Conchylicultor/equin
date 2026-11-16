/**
 * The open-sidequests exit gate: an agent may not close cleanly while a
 * sidequest it filed still waits with nobody else to own it. The sidequests
 * an agent files while it works would otherwise be left behind, unowned, the
 * moment it exits (the Follow ups role takes tasks only once the work is
 * pushed, so filing to it mid-work is not the answer).
 *
 * Blocking: a task whose owner is the caller's task AS ITS FILER
 * (`task-ownership.ts`), on the sidequest track, that has not run and is not
 * dropped (`BACKLOG_STATUSES`). So a supervisor and its workers are never
 * blocked — whatever they file is the supervisor tree's — and a sidequest
 * handed to a role is the role's. A main-track task is queued work, never a
 * leftover.
 */

import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { listSidequestTasks } from "@plugins/tasks/plugins/task-track/server";
import { BACKLOG_STATUSES } from "@plugins/tasks/plugins/supervisor-roles/core";
import { ExitClean } from "@plugins/conversations/plugins/conversation-view/plugins/push-and-exit/plugins/exit-precondition/server";
import { inSupervisorTree, taskOwnership } from "./task-ownership";
import {
  blockingSidequests,
  renderOpenSidequests,
  type SidequestCandidate,
} from "./open-sidequests";

/** The most open sidequests one refusal lists. */
const LISTED = 20;
/** The most filed sidequests one check reads: an agent outside any
 * supervisor's tree files a handful; the window leaves room for the ones it
 * handed off (filed by it, owned by a role) ahead of those it still owns. */
const READ = 200;

export const openSidequestsGate = ExitClean.Precondition({
  id: "tasks.open-sidequests",
  async check(conversationId) {
    const conversation = await getConversation(conversationId);
    if (conversation === null) return null;
    const callerTask = conversation.taskId;
    // A supervisor (or one of its workers) owns nothing as a filer.
    if (await inSupervisorTree(callerTask)) return null;
    // One bounded read; the ownership of each row decides (a handed-off task
    // is filed by this task yet a role's).
    const rows = await listSidequestTasks({
      statuses: BACKLOG_STATUSES,
      limit: READ,
      filedByTask: callerTask,
    });
    const blocking: SidequestCandidate[] = [];
    let more = false;
    for (const row of rows) {
      const [candidate] = blockingSidequests(
        [{ id: row.id, title: row.title, owner: await taskOwnership(row.id) }],
        callerTask,
      );
      if (candidate === undefined) continue;
      if (blocking.length === LISTED) {
        more = true;
        break;
      }
      blocking.push(candidate);
    }
    if (blocking.length === 0) return null;
    return { message: renderOpenSidequests(blocking, more) };
  },
});
