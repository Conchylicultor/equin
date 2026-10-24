# Tasks plugin → umbrella split

## Context

`plugins/tasks/` has grown into a monolithic web plugin: `panes.tsx` and `task-detail.tsx` hardcode the entire task-detail layout (DAG graph, header with title/status/author/buttons, description editor, attachments, dependencies, events, file-peek side panel). It already exposes `Tasks.List`, `Tasks.View`, `Tasks.TaskActions` slots but most sections are inline.

The goal is **modularity** (not optionality): every section becomes a sub-plugin contributing to a positioned slot, so any section can be swapped, replaced, or extended later without touching the host. This mirrors `plugins/conversations/plugins/conversation-view/`, where even non-optional pieces (`prompt-input`, `status`, `model`) are independent plugins.

Outcome: `plugins/tasks/` becomes a thin umbrella; the `task-detail` sub-plugin owns the right-pane host, slots, and shared context; one sub-plugin per detail section. Public API at `@plugins/tasks/web` is preserved end-to-end so external callers (`tasks-panel`, `expand-to-tasks-action`, plugin registries, etc.) need no changes.

## Final layout

```
plugins/tasks/                                           # umbrella (thin)
  CLAUDE.md
  package.json
  shared/                                                # UNCHANGED
  server/                                                # UNCHANGED (server split out of scope)
  web/
    index.ts                                             # plugin def + barrel re-exports
    root-pane.ts                                         # tasksRootPane definition (leaf, no sub-plugin imports)
    panes.tsx                                            # TasksRoot host body only
    slots.ts                                             # Tasks.List + Tasks.TaskActions (Tasks.View deleted)
    components/
      task-status.tsx                                    # STATUS_META + StatusIcon (used by task-list and task-graph)
      delete-task-action.tsx                             # Tasks.TaskActions contributor (kept here)
      expand-collapse-all-action.tsx                     # ditto
      launch-agent-action.tsx                            # ditto
  plugins/
    task-list/                                           # left-pane tree
      package.json
      web/
        index.ts                                         # plugin def + exports TasksList
        components/tasks-list.tsx
    task-detail/                                         # detail pane host + slots + context
      package.json
      web/
        index.ts                                         # plugin def + Pane.Register; barrel re-exports
        panes.tsx                                        # taskDetailPane + taskConversationPane
        slots.ts                                         # TaskDetail.Above / .Section / .SidePanel
        context.tsx                                      # FilePeekProvider + flush registry
        components/
          task-detail.tsx                                # public <TaskDetail> component (renders sections)
      plugins/
        task-graph/        web/{index.ts, components/task-graph.tsx}
        task-header/       web/{index.ts, components/task-header.tsx, components/author-display.tsx}
        task-description/  web/{index.ts, components/task-description.tsx, components/description-view.tsx}
        task-dependencies/ web/{index.ts, components/task-dependencies.tsx}
        task-attachments/  web/{index.ts, components/task-attachments.tsx}
        task-events/       web/{index.ts, components/task-events.tsx}
        task-file-peek/    web/{index.ts, components/task-file-peek.tsx}
```

All sub-plugin ids: `task-list`, `task-detail`, `task-graph`, `task-header`, `task-description`, `task-dependencies`, `task-attachments`, `task-events`, `task-file-peek`. The `task-` prefix avoids collisions with existing globally-unique names (`events`, `attachments`).

## Public API preservation

The umbrella `plugins/tasks/web/index.ts` re-exports everything external callers use:

```ts
// re-exports — paths external callers already use
export { Tasks } from "./slots";                                // Tasks.List, Tasks.TaskActions
export { tasksRootPane } from "./root-pane";
export { TasksList } from "@plugins/task-list/web";
export {
  TaskDetail,                                                   // the public component
  taskDetailPane,
  taskConversationPane,
  TaskDetailFilePeekProvider,                                   // exposed for advanced embeds
  useRegisterFlush,                                             // flush registry hook
} from "@plugins/task-detail/web";
export { StatusIcon, STATUS_META } from "./components/task-status";
```

