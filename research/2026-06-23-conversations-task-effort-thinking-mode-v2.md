# Per-task "thinking mode" (effort) selector → Claude Code — v2

> Supersedes v1. **Change vs v1:** `ultracode` is delivered via the official
> `--settings '{"ultracode": true}'` startup key instead of the prompt-keyword
> injection hack. This removes all `lifecycle.ts` prompt mutation — both effort
> channels become plain CLI args appended in `runtime-tmux`.

## Context

Claude Code has a per-session **effort** setting (`low`→`max`) plus a special
**`ultracode`** mode (= `xhigh` reasoning **+** auto-orchestration of dynamic multi-agent
workflows). Singularity currently launches every conversation at the CLI default — no way
to dial effort per task. Goal: pick a **thinking mode per task** (like the existing
per-task preprompt) and apply it when a conversation starts under that task.

### Verified delivery mechanisms (installed CLI `2.1.186`)

| Mode | Delivery at conversation start | Verified |
|------|--------------------------------|----------|
| `low`/`medium`/`high`/`xhigh`/`max` | `--effort <level>` flag | ✅ accepted; unknown value warns + ignored |
| `ultracode` | `--settings '{"ultracode": true}'` | ✅ accepted cleanly (no warning) |

- `ultracode` is **NOT** a valid `--effort` flag value (warns + falls back to default) and
  is **NOT** part of the `effortLevel` settings key — it is its own session-scoped
  settings key that sends `xhigh` to the model and enables Dynamic Workflows.
- We keep the `--effort` flag for the 5 real levels (it supports `max`, which the
  persistent `effortLevel` settings key does not), and use `--settings` only for ultracode.

