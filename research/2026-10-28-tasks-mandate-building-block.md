# Mandate building block (Autonomous tasks, step 1)

Track: wiki page `block-28d79bb7-…` · Design: `block-9fe10dae-…` §1, §2, §5, §8 · Mental model: `block-72c25b90-…`.

## Context

Today nothing states what an agent may do inside a task subtree. The rules are hard-coded and scattered:
- `add_task` always arms main-track tasks.
- `assertTrackAllows` forbids sidequest autostart and prerequisite sidequests.
- `exit_clean` / `flag_raise` are visible to every conversation.
- `outcome-report` is gated on `automationOfTask`.
- The push policy exists only as prompt text.

This step adds the **Mandate**: a policy on a task that covers its subtree, resolved nearest-wins. The harness grants MCP tools and instructions from it. The step also covers:
- explicit mandates on every root task, with a backfill
- the missing host-wide launch cap on auto-start
- `add_task` start modes (now / after / manual) per the grant
- the tree digest
- a draft of the Debug → Mandates prototype

## Deviations from the agreed design (flagged for review)

1. **Storage: a column on `tasks`, not a `tasks_ext_mandate` side table.**
   - What: `tasks.mandate jsonb NULL`, plus a DB `CHECK (folder_id IS NOT NULL OR mandate IS NOT NULL)`.
   - Why: "Every root task carries a mandate" then becomes **inexpressible to violate** (rung 1–2):
     - `CreateTaskInput` becomes a union: `{ folderId: string } | { folderId?: null; mandate: MandatePolicy }`. tsc forces each of the ~15 root-creation sites to state a policy.
     - The CHECK catches anything else.
   - A side table owned by a plugin above tasks-core cannot be written from `createTask` without an import cycle.
   - The policy *type* and registry live in `tasks/orchestration/mandate/core`, which imports nothing from tasks. tasks-core imports only that type and schema.
2. **`flag_raise` gets its own capability, `flag.raise`.** The design bundled it into `exit.push-and-exit`, which an autonomous mandate does not grant. That would remove the mental model's only human channel. `exit.clean` grants `exit_clean` alone.
3. **Re-filing a task to root derives its mandate.** `updateTask({ folderId: null })` copies the task's effective (nearest-ancestor) policy onto it, so the task keeps the powers it had. This is the "derive the value" rung, not a new required param.

### Deviations found at implementation (plugin-level import cycles)

The R6 cycle check works per PLUGIN (core edges count in every runtime graph), so three placements moved to leaves:

4. **The policy types are a leaf, `mandate/plugins/policy/core`.** `tasks-core` stores a policy and `mandate/server` reads `tasks-core`; one plugin holding both closed `tasks-core → mandate → tasks-core`. `mandate/core` keeps only the `mandate.capabilities` catalog value.
5. **`tasks.file` is declared in `tasks-core/core`, not `tasks/core`.** The conversations plugin is a root creator (a new conversation files a root task) and `tasks/server` imports `conversations/server`, so a preset naming `tasks/core` would cycle. Its keys are the tracks spelled literally (`tasks-core` cannot import `task-track`); `tasks`' describe pins them equal at compile time. The describe and the `add_task` gate stay in `tasks/machine`.
6. **`push.policy` / `exit.clean` / `flag.raise` (and `PUSH_POLICIES`, labels, `PUSH_POLICY_TEXT`) live in a leaf, `push-and-exit/plugins/capabilities/core`**, for the same reason (push-and-exit imports `conversations/server`). The describes and the `exit_clean` / `flag_raise` gates stay in push-and-exit's server.
7. **No re-export of `setMandate` / `clearMandate` from `mandate/server`** (cross-plugin re-exports are banned): callers import them from `tasks-core/server`.
8. **No mandates live collection yet.** `mandate` is a server-only column (off the wire, off `tasks_v`), and a collection cannot project one. Step 6 decides between a projection of the policy and a wire field.

## Plugin layout

```
plugins/tasks/plugins/orchestration/              # umbrella, workflow-agnostic (CLAUDE.md: the "names no workflow/track" rule)
  plugins/mandate/
    core/      defineCapability, MandatePolicy (branded), mandatePolicy([...grants]), MandatePolicySchema
    server/    Mandate.Capability contribution, mandateOf, grantOf, granted(cap), mandateInstructions,
               mandates live collection + capability catalog live value (for Debug)
  plugins/tree-digest/
    server/    treeDigest({conversationId}), digest_cursors table
plugins/tasks/plugins/mandate-presets/core        # named compositions (interactive, automation…) — NOT under orchestration
```

### mandate/core