External callers requiring no change:
- `web/src/plugins.ts:67` — `tasksPlugin` default import (umbrella stays at same path)
- `server/src/plugins.ts:24` — server side untouched
- `plugins/conversations/.../tasks-panel/web/components/tasks-pane.tsx:6` — `import { TasksList, TaskDetail } from "@plugins/tasks/web"` keeps working; `<TaskDetail onFileOpen={...}/>` keeps its prop API (see below)
- `plugins/conversations/.../tasks-panel/web/components/expand-to-tasks-action.tsx:4` — `import { taskDetailPane } from "@plugins/tasks/web"` keeps working
- All shared-resource consumers (worktree-switcher, attempt-view, code/review, drop-and-exit, push-counter) — `@plugins/tasks/shared` is unchanged
- `new-child-task` HTTP callers — server endpoints unchanged

## Slot definitions (`task-detail/web/slots.ts`)

```ts
export const TaskDetail = {
  // Full-bleed band(s) above the section list. Contributors own their own
  // styling (border, height) and may return null to hide.
  Above: defineSlot<{
    id: string;
    order?: number;
    component: ComponentType<{ taskId: string }>;
  }>("task-detail.above"),

  // Vertical stack of sections in the main column. Sections own their headers.
  Section: defineSlot<{
    id: string;
    order?: number;
    component: ComponentType<{ taskId: string }>;
  }>("task-detail.section"),

  // Right-side panel. Contributors return null when not active. The host
  // checks "any contributor wants to render" via context (file-peek today).
  SidePanel: defineSlot<{
    id: string;
    order?: number;
    component: ComponentType<{ taskId: string }>;
  }>("task-detail.side-panel"),
};
```

`Tasks.View` is deleted (confirmed unused outside the umbrella).

## Shared context (`task-detail/web/context.tsx`)

Two things live here: file-peek state (replaces the old host `useState`) and a flush registry (replaces the old `Promise.all([titleField.flush(), descField.flush()])`).

```tsx
type FilePeekState = {
  filePath: string | null;
  openFile: (path: string) => void;
  closeFile: () => void;
};

type FlushRegistry = {
  register: (fn: () => Promise<void> | void) => () => void;   // returns unregister
  flushAll: () => Promise<void>;
};

// Default no-op contexts so embeds without a Provider get sensible behavior.
const NOOP_PEEK: FilePeekState = { filePath: null, openFile: () => {}, closeFile: () => {} };
const NOOP_FLUSH: FlushRegistry = { register: () => () => {}, flushAll: async () => {} };

export const TaskDetailFilePeekCtx = createContext<FilePeekState>(NOOP_PEEK);
export const TaskDetailFlushCtx = createContext<FlushRegistry>(NOOP_FLUSH);

export function TaskDetailFilePeekProvider({
  override,                                                     // optional: tasks-panel passes its own openFile
  children,
}: {
  override?: Pick<FilePeekState, "openFile">;
  children: ReactNode;
}) {
  const [filePath, setFilePath] = useState<string | null>(null);
  const value = useMemo<FilePeekState>(() => override
    ? { filePath: null, openFile: override.openFile, closeFile: () => {} }   // delegated mode
    : { filePath, openFile: setFilePath, closeFile: () => setFilePath(null) },
    [filePath, override?.openFile],
  );

  const fns = useRef(new Set<() => Promise<void> | void>());
  const flushValue = useMemo<FlushRegistry>(() => ({
    register: (fn) => { fns.current.add(fn); return () => fns.current.delete(fn); },
    flushAll: async () => { await Promise.all([...fns.current].map((f) => f())); },
  }), []);

  return (
    <TaskDetailFilePeekCtx.Provider value={value}>
      <TaskDetailFlushCtx.Provider value={flushValue}>
        {children}
      </TaskDetailFlushCtx.Provider>
    </TaskDetailFilePeekCtx.Provider>
  );
}

export function useTaskDetailFilePeek() { return useContext(TaskDetailFilePeekCtx); }
export function useFlushAll() { return useContext(TaskDetailFlushCtx).flushAll; }

// Sub-plugins call this in editable-field setup:
//   useRegisterFlush(titleField.flush);
export function useRegisterFlush(fn: () => Promise<void> | void) {
  const { register } = useContext(TaskDetailFlushCtx);
  useEffect(() => register(fn), [register, fn]);
}
```

