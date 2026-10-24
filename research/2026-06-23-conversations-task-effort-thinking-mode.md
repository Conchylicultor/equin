# Per-task "thinking mode" (effort) selector → Claude Code `--effort`

## Context

Claude Code exposes a per-session **effort** setting that controls how much reasoning
budget the agent gets (`low` → `max`), plus a special **`ultracode`** mode that pairs
`xhigh` effort with standing permission to auto-orchestrate dynamic multi-agent
workflows. Today Singularity launches every conversation at the CLI's default effort —
there is no way to dial a harder-thinking agent for a heavy task or a cheaper one for a
trivial task.

Goal: let the user pick a **thinking mode per task** (like the existing per-task
preprompt), persist it as a task-level setting, and have it applied to Claude Code when
a conversation is started under that task.

### Key constraint discovered (verified on installed CLI `2.1.186`)

- `claude --effort <level>` accepts **only** `low, medium, high, xhigh, max`.
  An unknown value is **ignored with a warning** (falls back to default).
- **`ultracode` is NOT a valid startup-flag value** — it only exists in the in-session
  `/effort` menu. Per Anthropic's docs the *per-task* opt-in for ultracode is **including
  the keyword `ultracode` in the prompt**, and ultracode ≡ `xhigh` effort + workflow
  orchestration.

So the two delivery paths are:

| Mode | Delivery at conversation start |
|------|--------------------------------|
| `low`/`medium`/`high`/`xhigh`/`max` | `--effort <level>` flag (exactly like `--model`) |
| `ultracode` | `--effort xhigh` flag **+** inject the keyword `ultracode` into the first user turn |

The keyword-injection path already exists for preprompts (`wrapPreprompt` → first user
turn in `lifecycle.ts`), so no new mechanism is needed.