```ts
defineCapability<T>({ id, schema: ZodParser<T>, label }) → Capability<T> { id, grant(value: T): Grant }
mandatePolicy(grants: Grant[]): MandatePolicy   // branded; duplicate id throws. The only way to build one,
                                                 // so a stored value is type-correct by construction.
MandatePolicySchema                               // Record<string, unknown> → MandatePolicy (column decoder)
```

Model this on `defineLaunchOption` (`tasks/plugins/launch-options/core/internal/define.ts`).

### mandate/server

- `Mandate.Capability({ cap, describe(value) => string })` uses `defineServerContribution`, modelled on `TaskLaunchServer`. The mandate plugin names no capability.
- `mandateOf(taskId)` returns `{ rootTaskId, policy } | { kind: "none" }`.
  - It is a recursive CTE up `tasks.folder_id`, taking the first non-null `mandate`.
  - The query lives in tasks-core (`nearestMandate`) because `updateTask` needs it too. It is re-exported for use, not re-implemented.
- `grantOf(cap, conversationId)` resolves conversation → task → `mandateOf`, then parses `policy[cap.id]` with the cap's schema. An invalid stored value throws loudly.
  - Concurrent calls collapse per conversation via `createInflight()` (`packages/inflight`), because every tool's `when` runs on each MCP request.
- `granted(cap)` returns a `(ctx) => Promise<boolean>`, to use as `Mcp.tool.when`.
- `mandateInstructions = Mcp.instructions({ id: "mandate" })` renders `## Mandate` followed by `describe(value)` for each granted capability. It names none of them.
- `mandateOf` returning `none` means nothing is granted. With the CHECK in place this happens only for a conversation without a task.

### Capabilities (contributed by their owners)

| id | owner (core def + server describe) | value | grants |
|---|---|---|---|
| `tasks.file` | `tasks` | `{ main?: { start: Start[]; model?: ModelChoice }, sidequest?: {…} }` | `add_task` (+ `task_tree`, digest instructions) |
| `push.policy` | `push-and-exit` (`PUSH_POLICIES` + `PUSH_POLICY_TEXT` move here from `automations/core`; automations imports them) | `"never" \| "safe" \| "checks"` | instructions only |
| `exit.clean` | `push-and-exit` | `true` | `exit_clean` |
| `flag.raise` | `push-and-exit` | `true` | `flag_raise` |

`report.required` (outcome-report) is step 2 and is left untouched here. `outcome-report` stays on `automationOfTask` for now.

### mandate-presets/core

`interactiveMandate()`: `tasks.file { main: { start: ["after"] }, sidequest: { start: ["manual"] } }`, `push.policy: "never"`, `exit.clean`, `flag.raise`. This is exactly today's behaviour.

The row always stores the expanded grants, never a preset name.

## Every root creator passes a mandate

tsc drives the list once `CreateTaskInput` is a union. The conversation path changes too: `prepareConversation`/`createConversation` target becomes `{ taskId } | { mandate }`.

| Sites | Mandate |
|---|---|
| `handle-create.ts` (root), `handle-create-chain.ts`, `handle-insert-between.ts`, `handle-launch-task.ts` (Home, LaunchAgentPopover), `conversations/machine/handle-create.ts`, `agents/handle-launch.ts`, page prompt / todo task-link, `hints/ask` tool, plugin-health tool, sonata transcription, demo seed | `interactiveMandate()` |
| `task-triage/dispatch.ts` | interactive (its scratch profile allowlists `exit_clean` / `flag_raise`, and `when` still applies) |
| Automations: new **required** spec field `mandate: (settings) => MandatePolicy`. `runFiling` passes it to `fileAutomationTask` (root). `runLaunch` writes it as a *nested* mandate on each launched task (`setMandate`, nearest wins). | each of the 4 automations states its own: autopilot `tasks.file {sidequest: manual}` + push + flag; reports-investigation / upstream / deps: push + flag. None grants `exit.clean`, which matches their prompts' "never call exit_clean". |

`setMandate(taskId, policy, tx?)` / `clearMandate` live in tasks-core next to the column and are re-exported by `mandate/server`. They are callable from code only; there is no MCP tool.

**Backfill**: `./equin build --custom-migration --migration-name backfill_root_mandates`.
- `UPDATE tasks SET mandate = '<interactive json>' WHERE folder_id IS NULL AND mandate IS NULL`, idempotent.
- The JSON is a frozen copy, which is the intended semantics.
- At implementation, verify that the generated migration orders `ADD COLUMN`, then the backfill, then `ADD CONSTRAINT` (phased expand/backfill/contract per entity-extensions CLAUDE.md). If it does not, split the CHECK into its own migration file.

## Host-wide launch cap