## Public `<TaskDetail>` component (`task-detail/web/components/task-detail.tsx`)

Preserves the `onFileOpen` prop for `tasks-panel`'s embedded use:

```tsx
export function TaskDetail({
  taskId,
  onFileOpen,                                                   // optional: embed escape hatch
}: {
  taskId: string;
  onFileOpen?: (path: string) => void;
}) {
  const sections = TaskDetailSlots.Section.useContributions();
  const body = (
    <div className="flex flex-col gap-4 p-6">
      {sections.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((s) => (
        <s.component key={s.id} taskId={taskId} />
      ))}
    </div>
  );
  // When called with onFileOpen (embedded use), wrap with override Provider.
  // When called inside taskDetailPane, the host already wraps with the Provider.
  if (onFileOpen) {
    return (
      <TaskDetailFilePeekProvider override={{ openFile: onFileOpen }}>
        {body}
      </TaskDetailFilePeekProvider>
    );
  }
  return body;
}
```

## Sub-plugin specs

Each sub-plugin's `web/index.ts` is a thin barrel: imports from `@plugins/tasks/web` (slots, panes, status icons), contributes to the relevant slot, default-exports `definePlugin(...)`. Imports from sibling sub-plugins are forbidden by the boundary rules; everything routes through the umbrella's barrel.

- **task-list** — Tree on the left. Imports `Tasks.TaskActions`, `taskDetailPane`, `StatusIcon` from `@plugins/tasks/web`; `tasksResource` from `@plugins/tasks/shared`. Re-exports `TasksList` for the umbrella to pass through. Preserves controlled-mode props (`rootTaskId`, `selectedId`, `onSelect`) used by `tasks-panel`.

- **task-detail** — Host. Defines `taskDetailPane` (parent: `tasksRootPane` from umbrella) and `taskConversationPane`. Defines `TaskDetail.*` slots. Wraps body in `TaskDetailFilePeekProvider`. Renders `TaskDetail.Above` band + `<TaskDetail/>` (sections) + side-panel/conversation column. Imports `tasksRootPane` from `./root-pane` via the umbrella barrel re-export to avoid a cycle.

- **task-graph** — `TaskDetail.Above({ id: "graph", order: 0 })`. Owns its own band styling (`bg-muted/30 h-60 shrink-0 border-b`). Component computes `computeDagClosure(taskId, allTasks)` and returns `null` if `closure.length <= 1`. Moves `computeDagClosure` here from `task-dag.tsx`.

- **task-header** — `TaskDetail.Section({ id: "header", order: 10 })`. Title editor, status chip, author display, hold/drop buttons, Launch buttons. Calls `useRegisterFlush(titleField.flush)`. Launch handler calls `await flushAll()` before building the launch request from current `tasksResource` state. No race: `flushAll` waits for both header's title and description's flush to complete before reading from the live resource.

- **task-description** — `TaskDetail.Section({ id: "description", order: 20 })`. Description editor with file-link parsing. Calls `useRegisterFlush(descField.flush)`. Calls `useTaskDetailFilePeek().openFile(path)` on file-link click.

- **task-dependencies** — `TaskDetail.Section({ id: "dependencies", order: 30 })`. Mechanical move.

- **task-attachments** — `TaskDetail.Section({ id: "attachments", order: 40 })`. Mechanical move; uses `listAttachments` from `@plugins/infra/plugins/attachments/web`.

- **task-events** — `TaskDetail.Section({ id: "events", order: 50 })`. Mechanical move; uses `attemptsResource`/`pushesResource` from `@plugins/tasks/shared`, `taskConversationPane` for navigation.

- **task-file-peek** — `TaskDetail.SidePanel({ id: "file-peek", order: 0 })`. Component reads `useTaskDetailFilePeek().filePath`; returns `null` if `null`. The host pane keeps its existing `<Outlet/>` fallback for `taskConversationPane`.

## Plugin registration

All sub-plugins added flat (not nested) in `web/src/plugins.ts`, alongside `tasksPlugin`:

