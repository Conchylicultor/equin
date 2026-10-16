# Workspace as a launch option — pick worktree or a scratch profile when filing a task

Mock: `proto-1789901373-oy29` (`placement=icons`).

## Context

Attempts can now run in two workspace kinds (`conversations/workspace`): a
**worktree** (git checkout + DB fork + build) or **scratch** (a plain dir shaped
by a scratch profile). But only code calling `createConversation({workspace})`
directly can pick scratch (Sonata transcription). A task launched from the UI —
the task-draft composer, launch-agent popover, welcome view, task detail —
always gets `DEFAULT_WORKSPACE`, and the user cannot even see which workspaces
exist.

Outcome: every registered workspace (the worktree + each scratch profile) is
listed and selectable wherever task launch options are, persisted on the task,
and honoured when its attempt is created. The composer bar, already crowded,
shows workspace / preprompt / dependency as **bare icons while on their
default**, and a labelled pill once set. The workspace menu is plain (one line
per choice); details appear in a **hover card** per row.

## Design

### 1. What a workspace says about itself (data, not code)

- `conversations/workspace/core/workspace.ts` — `WORKSPACE_KINDS[kind]` gains
  `label` and `description` (closed set, plain data both runtimes read).
- `ScratchProfileDef` gains a required **`label`** ("Hello", "Transcription");
  tsc forces both existing profiles to add it.
- `ScratchProfile.define(...).register()` records the owner via
  `registeringPlugin()` (`framework/server-core/core/boot-mode.ts`) — no
  hand-written owner field.
- **Launchable from a bare task** is derived, not declared:
  `inputSchema.safeParse({}).success`. `scratch.hello` → yes (its input has
  defaults); `sonata.transcription` → no (needs `songId` + `source`). Listed
  anyway (exhaustive), disabled with "Needs input — started from its own app".

### 2. Exposing the registry to the web

New server value in `conversations/workspace`: `workspace.catalog` — a
`liveValue` + `serveValue` (static after the register phase; follow
`network/live/CLAUDE.md` for a non-DB value, `preload: "boot-and-keep"` so the
menu never shows a stand-in) returning:

```ts
type WorkspaceChoice = {
  spec: WorkspaceSpec;            // {kind:"worktree"} | {kind:"scratch", profile, input:{}}
  kind: WorkspaceKind; label: string; description: string;
  capabilities: WorkspaceCapability[];
  profile?: { id: string; owner: string; mcpToolCount: number };
  unavailable?: string;           // why it can't be picked from a task
};
```

Built from `Workspace.all()` × `ScratchProfile.all()`; the web never names a
profile (collection-consumer separation).

### 3. The launch option — new plugin `conversations/workspace/plugins/launch-option`

Same three-part recipe as `tasks/auto-start/plugins/launch-option` and
`tasks/task-preprompt`:

- **core**: `defineLaunchOption<WorkspaceSpec | null>({ id: "workspace",
  schema: WorkspaceSpecSchema.nullable(), defaultValue: null })` — `null` = the
  default worktree.
- **server**: `defineExtension(_tasks, "workspace", …)` → `tasks_ext_workspace`
  (one `spec` json column, `parsedJson(WorkspaceSpecSchema)`).
  `TaskLaunchServer({ def, validate, apply })`:
  - `validate`: `Workspace.get(kind).parseSpec(spec)` (rejects an unknown
    profile or missing input) → `HttpError(400)`.
  - `apply`: upsert, or delete on `null`. No `inherit` (a follow-up of a
    scratch task is not implicitly scratch).
  - Export `getTaskWorkspace(taskId): Promise<WorkspaceSpec>` — no row =
    `DEFAULT_WORKSPACE` (never `null`).
- **web**: `TaskLaunch.Option` with `pill { icon, Value, MenuGroup, side:
  "start" }`, `useTaskBinding` (live row + PUT/DELETE endpoints, like
  preprompt; `disabledReason: "Fixed once the task has an attempt"` when one
  exists, like auto-start), `summarize`.
