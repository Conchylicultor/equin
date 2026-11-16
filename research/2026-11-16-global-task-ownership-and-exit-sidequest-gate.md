# Task ownership for edit/drop, and the open-sidequest exit gate

## Context

Two gaps in how agents manage the tasks they file (user request, task
`task-1794742582-bw2k2c`):

1. **Edit / drop is scoped by tree, not by who owns the task.** `edit_task` /
   `drop_task` (`plugins/tasks/server/internal/manage-tools.ts`, policy in
   `manage-tasks.ts`) are gated on `tasks.manage`, which only a supervisor
   root holds. Within its tree it may touch anything. An interactive agent
   cannot fix or drop even a sidequest it just filed. The rule should be
   ownership: an agent may edit and drop the tasks it owns, and never another
   party's.
2. **Sidequests get abandoned at exit.** An agent files sidequests while it
   works, but the Follow ups role asks to be sent tasks only *after* the push.
   Nothing makes the agent go back to them, so `exit_clean` leaves open
   sidequests behind, unowned. At exit, each open sidequest the agent filed
   must be resolved first: **dropped** (is it really worth it?) or **handed to
   a supervisor** (possibly edited with new context first).

Decisions taken with the user:

- Hand-off moves the task to a **backlog root**, the same shape `add_task`
  with `supervisor` produces.
- **Supervisors are exempt** from the exit gate. Their workers never hit it,
  because the supervisor owns what they file.
- A filer that is not a supervisor may change **title, description and
  dependencies, drop the task, and hand it off**. Arming and changing the
  track stay supervisor-only.
- Only `exit_clean` is gated. `flag_raise` keeps the conversation open, so the
  user sees what is left.

## Design

### 1. One ownership rule: `ownerOfTask`

The owner of task T is decided in this order (first match wins):

1. **A supervisor role** owns it: a `tasks_ext_supervisor` row on T, or on the
   root of the tree T sits in. This is the existing `supervisorRoleReach`
   rule. The role's live session is the owner.
2. **A supervisor root** owns it: T's nearest mandate is a kind of
   `supervisor` (`mandateIsKindOf`) and T is not that root. The root's
   conversations are the owner. Its workers' filings land here, so they are
   the supervisor's.
3. **Its filer** owns it: `author_kind = agent` and the author conversation's
   task is the caller's task. Any conversation of the same task counts, so a
   resumed or restarted conversation keeps its filings.
4. Otherwise, **a person or the system** owns it (a human- or system-filed
   task). No agent may touch it.

The caller may edit or drop T only if the caller is T's owner. This replaces
`checkInTree`'s tree test. Rows 1 and 2 give exactly today's supervisor scope:
the root manages its tree, and a role session also reaches its backlog and
earlier sessions. A supervisor's own root task stays untouchable (the `root`
refusal is kept).

**Where it lives.** Row 1 is supervisor-roles knowledge, and `tasks/server`
must not name supervisor-roles. So ownership is a generic collection in
`tasks/orchestration/mandate`, beside `MandateReach`:

- Rename and widen `MandateReach` → `TaskOwnership`, contribution
  `{ id, ownerOf(taskId) → Owner | null }`, where
  `Owner = { kind: "conversation-task"; taskId; via: "filer" | "supervisor" | "role" } | { kind: "person" }`.
  Today's `reaches(conv, task)` becomes "caller's task === owner.taskId".
- supervisor-roles contributes row 1 (its reach logic, recast).
- mandate (or tasks) contributes rows 2 and 3, in a fixed order. Order is a
  property of the rule, not of the contributions. So the collection has a
  fixed precedence: role > supervisor tree > filer. The resolver runs role
  claims first, then the built-in rows. No numeric order on contributions.

`ownerOfTask(taskId)` is exported from `mandate/server`. `reachesBeyondTree`
and `MandateReach` are deleted, and their callers move to ownership. The only
other caller is `manage-tools.ts`; verify with `rg`.

### 2. `edit_task` / `drop_task`