Sources: [BSWEN effort levels](https://docs.bswen.com/blog/2026-03-13-claude-code-effort-settings/),
[claudefa.st ultracode](https://claudefa.st/blog/guide/development/ultracode),
[Anthropic Effort docs](https://platform.claude.com/docs/en/build-with-claude/effort).

## Design

Mirror two existing precedents that already solve this shape:

- **`model-provider`** (`plugins/conversations/plugins/model-provider/`) — single-source
  registry (logical id → CLI delivery + display meta) + reusable picker.
- **`task-preprompt`** (`plugins/tasks/plugins/task-preprompt/`) — per-task setting in a
  `tasks_ext_*` side-table, surfaced as a task-detail section, read at launch in
  `lifecycle.ts`.

Two new plugins + thin wiring:

```
plugins/conversations/plugins/effort-provider/   ← NEW (mirror of model-provider)
plugins/tasks/plugins/task-effort/               ← NEW (mirror of task-preprompt)
```

Why two: CLI-arg resolution is consumed by `runtime-tmux` (a conversation runtime that
must not depend on the tasks domain) → lives in a conversations-level plugin, exactly as
`resolveCliFlag` lives in `model-provider`. The per-task side-table + UI lives in the tasks
domain (`task-effort`). Same split as model-provider ↔ tasks/auto-start.

### 1. `effort-provider` (registry — mirror of model-provider/core)

`core/registry.ts` — single source of truth, encodes the **delivery channel** per level:

```ts
export const EffortLevelSchema = z.enum(["low","medium","high","xhigh","max","ultracode"]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

export type EffortMeta = {
  label: string;
  effortFlag?: "low"|"medium"|"high"|"xhigh"|"max"; // → `--effort <flag>`
  settings?: Record<string, unknown>;               // → `--settings '<json>'`
};

export const EFFORT_REGISTRY: Record<EffortLevel, EffortMeta> = {
  low:       { label: "Low",        effortFlag: "low" },
  medium:    { label: "Medium",     effortFlag: "medium" },
  high:      { label: "High",       effortFlag: "high" },
  xhigh:     { label: "Extra high", effortFlag: "xhigh" },
  max:       { label: "Max",        effortFlag: "max" },
  ultracode: { label: "Ultracode",  settings: { ultracode: true } },
};

export const SELECTABLE_EFFORTS = Object.keys(EFFORT_REGISTRY) as EffortLevel[];
export function resolveEffortFlag(l: EffortLevel)     { return EFFORT_REGISTRY[l].effortFlag; }   // string | undefined
export function resolveEffortSettings(l: EffortLevel) { return EFFORT_REGISTRY[l].settings; }     // object | undefined
```

- "No per-task effort" = **absence of a side-table row** (mirrors preprompt's `null`); the
  enum has no `default` member. The picker offers a "Default" entry that clears the row.
- `resolveEffortFlag` / `resolveEffortSettings` are pure registry lookups → kept in `core`
  so `runtime-tmux` imports from `effort-provider/core` (no server barrel needed). Returns
  the **data**; shell-quoting of the `--settings` JSON happens in `runtime-tmux` (the only
  place that knows it's building a shell command). Deliberate, minor deviation from
  model-provider (which parks `resolveCliFlag` in `server`); reason: no config dependency
  and we want the shell concern isolated to the runtime.
- `StoredEffortSchema = tolerantEnum(EffortLevelSchema, normalizeEffort, report)` — the
  side-table value is surfaced via a live-state resource, so use the tolerant pattern
  (mirror `StoredModelSchema`) so a corrupt row can't blank the whole map. `normalizeEffort`
  falls back to `"high"` + a deduped `console.error` (lighter than model-provider's
  injectable crash-reporter — full pipeline not warranted yet).

`web/components/effort-select.tsx` — reusable `<EffortSelect value onChange>` on ui-kit
`Select` (mirror `ModelSelect`): `SELECTABLE_EFFORTS` + a "Default" option emitting `null`.
`web/index.ts` barrel (plugin def, no contributions).

### 2. `task-effort` (per-task setting — file-for-file mirror of task-preprompt)

| File | Content |
|------|---------|
| `server/internal/tables.ts` | `export const tasksEffort = defineExtension(_tasks, "effort", { level: text("level").$type<EffortLevel>().notNull() })` → table `tasks_ext_effort`; `export const _tasksEffortExt = tasksEffort.table` (drizzle-kit glob) |
| `server/internal/mutations.ts` | `getTaskEffort`, `setTaskEffort(taskId, level\|null)`, `inheritTaskEffort(from,to)` |
| `server/internal/resource.ts` | `defineResource({ key:"task-effort", mode:"push", loader })` → `Record<taskId,{taskId,level,updatedAt}>` |
| `server/internal/routes.ts` | `implement(putTaskEffort)`, `implement(deleteTaskEffort)` |
| `server/index.ts` | `Resource.Declare(taskEffortResource)` + `httpRoutes` |
| `shared/endpoints.ts` | `PUT /api/task-efforts/:taskId` (`{ level: EffortLevelSchema }`), `DELETE /api/task-efforts/:taskId` |
| `shared/schemas.ts`,`shared/index.ts` | payload type + resourceDescriptor + barrel |
| `web/hooks.ts` | `useTaskEffort(taskId) → data[taskId]?.level ?? null` |
| `web/internal/api.ts` | `setTaskEffortRemote(taskId, level)` (PUT or DELETE) |
| `web/components/task-effort-section.tsx` | `Collapsible` + `<EffortSelect>` from `effort-provider/web` |
| `web/index.ts` | `TaskDetailSlots.Section({ id:"effort", label:"Thinking mode", component: TaskEffortSection })` |

### 3. Wiring (edits to existing files — smaller than v1, no prompt mutation)

**`plugins/conversations/server/internal/runtime.ts`** (`ConversationRuntime.create` opts,
line ~31) — add `effort?: EffortLevel` (import from `effort-provider/core`).

**`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`** (~line 661,
after the `--model` block; add `effort?: EffortLevel` to this `create` signature too):
```ts
const cliFlag = opts?.model ? resolveCliFlag(opts.model) : undefined;
const effortFlag = opts?.effort ? resolveEffortFlag(opts.effort) : undefined;       // "low".."max" | undefined
const effortSettings = opts?.effort ? resolveEffortSettings(opts.effort) : undefined; // {ultracode:true} | undefined
const claudeBase = [
  CLAUDE,
  cliFlag && `--model ${cliFlag}`,
  effortFlag && `--effort ${effortFlag}`,
  effortSettings && `--settings '${JSON.stringify(effortSettings)}'`, // single-quoted; JSON has no single quotes
].filter(Boolean).join(" ");
const cmdParts: string[] = [claudeBase];
```
Import `resolveEffortFlag`, `resolveEffortSettings`, `EffortLevel` from `effort-provider/core`.

**`plugins/conversations/server/internal/lifecycle.ts`**:
- Add `effort?: EffortLevel` to `createConversation` opts.
- Helper `resolveTaskEffort(taskId) → (await getTaskEffort(taskId))?.level`.
- In `createConversation`, before the `runtime.create(...)` call (~line 192):
  `const effortLevel = opts.effort ?? (effectiveTaskId ? await resolveTaskEffort(effectiveTaskId) : undefined);`
  then pass `effort: effortLevel` into `runtime.create`. **No prompt mutation** (v1's
  keyword block is gone).
- In `respawnResume(row)` (~line 253): pass `effort: await resolveTaskEffort(row.taskId)`
  so resumed sessions keep the mode. Reads the **current** task setting on resume (live,
  not a per-conversation snapshot) — the one semantic difference from `model` (snapshotted
  on the conversation row), chosen to avoid a schema change to load-bearing `tasks-core`.

**`plugins/conversations/core/endpoints.ts`** — add `effort: EffortLevelSchema.optional()`
to `CreateConversationBodySchema` (per-launch override, mirrors `prepromptId`).

**`plugins/conversations/server/internal/handle-create.ts`** — thread `effort: body.effort`
into `createConversation(...)`.

### 4. Optional (parity, low cost)

- `inheritTaskEffort` wired where `inheritTaskPreprompt` is (subtask spawn:
  `tasks/server/internal/handle-create-chain.ts`, `mcp-tools.ts`) so a child task inherits
  the parent's mode. Include for parity unless subtasks should default.
- A `conversation-effort` header chip (mirror `conversation-preprompt`) — out of scope;
  follow-up if you want the launched mode visible in the conversation header.

## Critical files

- `plugins/conversations/plugins/model-provider/core/registry.ts` — registry to mirror
- `plugins/tasks/plugins/task-preprompt/**` — plugin to mirror file-for-file
- `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts:661` — CLI argv
- `plugins/conversations/server/internal/runtime.ts:28` — `ConversationRuntime.create` opts
- `plugins/conversations/server/internal/lifecycle.ts` — launch + resume chokepoint
- `plugins/conversations/core/endpoints.ts:7` + `handle-create.ts` — create body

## Verification

1. `./equin build` — regenerates the `tasks_ext_effort` migration, runs codegen
   (both new plugins auto-register), rebuilds/restarts. Confirm no migration / registry /
   boundary / type-check failures.
2. UI at `http://<worktree>.localhost:9000`: task detail pane shows a **Thinking mode**
   section; pick `Max`. `query_db`: `SELECT * FROM tasks_ext_effort;` → `(task_id, 'max')`.
3. Launch a conversation under that task → spawned command shows
   `claude --model … --effort max` (inspect via `tmux list-panes -F '#{pane_start_command}'`).
4. Set **Ultracode**, launch → command shows `claude … --settings '{"ultracode":true}'`
   (and **no** `--effort`). Confirm no "unknown" warnings in the pane.
5. Set **Default** (clears row), launch → command has neither `--effort` nor `--settings`
   for effort.
6. Resume a gone conversation whose task has a mode set → re-spawned command still carries
   the right flag/settings.
7. `./equin check` clean.

## Notes

- No polling; no manual registry/migration edits (all via `./equin build`).
- `ultracode` uses the official `--settings '{"ultracode": true}'` key — not a literal
  `--effort` value (rejected) and not a prompt hack (v1).