- `config/tasks/launch-options/option.jsonc`: insert `workspace` before
  `preprompt`.

### 4. Honouring it at launch

`conversations/server/internal/lifecycle.ts` `prepareConversation`, new-attempt
branch (l.~285): `parseWorkspaceSpec(opts.workspace ?? await
getTaskWorkspace(taskId))` — the same place the task's preprompt / effort are
read (l.305–325). So `launchTaskNow` (auto-start queue + Launch button) and
every launch surface pick it up with no change. An explicit `opts.workspace`
(Sonata) still wins.

### 5. UI primitives (generic, not workspace-specific)

In `primitives/text-editor/plugins/composer/plugins/picker-pill`:

- `PickerPill` prop **`unset?: "placeholder" | "icon"`** (default
  `placeholder`). `icon`: with no `Value`, the trigger is the bare icon
  (tooltip + aria-label already required).
- `PickerPill.Item` prop **`info?: ReactNode`** — a hover card beside the menu
  (`WithTooltip side="right"`), for rows that need explaining without crowding
  the menu.

Hosts thread it: `LaunchOptionPills` gets `unset`, `DependencyPill` gets
`unset`; `task-draft-composer.tsx` passes `unset="icon"`. The launch-agent
popover, welcome view and task detail keep labels (more room).

Workspace `MenuGroup`: group "Runs in" → Worktree; group "Scratch" → one row
per profile (folder icon, label, `disabled` + `note` when `unavailable`). Each
row's `info`: label + profile id, description, capability chips (missing ones
struck through), `owner · N MCP tools`.

## Files

- `plugins/conversations/plugins/workspace/core/workspace.ts` — kind label/description
- `plugins/conversations/plugins/workspace/server/internal/scratch-profile.ts` — `label`, owner capture
- `plugins/conversations/plugins/workspace/{core,server,web}` — `workspace.catalog` value + `useWorkspaceCatalog`
- `plugins/conversations/plugins/workspace/plugins/launch-option/` — new (core/server/web/shared)
- `plugins/conversations/server/internal/lifecycle.ts` — read the task's workspace
- `plugins/primitives/plugins/text-editor/plugins/composer/plugins/picker-pill/web/components/picker-pill.tsx` — `unset`, `info`
- `plugins/tasks/plugins/launch-options/web/components/launch-option-pills.tsx` — thread `unset`
- `plugins/tasks/plugins/task-draft-form/web/components/{task-draft-composer,dependency-pill}.tsx` — `unset="icon"`
- `plugins/debug/plugins/scratch-hello/server/internal/profile.ts`, `plugins/apps/plugins/sonata/plugins/transcription/server/internal/profile.ts` — add `label`
- `config/tasks/launch-options/option.jsonc` (+ origin) — order

## Out of scope (follow-up tasks)

- Preprompts that assume git (auto-push…) still apply to a scratch attempt;
  preprompts declaring `requires: WorkspaceCapability[]` so the menu disables
  them (as the mock showed) is a separate change to `conversations/preprompts`.
- Collecting a profile's input from the composer (transcription's source).

## Verification

- `./singularity test plugins/conversations/plugins/workspace` — catalog
  (owner, launchable derivation), option validate/apply, `getTaskWorkspace`
  default.
- Lifecycle test: a task with `tasks_ext_workspace = scratch.hello` →
  `prepareConversation` creates a scratch attempt; explicit `opts.workspace`
  still wins.
- `./singularity build`, then screenshot the composer exhibit
  (`exhibit:task-draft/composer`) default + menu open; `compare-diff.ts --name
  proto-1789901373-oy29 --options placement=icons`.
- Manual: file a task from Improve with Scratch · Hello → its attempt runs in
  `~/.singularity/state/workspaces/<att>` (`query_db` attempts.workspace);
  Transcription row disabled with its reason; hover shows the card.