Sources: [Anthropic Effort docs](https://platform.claude.com/docs/en/build-with-claude/effort),
[Claude Code dynamic workflows](https://code.claude.com/docs/en/workflows).

## Design

Mirror the two existing precedents that together already solve this exact shape:

- **`model-provider`** (`plugins/conversations/plugins/model-provider/`) — single-source
  registry mapping a logical id → CLI flag + display metadata, plus a reusable picker.
- **`task-preprompt`** (`plugins/tasks/plugins/task-preprompt/`) — per-task setting stored
  in a `tasks_ext_*` side-table, surfaced as a section in the task detail pane, read at
  launch in `lifecycle.ts`.

Two new plugins + small wiring edits:

```
plugins/conversations/plugins/effort-provider/   ← NEW (mirror of model-provider)
plugins/tasks/plugins/task-effort/               ← NEW (mirror of task-preprompt)
```

Why two plugins (not one): the **CLI-flag resolution** is consumed by `runtime-tmux`, a
conversation runtime that must not depend on the tasks domain — so it lives in a
conversations-level plugin (`effort-provider`), exactly as `resolveCliFlag` lives in
`model-provider`. The **per-task side-table + UI** lives in the tasks domain
(`task-effort`). This is the same split as model-provider ↔ tasks/auto-start.

### 1. `effort-provider` plugin (registry — mirror of model-provider/core)

`core/registry.ts` (single source of truth):

```ts
export const EffortLevelSchema = z.enum(["low","medium","high","xhigh","max","ultracode"]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

export type EffortMeta = {
  cliFlag: "low"|"medium"|"high"|"xhigh"|"max"; // value passed to --effort
  label: string;
  promptKeyword?: string;                        // injected into 1st turn (ultracode only)
};

export const EFFORT_REGISTRY: Record<EffortLevel, EffortMeta> = {
  low:       { cliFlag: "low",    label: "Low" },
  medium:    { cliFlag: "medium", label: "Medium" },
  high:      { cliFlag: "high",   label: "High" },
  xhigh:     { cliFlag: "xhigh",  label: "Extra high" },
  max:       { cliFlag: "max",    label: "Max" },
  ultracode: { cliFlag: "xhigh",  label: "Ultracode", promptKeyword: "ultracode" },
};

export const SELECTABLE_EFFORTS = Object.keys(EFFORT_REGISTRY) as EffortLevel[];
export function resolveEffortFlag(level: EffortLevel): string { return EFFORT_REGISTRY[level].cliFlag; }
export function effortPromptKeyword(level: EffortLevel): string | undefined { return EFFORT_REGISTRY[level].promptKeyword; }
```

- "No per-task effort" = **absence of a side-table row** (mirrors preprompt's `null`), so
  the enum has no `default` member; the picker offers a "Default" entry that clears the row.
- `resolveEffortFlag` + `effortPromptKeyword` are **pure registry lookups** → kept in
  `core` so `runtime-tmux` and `lifecycle` import from `effort-provider/core` (no server
  barrel needed). This is the one deliberate deviation from model-provider, which parks
  `resolveCliFlag` in `server`; the structural reason is there is no config dependency.
- `StoredEffortSchema = tolerantEnum(EffortLevelSchema, normalizeEffort, reportFn)` — the
  side-table value is surfaced via a live-state resource, so use the tolerant pattern
  (mirror `StoredModelSchema`) to keep a corrupt row from blanking the whole map.
  `normalizeEffort` falls back to `"high"` + a deduped `console.error` (lighter than
  model-provider's injectable crash-reporter; full pipeline not warranted yet).

`web/components/effort-select.tsx` — reusable `<EffortSelect value onChange>` built on
ui-kit `Select` (mirror `ModelSelect`), listing `SELECTABLE_EFFORTS` + a "Default" option
that emits `null`. `web/index.ts` barrel (plugin def with no contributions).

### 2. `task-effort` plugin (per-task setting — mirror of task-preprompt)

Files (1:1 with task-preprompt):

| File | Content |
|------|---------|
| `server/internal/tables.ts` | `export const tasksEffort = defineExtension(_tasks, "effort", { level: text("level").$type<EffortLevel>().notNull() })` → table `tasks_ext_effort`; `export const _tasksEffortExt = tasksEffort.table` (for drizzle-kit glob) |
| `server/internal/mutations.ts` | `getTaskEffort(taskId)`, `setTaskEffort(taskId, level\|null)` (upsert/delete), `inheritTaskEffort(from,to)` |
| `server/internal/resource.ts` | `defineResource({ key: "task-effort", mode: "push", loader })` → `Record<taskId,{taskId,level,updatedAt}>` |
| `server/internal/routes.ts` | `implement(putTaskEffort)`, `implement(deleteTaskEffort)` |
| `server/index.ts` | `Resource.Declare(taskEffortResource)` + `httpRoutes` |
| `shared/endpoints.ts` | `PUT /api/task-efforts/:taskId` (body `{ level: EffortLevelSchema }`), `DELETE /api/task-efforts/:taskId` |
| `shared/schemas.ts` / `shared/index.ts` | payload type + resourceDescriptor + barrel |
| `web/hooks.ts` | `useTaskEffort(taskId) → data[taskId]?.level ?? null` |
| `web/internal/api.ts` | `setTaskEffortRemote(taskId, level)` (PUT or DELETE) |
| `web/components/task-effort-section.tsx` | `Collapsible` + `<EffortSelect>` from `effort-provider/web` |
| `web/index.ts` | `TaskDetailSlots.Section({ id: "effort", label: "Thinking mode", component: TaskEffortSection })` |

### 3. Wiring (the only edits to existing files)

**`plugins/conversations/server/internal/runtime.ts`** — add `effort?: EffortLevel` to the
`ConversationRuntime.create` opts (import `EffortLevel` from `effort-provider/core`).

**`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`** (~line 661,
right after the `--model` block) — mirror the model flag:
```ts
const effortFlag = opts?.effort ? resolveEffortFlag(opts.effort) : undefined; // ultracode → "xhigh"
const claudeBase = [CLAUDE, cliFlag && `--model ${cliFlag}`, effortFlag && `--effort ${effortFlag}`]
  .filter(Boolean).join(" ");
```
Add `effort?: EffortLevel` to this `create` signature too; import `resolveEffortFlag` +
`EffortLevel` from `effort-provider/core`.

**`plugins/conversations/server/internal/lifecycle.ts`**:
- Add `effort?: EffortLevel` to `createConversation` opts.
- New shared helper `resolveTaskEffort(taskId) → (await getTaskEffort(taskId))?.level`.
- After the preprompt block (~line 189), resolve and apply effort:
  ```ts
  const effortLevel = opts.effort ?? (effectiveTaskId ? await resolveTaskEffort(effectiveTaskId) : undefined);
  const keyword = effortLevel ? effortPromptKeyword(effortLevel) : undefined; // ultracode only
  if (keyword && !resumeSessionId) {
    resolvedPrompt = resolvedPrompt ? `${resolvedPrompt}\n\n${keyword}` : keyword;
  }
  ```
  Pass `effort: effortLevel` into the `runtime.create(...)` call (line ~192).
- In `respawnResume(row)` (line ~253) re-apply for resume fidelity:
  `effort: await resolveTaskEffort(row.taskId)` (keyword stays out — already baked in the
  transcript, same `!resumeSessionId` guard rationale as preprompt). Note: this reads the
  **current** task setting on resume (live, not a per-conversation snapshot). This is the
  one semantic difference from `model` (snapshotted on the conversation row); chosen to
  avoid a schema change to the load-bearing `tasks-core` conversations table. Acceptable
  because the task setting represents current intent; flagged here as a conscious choice.

**`plugins/conversations/core/endpoints.ts`** — add `effort: EffortLevelSchema.optional()`
to `CreateConversationBodySchema` (ad-hoc per-launch override, mirrors `prepromptId`).

**`plugins/conversations/server/internal/handle-create.ts`** — pass `effort: body.effort`
into `createConversation(...)`.

### 4. Optional (parity, low cost)

- `inheritTaskEffort` wired where `inheritTaskPreprompt` is called (subtask spawn:
  `tasks/server/internal/handle-create-chain.ts`, `mcp-tools.ts`) so a child task inherits
  the parent's thinking mode. Include for parity unless you'd rather subtasks default.
- A `conversation-effort` header chip (mirror `conversation-preprompt`) — **out of scope**;
  note as a follow-up if you want the launched effort visible in the conversation header.

## Critical files

- `plugins/conversations/plugins/model-provider/core/registry.ts` — registry to mirror
- `plugins/tasks/plugins/task-preprompt/**` — plugin to mirror file-for-file
- `plugins/conversations/server/internal/lifecycle.ts` — launch chokepoint (read effort, inject keyword, thread to runtime, resume)
- `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts:661` — where the CLI argv is built
- `plugins/conversations/server/internal/runtime.ts:28` — `ConversationRuntime.create` opts
- `plugins/conversations/core/endpoints.ts:7` + `handle-create.ts` — create-conversation body

## Verification

1. `./equin build` (regenerates the `tasks_ext_effort` migration, runs codegen so
   both new plugins auto-register, builds + restarts). Confirm migration applied and no
   `plugins-registry-in-sync` / boundary / type-check failures.
2. UI: open a task at `http://<worktree>.localhost:9000`, find the new **Thinking mode**
   section in the task detail pane, pick `Max`. Then `query_db` the side-table:
   `SELECT * FROM tasks_ext_effort;` → one row `(task_id, level='max')`.
3. Launch a conversation under that task. Verify the spawned command carries the flag:
   `tmux list-panes -F '#{pane_start_command}'` (or read the conversation's tmux session)
   should show `claude --model … --effort max`.
4. Set the task to **Ultracode**, launch again. Verify: (a) command contains
   `--effort xhigh`, and (b) the first user turn in the JSONL transcript contains the
   `ultracode` keyword (visible in the conversation viewer / `…/transcript`).
5. Set **Default** (clears the row), launch → command has **no** `--effort` flag.
6. Resume a gone conversation whose task has an effort set → re-spawned command still
   carries `--effort <flag>`.
7. `./equin check` clean.

## Notes

- No polling, no manual registry/migration edits (all via `./equin build`).
- `ultracode` deliberately maps to `--effort xhigh` (the real reasoning tier) plus the
  documented keyword opt-in — it is *not* passed as a literal `--effort` value, which the
  CLI would reject.
