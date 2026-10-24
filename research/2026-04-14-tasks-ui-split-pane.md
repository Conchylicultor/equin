# Tasks UI — Part 2: List + View split pane

## Context

Part 1 landed the `tasks` meta-plugin with a nested schema and an empty pane
mounted at `/tasks` (commit 5f53442). The pane currently exposes a single
`Tasks.PanePanel` slot that stacks sub-plugin panels vertically, which is fine
as a scaffold but doesn't match the real shape of the feature.

The actual UX is a two-area pane:

1. **Nested task list** — always visible on the left.
2. **Task view** — opens on the right when a task is selected, rendering the
   detail of that task (description, attempts, etc.).

Clicking a task should change the URL to `/tasks/:id`, so the selection is
shareable/refresh-safe and participates in normal browser history. Sub-plugins
(e.g. "attempts", "description editor") will later contribute into either
slot; the tasks plugin itself owns layout and selection.

## Design

### Slots

Replace `Tasks.PanePanel` with two slots in `plugins/tasks/web/slots.ts`:

```ts
// Renders the nested task list. Contributions receive no props; they read
// selection / tasks from their own hooks / the URL.
Tasks.List = defineSlot<{ component: ComponentType }>();

// Renders detail view for the currently-selected task. Contributions are
// stacked; each receives the selected task id.
Tasks.View = defineSlot<{
  id: string;                            // contribution id, for React keys
  title?: string;                        // optional section header
  component: ComponentType<{ taskId: string }>;
}>();
```

One sub-plugin will contribute the actual nested-list widget to `Tasks.List`
(out of scope here; for this change the tasks plugin ships an empty-state
message as it does today when no list contribution is registered). Detail
plugins like `description`, `attempts` can later contribute into `Tasks.View`.

### Command

Per the user's choice (two-slots-plus-command), expose a single navigation
command so list contributions don't depend directly on the router:

```ts
// plugins/tasks/web/commands.ts
export const Tasks = {
  OpenTask: defineCommand<{ id: string | null }, void>("tasks.open-task"),
};
```

The tasks pane registers the handler and calls `navigate("/tasks/:id")`
(or `/tasks` when `id === null`). Selection state is **derived from the URL**,
not stored in React state — this keeps refresh / deep-linking free and avoids
dual sources of truth.

### Route

In `plugins/tasks/web/index.ts`, change the single `/tasks` route to cover
both `/tasks` and `/tasks/:id`. Use one route with an optional param
(`/tasks/:id?`) if the router supports it, otherwise two routes both
resolving to the same `tasksPane()` factory. The pane component reads the
`id` param from the route.

### Layout

`TasksPanel` becomes a resizable left/right split:

- Install the shadcn `resizable` primitive (react-resizable-panels wrapper):
  `bunx shadcn@latest add resizable` — adds
  `web/src/components/ui/resizable.tsx`.
- Use `ResizablePanelGroup direction="horizontal"` with two
  `ResizablePanel`s and a `ResizableHandle`.
- Default split: left 55% / right 45%. Width is not persisted in this pass
  (can come later; noted as follow-up).
- When no task is selected (`id` undefined), render the right panel with a
  muted placeholder (`"Select a task"`). Keeping it always-mounted is simpler
  than toggling and matches the resizable layout better; the user had no
  strong preference.
- Left panel: renders `Tasks.List.useContributions()`; shows today's
  `"No tasks yet."` placeholder when empty.
- Right panel: renders `Tasks.View.useContributions()` stacked as sections
  (same card style as the current `PanePanel`), passing `taskId` as a prop.

### Files to modify / add

- `plugins/tasks/web/slots.ts` — replace `PanePanel` with `List` + `View`.
- `plugins/tasks/web/commands.ts` — **new**; define `Tasks.OpenTask`.
- `plugins/tasks/web/components/tasks-panel.tsx` — rewrite as resizable split;
  read `id` from route; register `OpenTask` handler → navigate.
- `plugins/tasks/web/components/task-view.tsx` — **new**; renders the
  `Tasks.View` contributions for a given `taskId`, or the empty placeholder.
- `plugins/tasks/web/components/task-list.tsx` — **new** (thin); renders
  `Tasks.List` contributions or the empty placeholder.
- `plugins/tasks/web/index.ts` — add the `/tasks/:id` route alongside
  `/tasks`; export `Tasks` command + updated slot names.
- `plugins/tasks/web/views.tsx` — `tasksPane()` factory accepts the optional
  selected `id` and forwards to `TasksPanel`.
- `plugins/CLAUDE.md` — update the `tasks` entry: slots become
  `Tasks.List`, `Tasks.View`; add `Tasks.OpenTask` command; add
  `Shell.Route /tasks/:id`.
- `web/src/components/ui/resizable.tsx` — added by `shadcn add resizable`
  (not hand-written).

### Precedents reused

- `Conversation.OpenMiddlePane` command + `useHandler` pattern in
  `plugins/conversations/plugins/conversation-view/web/commands.ts` and
  `.../components/conversation-view.tsx:20` — same shape as `Tasks.OpenTask`.
- Route registration pattern: `plugins/logs` contributes both `/logs` and
  `/logs/:channel` — mirror that for `/tasks` + `/tasks/:id`.
- Slot contribution rendering (sections with titles) in the existing
  `tasks-panel.tsx:11-16` — kept for `Tasks.View`.

### Non-goals (explicitly out of scope)

- Implementing the actual nested list widget or any detail view — this change
  only ships the split layout and the two slots. Sub-plugins come next.
- Persisting the resize width.
- Auto-close / toggle behavior of the right pane; it's always mounted.

## Verification

1. `./equin build` — clean build, no TS errors.
2. Open `http://claude-1776188416.localhost:9000/tasks`:
   - Left panel: `"No tasks yet."` placeholder (no `Tasks.List`
     contributions yet).
   - Right panel: `"Select a task"` placeholder.
   - Drag the handle between them — both panels resize smoothly.
3. Manually navigate to `/tasks/some-id` in the URL bar:
   - Right panel still shows placeholder (no `Tasks.View` contributions
     yet) but the route resolves (no 404 / welcome pane).
4. From the browser console, dispatch the command:
   `window.__plugins.commands.dispatch("tasks.open-task", { id: "abc" })`
   (or equivalent helper) — URL changes to `/tasks/abc`, back button
   returns to `/tasks`.
5. Sidebar "Tasks" button still routes to `/tasks` (no regression).