- **Visibility:** `when: granted(tasksFile) || granted(tasksManage)`. Anyone
  who can file can manage what they filed. Check how `granted` composes;
  add an `anyGranted(...)` if it does not.
- **Scope:** `checkInTree` → `checkOwned`. The task edited or dropped must be
  owned by the caller. A dependency endpoint (`add_after` / `remove_after`) is
  either owned by the caller or is the caller's own task. That covers today's
  `remove_after: [<your task>]` case for filers too.
- **Powers by ownership path:**
  - Via supervisor or role (with `tasks.manage`): everything, as today. Arming
    still requires the task to be in the caller's own tree, never a role's
    backlog (unchanged).
  - Via filer: title, description, dependencies, drop, and the new
    `supervisor`. `start` and `track` are refused (`not-permitted`), with a
    message saying a supervisor or a person can launch it.
- **New refusal reason** `not-owner`, replacing `not-in-tree`. The message
  names the owner: "filed by a person", "owned by supervisor role Follow ups",
  "filed by another agent (task …)".
- **New `supervisor` input (hand-off)**, needs the `tasks.file` grant's
  `backlog`. It is applied in the same transaction as the other fields, so
  "edit with new context, then hand off" is one call:
  1. `resolveFilingRole(ref)`: a listed role only, as `add_task` does.
  2. `routeRefusal(taskId)`: a task that has run, a session root, or a task in
     a session tree cannot be handed off.
  3. Remove every dependency edge of the task, in both directions. A backlog
     root depends on nothing, and its dependents stop waiting on it.
  4. Re-file it to the root (`updateTask(id, { folderId: null })`, which
     goes through `prepareRefile`). Then state `interactiveMandate`
     (`setMandate`), as `insertBacklogTask` does.
  5. Disarm it (`setTaskAutoStart(id, null)`): a backlog task is never armed.
  6. `setTaskSupervisorRole(id, role, exec)`, keeping `filedFromTaskId` = the
     caller's task. This emits `backlogArrived` on the transaction.

  Steps 2–6 are a new exported `handOffToBacklog(taskId, roleRef, fromTaskId, exec)`
  in `supervisor-roles/server`, next to `fileToBacklog`, so both filing paths
  share `insertBacklogTask`'s invariants. It is reached through a port.
  `tasks/machine` already imports supervisor-roles/server. Before wiring the
  port in `tasks/server`, confirm the edge is allowed and creates no cycle.
  Otherwise move the edit/drop tools to `tasks/machine`, where `add_task`
  already is.
- After a hand-off the task is a role's, so the filer no longer owns it. A
  further edit is refused with `not-owner`, which is intended.
- Tool descriptions are rewritten around ownership and the exit flow: "before
  you exit, drop each open sidequest you filed or hand it to a supervisor".

### 3. The exit gate: `ExitClean.Precondition`

`push-and-exit` must not know about sidequests (collection-consumer
separation). It gets a generic server collection:

- `ExitClean.Precondition({ id, check(conversationId) → null | { message } })`
  in `push-and-exit/server`. `exit_clean`'s handler runs every check before it
  writes anything. If any check refuses, it returns an error result with every
  message and changes nothing: no `closeRequested`, no finalize job.
- The `exit_clean` description gains one line: it is refused while a
  precondition fails, and the refusal says what to do.

`tasks` contributes the **open-sidequests** precondition. It refuses when some
task T exists where:

- `ownerOfTask(T)` is `via: "filer"` and that task is the caller's. This
  exempts supervisors and their workers, because rows 1 and 2 win. A
  supervisor's own filings sit in its tree.
- T's track is `sidequest`.
- T's status is in `BACKLOG_STATUSES` (`new` / `blocked` / `held`): not run,
  not dropped, not done.

One SQL read joins `tasks` (author conversation) → `conversations` (task id) →
the track and status views, bounded by a limit (say 50, with "and N more").
The ownership exclusions are applied per candidate row through `ownerOfTask`.
There are few candidates, and this runs once per exit.

