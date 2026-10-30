# Named mandates — a task points at a shared mandate, resolved live

## Context

A mandate (`tasks/orchestration/mandate`) states what agents may do in a task
subtree. Today a root task stores the **expanded grants** (`tasks.mandate`
jsonb, built by `interactiveMandate()` / `supervisorMandate()` / an
automation's `mandate(settings)` at creation), and `mandate-presets/CLAUDE.md`
records it as deliberate: "a later change to a preset never rewrites a task's
existing powers".

The user wants the opposite: **one mandate shared by everything that runs
under it**. Adding a capability to the supervisor mandate (e.g. `message.tree`,
2026-10-30) must reach every supervisor tree already running — today both
supervisor runs on main lack it and nothing can grant it. And the mandate
becomes a fact you can **filter and group by** in every task / conversation
list ("show me the supervisor trees", "hide automation work").

Main today (3,898 rows with a mandate): 3,886 interactive (one policy), 1
supervisor in the current scoped shape, 1 supervisor in the older unscoped
shape, 9 `deps-upgrades` automation tasks.

## Design

### 1. A mandate is a registered, named definition

- **Core** (`mandate/plugins/policy/core`): `defineMandate({ id, label })` →
  a frozen `MandateRef` (branded id). The only spelling of a ref, so a write
  site can never invent an id.
- **Server** (`mandate/server`): `Mandate.Definition({ ref, policy: () =>
  MandatePolicy })` — the contribution that says what a ref grants, computed
  **at each resolution** (so it is always the current code and, for an
  automation, its current settings). A ref contributed twice throws at boot; a
  stored ref nobody contributes **throws at resolution** (loud, never "no
  powers").
- **Who defines what** (names stay out of `orchestration/`):
  - `tasks/mandate-presets`: `interactiveMandate` and `supervisorMandate` refs
    (core) + their definitions (a new `server/` barrel). The policy functions
    stay as they are; they become the definitions' bodies.
  - `tasks/automations`: one ref per automation, `automation:<id>`, minted by
    `defineAutomation` from the spec (label = the automation's label); its
    definition is `() => spec.mandate(automationSettings(spec))`. Changing
    an automation's Push setting now applies to every tree it started.
- The `mandate.capabilities` debug value gets a sibling, `mandate.definitions`
  (id, label, the policy as it resolves now): the Debug catalog shows what
  each mandate grants today, and the list field (§3) reads its options from it.

### 2. Storage: the task stores the ref

- `tasks.mandate` (jsonb policy) → `tasks.mandate_ref` (text, nullable). The
  `tasks_root_has_mandate` CHECK moves to it. Nearest-wins is unchanged: a
  nested ref (a launch-kind automation's, on a person's task) overrides.
- tasks-core: `CreateTaskInput.mandate: MandateRef`, `setMandate(taskId,
  ref)`, `nearestMandate` returns `{ rootTaskId, ref }`; re-filing to root
  copies the ref. tasks-core never resolves a ref — it cannot see the registry.
- `mandate/server` resolves: `mandateOf` / `conversationMandate` →
  `{ rootTaskId, ref, policy: definition(ref).policy(), at }`. `grantOf`,
  `granted`, the `## Mandate` instructions, tree-digest, watch, message read
  `policy` exactly as today — no change past `resolve.ts`.
- Write sites (~25: every `interactiveMandate()` call becomes the
  `interactiveMandate` ref; `supervisor-run` sets `supervisorMandate`;
  automations pass their ref). Representative:
  `plugins/tasks/server/internal/placement.ts`,
  `plugins/conversations/machine/internal/handle-create.ts`,
  `plugins/tasks/plugins/supervisor-run/server/index.ts`,
  `plugins/tasks/plugins/automations/server/internal/{define,origin}.ts`.
  tsc finds every one when the input type changes.

### 3. The effective mandate as a list field

`mandate_ref` lives only on roots (and overrides), so a child's mandate is
not on its own row. For filtering, every task gets its **effective** ref,
materialized:

- `tasks_ext_mandate` (extension of tasks, owned by tasks-core): one row per
  task, `ref` = the nearest `mandate_ref` up its folder chain.
- Kept exact **inside the same transaction** as every write that can move it —
  all in tasks-core: `createTask` (inherit the folder's, or its own),
  `setMandate` / `clearMandate` and a folder change (`updateTask`,
  `handle-move`): recompute the moved / re-stated subtree (one recursive CTE).
  Plus a startup warm-up that re-derives all of it (3.9k rows, one statement)
  as the backstop.
- **Exposed** (`exposes: { parent: tasksEntityRef, name: "mandate" }`) as the
  `mandate` field — "Mandate: Interactive / Supervisor / Automation: …" — in
  every list whose rows reach a task (task list, Queue, History,
  All-conversations), filterable and groupable server-side like `track`.
  Presented (`FieldPresentation.Register`) with options read live from
  `mandate.definitions`. Ownership of the presentation follows the boundary
  check (tasks-core web if it may read the definitions value; otherwise the
  mandate plugin's web half).

### 4. Migration (one push)

1. Schema: add `mandate_ref text`, add `tasks_ext_mandate`.
2. Data (idempotent, guarded `UPDATE … WHERE mandate_ref IS NULL`):
   - has a `tasks_ext_origin` row → `automation:<automation_id>`;
   - grants `watch.tree` (top level or under `@root`) → `supervisor`;
   - any other non-null mandate → `interactive`.
   Then fill `tasks_ext_mandate` for every task.
3. Contract: move the CHECK to `mandate_ref`, drop `mandate`.

On main both supervisor runs become `supervisor` and get `message.tree` at
once (their running conversations see the tools after their next MCP
reconnect — a resume or hibernation wake; out of scope here).

### 5. Docs

- `mandate-presets/CLAUDE.md`: the rule flips — a task names its mandate; a
  change to a definition reaches every tree under it, running ones included.
- `mandate/CLAUDE.md`: storage = ref; the Definition registry; resolution;
  the exposed field.
- The original plan (`research/2026-10-28-tasks-mandate-building-block.md`)
  gets a pointer here.

## Verification

- Unit: `defineMandate` / registry (duplicate throws, unknown ref throws),
  `resolve.ts` with a fake registry.
- DB tests (`worktreeDbScenario`, tasks-core `queries/mandate.test.ts`
  extended): root CHECK on `mandate_ref`; nearest-wins on refs; effective
  `tasks_ext_mandate` after create / setMandate / clearMandate / re-file /
  move of a subtree; the warm-up reconcile is a no-op on a consistent DB.
- Migration: `./equin build` applies it on the worktree fork of main; then
  `query_db`: every task has a `tasks_ext_mandate` row, ref counts =
  3,886 interactive / 2 supervisor / 9 `automation:deps-upgrades`, no
  `mandate` column.
- Live: the root of a supervisor tree resolves `message.tree` (a new
  conversation in the worktree lists `list_agents`); the Queue / task list
  filter `Mandate is Supervisor` shows only supervisor trees (browser_*).
- `./equin test` on mandate, tasks-core, automations, watch, message;
  `./equin check`.