- Config `agent-launch` in `conversations/core`: `maxConcurrent: intField({ default: 6, min: 1 })`. Register it on the server and the web.
- `maybeLaunchTaskJob` / `launchArmedTask` (`conversations/server/internal/auto-start-jobs.ts`):
  - Inside the launch tx, take `pg_advisory_xact_lock(<const>)`, count conversations in `starting|working`, and bail while the count is ≥ cap. The task stays armed.
  - Over the cap, record nothing loud. It is a normal wait, visible in the Debug page later.
- New `Trigger({ on: conversationStatusChanged, do: launchNextArmedJob })`:
  - When a conversation leaves `starting|working`, enqueue `maybeLaunchTaskJob` for the oldest armed tasks (`listArmedTaskIds` ordered by `autoStartAt`, limited to the free slots).
  - This is push-based, not polling.
- The cap applies only to auto-start. User-initiated launches (`launchTaskNow` from the UI) are not capped, because a human asked.

## `add_task` (owner `tasks`, `machine/internal/add-task-filing.ts` + `mcp-tools.ts`)

- `when: granted(tasksFile)`. `liveDescription` lists the tracks and start modes the caller's grant allows.
- Params:
  - `title`, `description`, `track`
  - **`start: "now" | "after" | "manual"`**, required
  - `after?: string[]`: replaces `target`. It defaults to the caller's task, and is used with `after` and `manual`.
  - `relation` (followup / prerequisite): kept for a single `after`
  - `model?`: replaces `autostart`. It defaults to the grant's `model`, else `DEFAULT_MODEL_CHOICE`.
- `assertTrackAllows` is deleted. A track or start mode missing from the grant is refused, and the error lists what the grant allows.
- Semantics:
  - `now`: filed under the caller's task, no dependency, armed.
  - `after`: dependencies are wired, then armed. A main track with a single `after` splices via `rewire` as today; a sidequest never splices. Several `after`s mean plain `addTaskDependency` edges (a join).
  - `manual`: dependencies are wired the same way, never armed.
  - Track is stored as today (`setTaskTrack` for sidequest).
- The result appends `digest` (below).
- Update `add-task-filing.test.ts` (ports gain `grant`) and the root CLAUDE.md `add_task` notes if they mention `autostart` / `target`.

## Tree digest (`orchestration/tree-digest`)

- `digest_cursors (conversationId, rootTaskId, seenAt)`.
- `treeDigest({ conversationId })`:
  - The root is `mandateOf(task).rootTaskId`.
  - With no cursor it returns the whole subtree (recursive CTE on `folder_id`), one line each: id, title, status, track, armed/manual.
  - Otherwise it returns only tasks with `created_at` or `updated_at` after `seenAt`.
  - It is capped at 40 lines, then "+K more — call `task_tree`".
  - The cursor advances.
  - It returns `{ text, full }`.
- `tasks` uses it in three places:
  - appended to every `add_task` result
  - a read-only `task_tree` tool (`when: granted(tasksFile)`, full tree, no cursor)
  - `Mcp.instructions({ id: "tree-digest" })` gated on the same grant, so the tree is seen before the first filing
- tree-digest imports tasks-core and mandate only, never `@plugins/tasks/*` itself. There is no cycle.
- The report first-sentence column waits for step 2, when Report is generalized.

## Debug → Mandates prototype (draft for review)

- `./equin prototype new "Debug → Mandates"`, with `<meta name="mocks" content="app:/debug/mandates">`.
- Use the blank template; React inline is optional.
- Four screens per Design §8:
  - Mandates DataView-like list
  - Mandate detail: capabilities with their describe text, the instructions agents receive, the subtree with effective mandate per task, the launch-cap state
  - Capabilities
  - "Why can't this agent do X"
- Watches appear as a placeholder section, since they arrive in step 2.
- Match the Debug app's look: flat sidebar, ~600px list pane, Miller detail.
- Embed it in the track page with `<prototype id="proto-…"/>`.

## Track page

When done, update the agent card:
- Status, and the Mandate checkboxes.
- The deviations above.
- File the next main task (Watcher + Report), with the page id + Track Instructions pointer.

## Verification

- `./equin test plugins/tasks/plugins/orchestration plugins/tasks` covers:
  - `mandateOf` nearest-wins, including a nested mandate
  - `grantOf` invalid value throws
  - `add_task` start modes and grant refusals (in-memory ports)
  - digest cursor (full, then delta)
  - launch cap counting
- `./equin build` (runs migrations + checks: boundaries, `data-migration-dml-only`, `migration-applies-clean`).
- `query_db` on the worktree DB:
  - every `folder_id IS NULL` row has a non-null `mandate`
  - an insert-shaped violation is impossible (CHECK listed in `pg_constraint`)
- Debug → MCP tools on my build: `exit_clean` / `add_task` still listed for an interactive conversation.
- Prototype: `./equin run …/e2e/screenshot.ts --path /api/prototypes/<id>/index.html` at 1280 and a narrow width.