The refusal message lists each one as `id — title`, followed by:

> "Before closing, resolve each sidequest you filed: drop it with `drop_task`
> if it is not worth doing (ask yourself what it actually gains), or hand it
> to a supervisor with `edit_task { supervisor: "<role id>" }`, adding any
> context you learned since filing it. Then call `exit_clean` again."

A main-track `after` task is real queued work and never blocks.

## Critical files

- `plugins/tasks/plugins/orchestration/plugins/mandate/server/internal/contribution.ts`:
  `MandateReach` → `TaskOwnership`, plus `ownerOfTask`.
- `plugins/tasks/plugins/supervisor-roles/server/internal/reach.ts`:
  contribute the role ownership claim.
- `plugins/tasks/plugins/supervisor-roles/server/internal/roles.ts`:
  `handOffToBacklog`.
- `plugins/tasks/server/internal/manage-tasks.ts` (policy, ports, refusals)
  and `manage-tasks.test.ts` (new cases).
- `plugins/tasks/server/internal/manage-tools.ts`: visibility, the
  `supervisor` input, descriptions, ports.
- `plugins/tasks/plugins/tasks-core/core/internal/tasks-manage.ts`: the
  capability's doc and label ("arm, disarm and retrack the tasks it owns").
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/mcp-tools.ts`:
  run the preconditions. A new `exit-precondition.ts` holds the slot.
- `plugins/tasks/server/internal/open-sidequests-gate.ts` (new): the
  precondition contribution and its query.
- Docs: `supervisor-roles/CLAUDE.md` (Mandate/reach paragraph → ownership),
  `mandate-presets/CLAUDE.md` (`tasks.manage` wording), and the tool-call
  renderers in `orchestration-tools/web` if they show the refusal reason.

## Verification

- `./equin test plugins/tasks/server` covers `manage-tasks.test.ts`, extended
  over the in-memory ports. A filer edits and drops its own sidequest. It is
  refused on a human-filed sibling, on another agent's filing, on `start` and
  `track`, and on a task already handed off. A supervisor keeps its tree. A
  role session keeps its backlog. A hand-off clears the dependencies and the
  task leaves the filer's ownership.
- Unit test for the gate's pure decision: candidate rows plus owners in, a
  refusal or null out. Cases: open sidequest, a dropped one, a main-track one,
  a supervisor worker, and a sidequest already handed off.
- `./equin check` (boundaries, cycles, docs in sync), then `./equin build`.
- End to end on the worktree build. From an interactive conversation of this
  worktree's instance, file a sidequest, call `exit_clean` and see the
  refusal, then `edit_task { supervisor }` and `exit_clean` succeeds. Inspect
  the state with `query_db` (`tasks_ext_supervisor`, `folder_id`,
  dependencies).

## Implementation notes (where it departed from the plan)

- **Ownership claim, not a widened reach.** `MandateReach` became
  `TaskOwnerClaim` (`claim(taskId) → { label, owns(conversationId) } | null`,
  two claims for one task throw). The precedence role > supervisor tree >
  filer > person lives in `tasks/server/internal/task-ownership.ts`, which
  knows the supervisor preset (the orchestration umbrella never names presets).
- **Hand-off refuses a task other tasks run after** instead of cutting their
  edges: cutting them would edit tasks the caller does not own, keeping them
  would leave them waiting on a backlog. Its own dependencies are removed.
  The disarm runs in the same transaction (`disarmTaskAutoStart`): with its
  dependencies gone, an armed task would launch at once.
- **The precondition slot is a leaf** (`push-and-exit/plugins/exit-precondition`),
  not in `push-and-exit/server`: the browser demo composition excludes
  push-and-exit, and `tasks` (one of its entries) would have pulled it back in.
  The demo keeps the leaf, as it keeps `push-and-exit.capabilities`.
- **The gate skips a caller in a supervisor's tree outright**, and reads up to
  200 filed sidequests (listing 20), so handed-off ones cannot crowd out the
  ones still owned.