```ts
import taskListPlugin from "@plugins/task-list/web";
import taskDetailPlugin from "@plugins/task-detail/web";
import taskGraphPlugin from "@plugins/task-graph/web";
import taskHeaderPlugin from "@plugins/task-header/web";
import taskDescriptionPlugin from "@plugins/task-description/web";
import taskDependenciesPlugin from "@plugins/task-dependencies/web";
import taskAttachmentsPlugin from "@plugins/task-attachments/web";
import taskEventsPlugin from "@plugins/task-events/web";
import taskFilePeekPlugin from "@plugins/task-file-peek/web";
```

`server/src/plugins.ts` is unchanged (server side is umbrella-level only).

## Cycle avoidance — `tasksRootPane`

`task-detail/web/panes.tsx` needs `tasksRootPane` (as the parent pane). The umbrella's `index.ts` re-exports `taskDetailPane` from `task-detail`. To avoid a circular import, define `tasksRootPane` in **`plugins/tasks/web/root-pane.ts`** — a leaf module with no sub-plugin imports. Both umbrella `panes.tsx` and `task-detail/web/panes.tsx` import from `root-pane.ts` (or via the umbrella barrel for the sub-plugin, which re-exports from the leaf). No cycle.

## Step-by-step migration (each step buildable + reviewable)

Each step ends with `./equin check --plugin-boundaries`, `./equin build`, and a manual smoke test of the affected flows.

1. **Carve out `task-detail` host (no behavior change).**
   - Create `plugins/tasks/plugins/task-detail/{package.json, web/{index.ts, panes.tsx, slots.ts, context.tsx, components/task-detail.tsx}}`.
   - Move `taskDetailPane` and `taskConversationPane` from umbrella `panes.tsx` to sub-plugin.
   - Define `TaskDetail.{Above,Section,SidePanel}` slots (no contributors yet).
   - Implement `TaskDetailFilePeekProvider` + flush registry.
   - The new public `<TaskDetail>` component initially **delegates to the legacy inline component** (still in the umbrella) so behavior is unchanged.
   - Move `tasksRootPane` definition to `plugins/tasks/web/root-pane.ts`.
   - Update umbrella `web/index.ts` barrel to re-export from `task-detail`.
   - Register `taskDetailPlugin` in `web/src/plugins.ts`.

2. **Move file-peek into `task-file-peek` sub-plugin.**
   - Move `task-file-peek.tsx`. Component reads `useTaskDetailFilePeek().filePath` and returns null if absent.
   - Contribute `TaskDetail.SidePanel`. Host renders side-panel slots when `filePath !== null`.
   - Smoke test: click a file link in description (still inline); right panel opens; close hides it.

3. **Move DAG into `task-graph` sub-plugin.**
   - Move `task-dag.tsx` → `task-graph.tsx`. Move `computeDagClosure` here. Component returns null if `closure.length <= 1`. Contributor owns its band styling.
   - Move `task-status.tsx` to umbrella (`plugins/tasks/web/components/task-status.tsx`); re-export `StatusIcon`/`STATUS_META` from `@plugins/tasks/web` for `task-graph` and `task-list`.
   - Remove DAG/closure logic from host pane.
   - Contribute `TaskDetail.Above`.

4. **Split `task-detail.tsx` into `task-header` + `task-description`.**
   - Extract title input, status chip, author display, hold/drop buttons, Launch button → `task-header.tsx`. Author lookup → `author-display.tsx`.
   - Extract description editor (and `description-view.tsx`) → `task-description.tsx`.
   - Each calls `useRegisterFlush(field.flush)`. Launch button uses `useFlushAll()` and reads title/description from `tasksResource` after `await flushAll()`.
   - Public `<TaskDetail>` component now renders `TaskDetail.Section` contributions instead of the legacy inline body. Delete `plugins/tasks/web/components/task-detail.tsx`.
   - Smoke test: title edit + Launch (no race), description edit + Launch (no race), status hold/drop, author click navigation.

5. **Move `task-dependencies`, `task-attachments`, `task-events` (one PR each).**
   - Each: mechanical move, contribute `TaskDetail.Section` at orders 30/40/50, register in `web/src/plugins.ts`.

