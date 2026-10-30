import type { EmitTx } from "@plugins/infra/plugins/events/server";
import type { TaskStatus } from "./schema";
import type { ConversationStatus } from "../../core";
import {
  taskStatusChanged,
  conversationStatusChanged,
  type ConversationStatusChangedPayload,
  type TaskStatusChangedPayload,
} from "./tables-events";
import { readTaskStatuses, type TaskStatusRow } from "./queries/tasks";
import type { StatusBatch } from "./status-batch";

// Status is computed from the `tasks_v` view (see views.ts). There is no stored
// status column to compare against, so a status change is only observable as a
// before→after pair around a write. `withTaskStatusChange` (status-scope.ts)
// takes both readings and derives the affected set; this file owns the last two
// steps: the pure before→after diff, and the batch flush that applies it once
// per transaction.

// One `tasks.statusChanged` payload per task whose derived status actually
// moved. Pure — the two maps are read by the caller — which is what makes the
// emission rule testable with no DB.
//
// Two conventions, both older than this function and preserved exactly:
//   - a task absent from `after` is GONE (deleted inside the scope) and emits
//     nothing; there is no transition to report;
//   - a first-time read (`before === null`: the task did not exist, or was not
//     readable, at scope entry) reports `previousStatus = status` rather than
//     lying about a transition. Subscribers that care compare the two fields.
export function computeStatusEmits(
  before: ReadonlyMap<string, TaskStatus | null>,
  after: ReadonlyMap<string, TaskStatusRow>,
): TaskStatusChangedPayload[] {
  const emits: TaskStatusChangedPayload[] = [];
  for (const [taskId, previous] of before) {
    const row = after.get(taskId);
    if (!row) continue;
    if (previous === row.status) continue;
    emits.push({
      taskId,
      folderId: row.folderId,
      status: row.status,
      previousStatus: previous ?? row.status,
    });
  }
  return emits;
}

// Emit the NET tasks.statusChanged per recorded task at batch commit: read every
// recorded task's current status in ONE query on the tx (so it sees all the
// batch's uncommitted writes), diff it against the entry statuses, and emit each
// difference on the tx so the trigger SELECT, the emission audit and the job
// INSERT commit atomically with the writes.
export async function flushStatusBatch(batch: StatusBatch): Promise<void> {
  const after = await readTaskStatuses([...batch.before.keys()], batch.tx);
  for (const payload of computeStatusEmits(batch.before, after)) {
    await taskStatusChanged.emit(
      payload,
      // `batch.tx` is a PgTransaction here (structurally an EmitTx /
      // NodePgDatabase); the narrow cast reconciles the PgTransaction ⇄ EmitTx
      // nominal mismatch that eventsDispatchJob.enqueue accepts at runtime.
      { tx: batch.tx as EmitTx },
    );
  }
}

/** A conversation's status as `conversation.statusChanged` reports it: the
 * `status` column and what a waiting agent waits on. */
export interface ConversationStatusState {
  status: ConversationStatus;
  waitingFor: string | null;
}

// The `conversation.statusChanged` payload for a conversation's status —
// its `status` column or its `waitingFor` — moving from `previous` to `next`,
// or null when neither moved. Pure, so the emission rule is testable with no
// DB. A first insert (`previous` null) reports previous = current, matching
// the task-status convention above.
export function conversationStatusChange(
  conversationId: string,
  taskId: string | null,
  previous: ConversationStatusState | null,
  next: ConversationStatusState,
): ConversationStatusChangedPayload | null {
  if (
    previous !== null &&
    previous.status === next.status &&
    previous.waitingFor === next.waitingFor
  )
    return null;
  return {
    conversationId,
    taskId,
    status: next.status,
    previousStatus: previous?.status ?? next.status,
    waitingFor: next.waitingFor,
    previousWaitingFor:
      previous === null ? next.waitingFor : previous.waitingFor,
  };
}

// Emit `conversation.statusChanged` when a single conversation's status
// actually changes (`conversationStatusChange`). Callers snapshot the prior
// state before the write and pass it here after the write commits.
//
// Deliberately NOT part of the task-status scope: this is a fact about one
// conversation row's own stored columns, not about a derived value with a
// dependency closure, so there is nothing to walk and nothing to coalesce.
export async function emitConversationStatusChange(
  conversationId: string,
  taskId: string | null,
  previous: ConversationStatusState | null,
  next: ConversationStatusState,
): Promise<void> {
  const payload = conversationStatusChange(
    conversationId,
    taskId,
    previous,
    next,
  );
  if (payload !== null) await conversationStatusChanged.emit(payload);
}
