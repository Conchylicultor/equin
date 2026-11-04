# Auto-start decided by task status; splices skip settled dependents

## Context

On 2026-11-04 a "Drop dependents" (12:23 UTC) followed by a main restart (13:08)
launched five agents on tasks that had pushed and completed in June
(conv-1793797700-{jpfihw,wvq1qd,ue2dg5,yx1whh,fp6hzr}, `spawned_by:
boot-reconcile`). Three defects composed:

1. **The launch gate never asks the task's status.** `maybeLaunchTaskJob`
   (`plugins/conversations/server/internal/auto-start-jobs.ts`) re-derives
   launchability from raw columns — `droppedAt` / `heldAt`, `hasBlockingDep`, a
   *retained* attempt (since 5275735c5c a closed attempt no longer counts). No
   clause means "done", so a done task with a marker launches again.
2. **Markers outlive their purpose.** A marker is consumed only by the queue's
   claim. A task armed while blocked and then started by hand (or finished
   any other way) keeps it forever. The only cleanup is on `dropped`
   (`cancel-on-drop.ts`, `dropped-sweep.ts`).
3. **A follow-up splice rewires finished dependents.** `rewireOn`
   (`plugins/tasks/server/internal/rewire-dependencies.ts`) moves every
   non-sidequest dependent of the target onto the new task — including ones
   already done. In June `kdb0nx` (done 01:33) was rewired at 03:35 to wait on
   the freshly filed `ljudok`; `ozjvo5` likewise on `0kqzzp`. Those phantom
   blockers kept the stale markers dormant until the drop removed them.

Outcome wanted: what auto-start does with a task is ONE exhaustive decision per
`TaskStatus`, chosen explicitly for each value (tsc rejects a new status with no
decision), read by every gate and every cleanup — so done, dropped and running
tasks can never be auto-launched. And a splice never gives a settled task a new
prerequisite.

## Design

### 1. `AUTO_START_DECISIONS` — the table (auto-start core)

New `plugins/tasks/plugins/auto-start/core/internal/decision.ts`:

```ts
export type AutoStartDecision = "launch" | "wait" | "disarm";

export const AUTO_START_DECISIONS = {
  new: "launch",
  attempted: "launch",            // past runs closed without landing; an arm asks for another
  blocked: "wait",                // launches when its prerequisites settle
  held: "wait",                   // "not now", not "never": launches on unhold
  in_progress: "disarm",          // an agent is running: the arm is spent
  need_action: "disarm",
  in_progress_blocked: "disarm",
  done: "disarm",                 // landed: never again by itself
  dropped: "disarm",              // abandoned
} as const satisfies Record<TaskStatus, AutoStartDecision>;

export function autoStartDecision(status: TaskStatus): AutoStartDecision;
export function statusesDeciding(d: AutoStartDecision): TaskStatus[];
```

`satisfies Record<TaskStatus, …>` is the enforcement (rung 2): a status added to
`TaskStatusSchema` fails to compile until someone decides it. Exported from the
auto-start core barrel.

`blocked` is a derived arm (`taskDerived` puts it above `attempted` / `new`), so
"no blocking prerequisite" is read off the status — the separate
`hasBlockingDep` calls in the gates go away.

The one fact the status cannot carry stays as its own guard: a *dormant*
attempt (retained — a gone, resumable conversation) still reads `attempted`, so
`launchArmedTask`'s retained-attempt skip remains.

### 2. Readers of the table

- **`launchArmedTask` (queue mode, `ifAlreadyStarted: "skip"`)** — on the
  launch transaction, BEFORE the claim: read the task's status
  (`readTaskStatuses`, newly exported from the tasks-core server barrel) →
  `wait` ⇒ return false, marker kept; `disarm` ⇒ claim (delete) the marker,
  return false; `launch` ⇒ claim + retained-attempt skip + commit as today.
  Being on the tx closes the window between the job's read and the claim.
  Explicit user launches (`"launch"`) bypass it — a person asking for another
  run of a done task is allowed (unchanged).
- **`maybeLaunchTaskJob`** — replaces its `droppedAt || heldAt` and
  `hasBlockingDep` checks with `autoStartDecision(t.status)`: `wait` ⇒ return,
  `disarm` ⇒ `claimAutoStart` + log, `launch` ⇒ continue (Claude ready, model
  resolves, `launchTaskNow`). The early read keeps a doomed task from preparing a
  conversation or filing a model-unavailable report.
- **Marker cleanup on status change** — `cancel-on-drop.ts` becomes
  `disarm-on-status.ts` (`tasks.auto-start-disarm-on-status`): on every
  `taskStatusChanged`, delete the marker when the new status decides `disarm`.
  This is what consumes the marker of a hand-started armed task.
- **Boot sweep** — `dropped-sweep.ts` becomes `disarm-sweep.ts`: delete markers
  whose task status ∈ `statusesDeciding("disarm")` (one `tasks_v` read at boot).
  Clears today's backlog (on main: 1 `in_progress_blocked` marker; 45 `blocked`
  stay).
- **`listLaunchableArmedIn`** (watch queries) — armed ids whose status decides
  `launch`, read in one `tasks_v` query on `exec`; its own held/dropped +
  `hasBlockingDep` copy of the gate is deleted.
- **Arming** — `armTaskAutoStart` (`plugins/tasks/server/internal/arm-auto-start.ts`)
  refuses (HttpError 409, naming the status) to arm a task whose status decides
  `disarm`, so no caller can park a marker the launcher would only delete. The
  explicit launch path (`handleLaunchTask`) writes its marker through the
  launch-option apply with `start: "now"` (not `armTaskAutoStart`) and claims
  it at once, so it is unaffected.

### 3. Splice skips settled dependents

`DependencyGraph` gains `unsettled(ids): Promise<string[]>`; `rewireOn`'s
followup branch filters the ids it moves through it — the default
(`spliceableDependentsOf`) AND an explicit `selectiveInsertBefore` (a done task
cannot be inserted before either). Production binds it to
`readTaskStatuses(ids, tx)` + `isSettled` (tasks-core core). A settled dependent
keeps its edge on the target, where it is already satisfied.

Out of scope (noted): the `prerequisite` branch on a settled target, and
`deps-tree-move`. Existing phantom edges on main are left — harmless once (1)
lands.

## Files

- `plugins/tasks/plugins/auto-start/core/internal/decision.ts` (new), `core/index.ts`
- `plugins/tasks/plugins/auto-start/server/internal/{cancel-on-drop → disarm-on-status, dropped-sweep → disarm-sweep, mutations}.ts`, `server/index.ts`
- `plugins/tasks/plugins/tasks-core/server/index.ts` (export `readTaskStatuses`)
- `plugins/conversations/server/internal/auto-start-jobs.ts`
- `plugins/tasks/server/internal/arm-auto-start.ts`
- `plugins/tasks/server/internal/rewire-dependencies.ts`, `plugins/tasks/machine/internal/add-task-filing.test.ts` (in-memory graph gains `unsettled`)

## Verification

- `plugins/conversations/server/internal/auto-start-launch.test.ts` (real DB):
  queue launch of an armed **done** task ⇒ false, marker deleted, no attempt;
  **dropped** ⇒ same; **blocked** ⇒ false, marker kept; explicit launch of a done
  task still starts.
- `add-task-filing.test.ts`: a follow-up of T whose dependent D is done leaves
  `D→T`; an unsettled dependent is still rewired.
- `./equin check`, `./equin test plugins/tasks plugins/conversations/server`,
  `./equin build`.