6. **Split `tasks-list.tsx` into `task-list` sub-plugin.**
   - Move tree component. Re-export `TasksList` from umbrella.
   - Verify controlled-mode props (`rootTaskId`, `selectedId`, `onSelect`) still work for `tasks-panel`.
   - Verify `Tasks.TaskActions` contributors (delete, expand-all, launch-agent — kept at umbrella) still render in row menus.

7. **Cleanup.**
   - Delete `Tasks.View` slot.
   - Update `plugins/tasks/CLAUDE.md` (autogen block regenerates on next `./equin build`).
   - Confirm each sub-plugin has a generated `CLAUDE.md`.
   - Final boundary + build pass.

## Critical files

- `.claude/worktrees/att-1777417095-s2eq/plugins/tasks/web/index.ts` — becomes barrel + thin plugin def
- `.claude/worktrees/att-1777417095-s2eq/plugins/tasks/web/panes.tsx` — collapses to `TasksRoot` host body only
- `.claude/worktrees/att-1777417095-s2eq/plugins/tasks/web/slots.ts` — keep `Tasks.List`, `Tasks.TaskActions`; delete `Tasks.View`
- `.claude/worktrees/att-1777417095-s2eq/plugins/tasks/web/components/task-detail.tsx` — deleted by step 4 (broken into sub-plugins)
- `.claude/worktrees/att-1777417095-s2eq/plugins/conversations/plugins/conversation-view/plugins/tasks-panel/web/components/tasks-pane.tsx` — verify but should require no edits (public API preserved)
- `.claude/worktrees/att-1777417095-s2eq/web/src/plugins.ts` — add 9 sub-plugin imports/registrations

## Reused primitives (do not reinvent)

- `useEditableField` from `@plugins/primitives/plugins/editable-field/web` — already supports `flush()` (used by current launch-button race avoidance)
- `LaunchButtons` from `@plugins/primitives/plugins/launch/web`
- `useResource` + `tasksResource` / `attemptsResource` / `pushesResource` from live-state + tasks-shared (live data plumbing already exists)
- `Pane.define` / `PaneChrome` / `Outlet` / `usePaneMatch` from primitives — pane infra unchanged
- `defineSlot` from `@core` — slot primitive unchanged

## Verification

**Boundary check** after every step:
```
./equin check --plugin-boundaries
```

**Build** after every step:
```
./equin build
```

**Manual smoke tests** (the user-visible flows that must keep working):
- `/tasks` — left tree renders; expand/collapse all; status icons; row context menu (delete, expand-all, launch-agent).
- Select a task — detail loads; title editable; status chip + Hold/Drop buttons; Author shows and navigates; description editable.
- Click a file link in description — right panel opens with file content; close button hides it.
- Type in title, click Launch immediately (no blur) — title is current (flush registry kicked in). Same for description.
- Task with deps — DAG band shows above; click a node navigates; satisfied edges green. Task without deps — no band.
- Events section: pushes, attempts, GitHub link; clicking a conversation opens `taskConversationPane` with `<ConversationView/>`.
- `tasks-panel` (open from a conversation toolbar) — embedded `<TasksList>` and `<TaskDetail>` render; clicking a file link in description routes to `convFilePeekPane` (not the side panel) — verifies the `onFileOpen` prop path.
- DnD reparent + rename in tree — works.

## Risks & edge cases

1. **Cycle on `tasksRootPane`** — mitigated by `root-pane.ts` leaf module.
2. **`tasks-panel` reuse** — preserved via `onFileOpen` prop on `<TaskDetail>` that activates an override Provider; verified during step 6 smoke test.
3. **DAG empty band** — fixed by moving band styling into `task-graph` and having it return null when `closure.length <= 1`.
4. **Title/description flush race** — solved by flush registry; Launch button awaits all registered flushes before reading from `tasksResource`.
5. **`Tasks.View` removal** — verified no contributors today; deletion is safe in step 7.
6. **Plugin id collisions** — all new ids prefixed `task-`; `events`, `attachments` collisions avoided.
7. **Server side** — intentionally untouched; sections share endpoints, splitting the server has no payoff today.
