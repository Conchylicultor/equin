import { db } from "@plugins/database/server";
import type { EmitTx } from "@plugins/infra/plugins/events/server";
import { listDependentClosure, readTaskStatuses } from "./queries/tasks";
import { computeStatusEmits } from "./status-emit";
import {
  statusBatchOn,
  type DbExecutor,
  type StatusBatch,
} from "./status-batch";
import { taskStatusChanged } from "./tables-events";
import type { TaskStatus } from "./schema";
import type { TaskStatusRow } from "./queries/tasks";

// THE chokepoint for a write that can change a task's derived status. The write
// happens INSIDE the recorder, so there is no "afterwards" to forget, no
// ordering to get wrong, and no `previous` parameter to supply stalely — the
// primitive reads it. And the affected set is DERIVED from the graph rather than
// named by the caller, which is the defect this replaces: an edge write can only
// ever name its own endpoint, never the downstream tasks whose derived status it
// just changed. (Design:
// research/2026-08-18-global-task-launch-woken-by-db-change-v2.md.)
//
// ─── The closure rule ────────────────────────────────────────────────────────
//
// For a write recorded against `T`, the tasks whose status can change are
// exactly `{T} ∪ transitiveDependents(T)`. Read the `tasks_v` status CASE
// (views.ts): a task's status is a function of its own dropped_at/held_at, its
// own attempts/conversations/pushes, and `task_blocking_v.has_blocking_dep` —
// which is a function of its transitive ANCESTORS' settledness, never of their
// blocked-ness. Influence flows downstream only, and the graph is acyclic
// (`taskDependsOn` bars cycles on insert), so the walk never re-enters.
//
// ─── Why an edge write is safe to BRACKET (the closure is read once) ─────────
//
// Writing the edge `A → B` does not change `dependents(A)`, so the closure is
// identical before and after the write and may be read either side of it. The
// dependents walk from `A` traverses an edge only if that edge's `depends_on`
// endpoint is already visited; this edge's `depends_on` endpoint is `B`; `B = A`
// is rejected by the self-check, and `B ∈ dependents(A)` would be a cycle —
// rejected on insert, and impossible for a REMOVAL in an already-acyclic
// graph. ∎
//
// ─── Why the entry status is recorded BEFORE the write, not at flush ─────────
//
// Flush-time expansion of the closure would be set-correct but status-INCORRECT:
// a task first entering the closure at flush has no recoverable batch-entry
// status, and `previousStatus` is load-bearing (the queue's rerank consumer keys
// on the blocked↔unblocked transition). Record-time is correct by induction: `T`
// is inserted into `batch.before` by the FIRST write whose closure contains it,
// and every earlier write had `T` outside its closure and so — by the closure
// rule above — could not have changed `T`'s status. So `T`'s recorded status IS
// its status at batch entry, and earliest-wins on the map is what makes that the
// reading that lands. ∎

export async function withTaskStatusChange<T>(
  seedIds: string | readonly string[],
  exec: DbExecutor,
  write: () => Promise<T>,
): Promise<T> {
  const seeds = typeof seedIds === "string" ? [seedIds] : seedIds;
  // The batch is found on the write's own executor. What that gave up: the
  // batch used to be ambient (an AsyncLocalStorage), so a write inside an open
  // batch but on ANOTHER executor — a captured tx used outside its batch, or a
  // mutation handed the pool while a batch is open — failed loudly here (rung 4:
  // its commit lands on a connection the flush cannot read, so its emit would be
  // computed against statuses that do not include it). Keyed by executor, such a
  // write simply finds no batch and takes the inline path, emitting for itself.
  // The ambient half of that assertion comes back with the portable
  // AsyncContext primitive (research/2026-10-18-global-portable-server-machine-split.md §1e);
  // until then the `exec` threading the required parameter forces is the guard.
  const batch = statusBatchOn(exec);
  if (batch) {
    await recordEntryStatuses(seeds, batch);
    // Emit suppressed: `flushStatusBatch` emits the NET before→after per task
    // once, on the batch's tx, when the batch's callback returns.
    return write();
  }

  // No batch: same shape inline — read before, write, read after, emit the
  // differences. Deliberately NOT wrapped in a transaction, so the eleven
  // single-write mutations that reach this path do not suddenly start opening
  // one; a single write needs no coalescing.
  const closure = await listDependentClosure(seeds, exec);
  const before = entryStatuses(closure, await readTaskStatuses(closure, exec));
  const result = await write();
  const after = await readTaskStatuses(closure, exec);
  for (const payload of computeStatusEmits(before, after)) {
    await taskStatusChanged.emit(
      payload,
      // On a transaction handle, emit on the same connection so the trigger
      // SELECT + emission audit + job INSERT commit atomically with the write.
      // `exec` is a PgTransaction there (structurally an EmitTx /
      // NodePgDatabase); the narrow cast reconciles the PgTransaction ⇄ EmitTx
      // nominal mismatch that eventsDispatchJob.enqueue accepts at runtime.
      exec === db ? undefined : { tx: exec as EmitTx },
    );
  }
  return result;
}

// Record each closure member's entry status, EARLIEST WINS: only ids the batch
// has not seen are read, so a second write touching the same task keeps the
// first write's (= batch-entry) reading. Reading only the missing ids is also
// what makes a batch of edge writes cheap — the closure is downward-closed, so
// after the first record later records usually find nothing new and skip the
// expensive read entirely.
async function recordEntryStatuses(
  seeds: readonly string[],
  batch: StatusBatch,
): Promise<void> {
  const closure = await listDependentClosure(seeds, batch.tx);
  const missing = closure.filter((id) => !batch.before.has(id));
  if (missing.length === 0) return;
  const rows = await readTaskStatuses(missing, batch.tx);
  for (const id of missing) batch.before.set(id, rows.get(id)?.status ?? null);
}

// A closure member with no row reads `null` — "no status at scope entry", the
// same reading a not-yet-created task gets, which is what lets `createTask`
// bracket its own INSERT.
function entryStatuses(
  ids: readonly string[],
  rows: ReadonlyMap<string, TaskStatusRow>,
): Map<string, TaskStatus | null> {
  return new Map(ids.map((id) => [id, rows.get(id)?.status ?? null]));
}
