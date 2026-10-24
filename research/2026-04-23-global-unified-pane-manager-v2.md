# Unified Pane Manager (v2)

> **Changes from v1:** The pane primitive is packaged as its own **plugin** (`plugins/pane/`) instead of being added to `plugin-core/`. `plugin-core` stays minimal (slots + commands + resources); pane management is a feature built on top of those primitives, like `shell` is. Rest of the design is unchanged.

## Context

Today, the app has **three separate pane systems** that don't share anything:

1. **Shell-level routes** (`plugins/shell/`) — `Shell.Route` slot + `Shell.OpenPane` command + flat `PaneDescriptor { title, component, path }`. One pane at a time, no nesting.
2. **Tasks / Agents split view** (`plugins/tasks/web/components/tasks-panel.tsx`, `plugins/agents/web/components/agents-panel.tsx`) — ad-hoc `ConversationPaneContext { activeId, open, close }` + hand-rolled `ResizablePanelGroup`. The third column (conversation) is not represented in the URL.
3. **Conversation sub-panes** (`plugins/conversations/plugins/conversation-view/web/`) — `Conversation.OpenMiddlePane / OpenRightPane / OpenMainView` commands + three separate React contexts (`MiddlePaneContext`, `RightPaneContext`, `MainViewContext`) + descriptor shape `{ id, component }` with `{ conversation }` prop-drilled. Also not represented in the URL.

Each system handles different concerns (routing, layout, state passing) differently. Adding features like history navigation, expand-to-main, per-pane action slots, or nested URLs today requires patching each system separately.

This doc unifies them under **one `Pane` primitive** with built-in chrome (history ‹ ›, expand button, action slot) and nested URL routing. The primitive ships as a new `plugins/pane/` plugin that consumes the existing plugin-core (`defineSlot`, `defineCommand`) and is consumed by other plugins the same way `shell` is today.

Out of scope for this iteration: dynamic layout trees (drag-and-drop, runtime "open right", overlays, tabs). A strictly nested parent-child model is chosen now; the layout-tree model is a future upgrade on top of the same `Pane.define` surface.

## Design decisions (pre-agreed)

1. **Composition: nested parent-child.** One `<Outlet />` per pane. Siblings exist as nested panes. No named slots.
2. **History: pane-scoped.** Each pane has its own stack of visited URLs within its subtree. ‹ › operates on that stack and triggers `navigate()`.
3. **Top-level shell areas are panes.** `Shell.Route` is removed. Plugins register panes directly via `Pane.define({ path: "/…" })`.
4. **Pane objects are values.** `Pane.define` returns a typed object; callers import the object to read params / data / register children. No string-key lookups.
5. **Data passing via `provides` + `useData()`.** Panes that want to expose rich objects to descendants declare `provides: type<{ conversation: Conversation }>()` and render the pane's `<Provider>` internally. Typed `MiddlePaneContext` / `RightPaneContext` / `MainViewContext` all go away.
6. **Params are own-only.** `pane.useParams()` returns that pane's params, not merged ancestor params. Ancestor access is explicit: `ancestorPane.useParams()`.
7. **Default remount on move.** Switching slots or expanding a pane remounts its component. `keepalive` is deferred.
8. **TypeScript throughout.** Params inferred from path template literals. `provides` type flows to `useData()`. Parent relationship (`parent: somePane`) is a typed reference, not a string.
9. **Packaged as a plugin** (v2). Lives at `plugins/pane/`, following the same pattern as `plugins/shell/`. `plugin-core` is unchanged.

## Caller-facing API

### `Pane.define`

```ts
// plugins/pane/web/pane.ts — conceptual signature
Pane.define<Path extends string, Provides = void>({
  id: string;                    // used for debugging, dev warnings, chrome key
  parent?: Pane<any, any>;       // another pane object; omit for top-level
  path?: Path;                   // appended to parent's path; omit for "no URL segment"
  component: ComponentType;      // the pane body; may render <Outlet/> and the pane's <Provider>
  provides?: TypeMarker<Provides>;  // declares the data shape for descendants
  chrome?: {
    title?: string | ((params) => string);
    history?: boolean;           // show ‹ ›; default true for panes with nested routes
    expand?: (params) => string; // URL to navigate to on "expand" click
  };
}): Pane<InferParams<Path>, Provides>
```

The returned `Pane` object exposes:

```ts
interface Pane<Params, Provides> {
  id: string;
  path: string;                  // resolved full path incl. ancestors
  Provider: ComponentType<{ value: Provides; children: ReactNode }>;
  useParams(): Params;
  useData(): Provides;           // only present when `provides` is declared
  open(params: Params): void;
  close(): void;                 // navigate to parent.path
  expand(): void;                // navigate to chrome.expand(params)
  back(): void;                  // pane-scoped history back
  forward(): void;
  Actions: Slot<{ component: ComponentType }>;  // auto-created per pane
}
```

`Pane.define` is both a factory (returns a typed object) and a registration (pushes into the pane plugin's module-level registry). Same duality `defineCommand` already uses — callers import the pane object, and the pane plugin's `<PaneRouter />` reads the registry at render time.

### Example: unified tasks view (`/tasks/:taskId/c/:convId`)

```ts
// plugins/tasks/web/panes.ts
import { Pane, Outlet, type } from "@plugins/primitives/plugins/pane/web";

export const tasksRootPane = Pane.define({
  id: "tasks-root",
  path: "/tasks",
  component: TasksRoot,
});

export const taskDetailPane = Pane.define({
  id: "task-detail",
  parent: tasksRootPane,
  path: ":taskId",          // full: /tasks/:taskId
  component: TaskDetail,
  provides: type<{ task: Task }>(),
});

export const taskConversationPane = Pane.define({
  id: "task-conversation",
  parent: taskDetailPane,
  path: "c/:convId",        // full: /tasks/:taskId/c/:convId
  component: ConversationPaneBody,
  chrome: { history: true, expand: ({ convId }) => `/c/${convId}` },
});
```

Pane components:

```tsx
function TasksRoot() {
  return (
    <Split direction="h">
      <TasksList />
      <Outlet />
    </Split>
  );
}

function TaskDetail() {
  const { taskId } = taskDetailPane.useParams();
  const task = useTask(taskId);
  if (!task) return <NotFound />;
  return (
    <taskDetailPane.Provider value={{ task }}>
      <Split direction="h">
        <TaskDetailBody />
        <Outlet />
      </Split>
    </taskDetailPane.Provider>
  );
}
```

Descendants read data without knowing their depth:

```tsx
function SomeSubComponent() {
  const { task } = taskDetailPane.useData();   // typed
  const { convId } = taskConversationPane.useParams();
}
```

### Example: conversation sub-panes (`/c/:convId/docs`, `/c/:convId/tasks`, `/c/:convId/review`)

```ts
// plugins/conversations/plugins/conversation-view/web/panes.ts
export const conversationPane = Pane.define({
  id: "conversation",
  path: "/c/:convId",
  component: ConversationBody,
  provides: type<{ conversation: ConversationRecord }>(),
  chrome: { history: true },
});
```

Sub-panes contributed by child plugins:

```ts
// plugins/.../docs-button/web/panes.ts
Pane.define({
  id: "conv-docs",
  parent: conversationPane,
  path: "docs/:filePath*",
  component: DocsPane,
});

// plugins/.../tasks-panel/web/panes.ts
Pane.define({
  id: "conv-tasks-panel",
  parent: conversationPane,
  path: "tasks",
  component: TasksPanelBody,
});

// plugins/.../review/web/panes.ts
Pane.define({
  id: "conv-review",
  parent: conversationPane,
  path: "review",
  component: ReviewDiff,
});
```

Only one child is mounted at a time (nested single-outlet model). Opening a different sub-pane is a navigation; the previous sub-pane unmounts. History ‹ › lets users flip back.

To "open" a sub-pane, a caller navigates:

```tsx
<Button onClick={() => convDocsPane.open({ convId, filePath: "CLAUDE.md" })}>Docs</Button>
```

### Action buttons

Every pane auto-creates an `Actions` slot. Other plugins contribute:

```ts
conversationPane.Actions({ component: RefreshButton });
```

The standard pane chrome renders action contributions in a header bar alongside ‹ › and expand. Pane authors who want custom header layout opt out (`chrome: false`) and compose pieces themselves via `<PaneHistoryButtons pane={…} />`, `<PaneActionsSlot pane={…} />`.

### What callers stop using

- `Shell.Route` — removed.
- `Shell.OpenPane` + `PaneDescriptor` — removed. Use `somePane.open(params)` or `navigate(url)`.
- `Conversation.OpenMiddlePane` / `OpenRightPane` / `OpenMainView` — removed.
- `MiddlePaneContext` / `RightPaneContext` / `MainViewContext` — removed. Descendants use `conversationPane.useData()`.
- `ConversationPaneContext` / `ConversationPaneController` (tasks, agents) — removed. The third column is a child pane with its own URL.

## Rendering model (sketch)

Enough to confirm the API is implementable.

- **Registry.** `Pane.define` pushes into a module-level registry keyed by pane id. Parent refs resolved to pointers; children indexed under parent for `<Outlet />` lookup.
- **Router.** A single `<PaneRouter />` rendered once by `shell-layout.tsx` in its main area. Reads `location.pathname`, matches against the flat list of "full paths" produced by walking the tree, picks the longest match, and exposes a chain of matched panes (root → leaf) via `PaneMatchContext`.
- **`<Outlet />`.** Reads `PaneMatchContext`, finds the next pane in the chain, renders it.
- **`useParams()`.** Reads the pane's entry in the match chain. Throws if the pane is not in the current match.
- **`useData()`.** Reads a React context the pane's `<Provider>` installs. Throws with a clear dev-time error if the provider is missing.
- **Pane-scoped history.** A `PaneHistoryContext` per pane holds a `{ past, future }` stack. Each nested-route change in the pane's subtree pushes onto `past`; `back()`/`forward()` move through stacks and call `navigate()`. Stack stored one level up so it survives the pane's own remounts.
- **Stable component identity across navigations.** Preserve the current trick in `shell-layout.tsx:93-105` (component→id map so `/tasks/a` → `/tasks/b` doesn't remount the tree). Lift into the pane router so it applies across all panes.

## Package structure

New plugin `plugins/pane/` following the pattern in `plugin-core/CLAUDE.md`:

```
plugins/pane/
├── web/
│   ├── index.ts           # PluginDefinition (empty contributions) + public exports
│   ├── pane.ts            # Pane.define, registry, path-to-params types, buildPath()
│   ├── components/
│   │   ├── pane-router.tsx   # <PaneRouter/> — top-level URL matcher
│   │   ├── outlet.tsx        # <Outlet/>
│   │   └── pane-chrome.tsx   # <PaneChrome/>, <PaneHistoryButtons/>, <PaneActionsSlot/>
│   └── CLAUDE.md          # Author guide: how to define a pane, outlet, chrome
└── package.json
```

Public exports from `@plugins/primitives/plugins/pane/web`:

```ts
export { Pane, Outlet, PaneRouter };
export { PaneChrome, PaneHistoryButtons, PaneActionsSlot };  // for opt-out chrome
export { type };  // TypeMarker helper
export type { PaneObject };
```

## Files

### New

- `plugins/pane/web/*` — the new plugin (structure above).
- `plugins/pane/package.json` — workspace package, depends on `react`, `react-resizable-panels` (for `<Split />` if bundled, otherwise callers provide layout).

### Modified

- `plugins/shell/web/components/shell-layout.tsx` — strip URL-matching / `panels` state / `ShellCommands.OpenPane` handler. Replace the `<ScrollArea>…panels.map(…)</ScrollArea>` body with `<PaneRouter />` imported from `@plugins/primitives/plugins/pane/web`.
- `plugins/shell/web/slots.ts` — remove `Shell.Route`.
- `plugins/shell/web/commands.ts` — remove `Shell.OpenPane` and `PaneDescriptor`. `Shell.Toast` stays.
- `web/src/plugins.ts` — register the new pane plugin in the plugin list (must come before anything that defines panes, though ordering shouldn't matter in practice since registration happens at module-load time).

### Migrated (one per phase)

- **`plugins/tasks/web/`** — replace `Shell.Route` contributions with `Pane.define` calls. Delete `conversation-pane-context.tsx`. Rewrite `tasks-panel.tsx` to use `<Outlet/>`. Conversation column becomes a nested pane at `c/:convId`.
- **`plugins/agents/web/`** — same shape as tasks.
- **`plugins/conversations/plugins/conversation-view/web/`** — delete `commands.ts` contexts, rewrite `conversation-view.tsx` to be a pane with a single `<Outlet/>`. The "middle pane" case (stacked above terminal) becomes a nested pane that renders its own `<Split direction="v">`.
- **`plugins/conversations/plugins/conversation-view/plugins/*/`** — every sub-plugin that called `Conversation.OpenMiddlePane / OpenRightPane / OpenMainView` now calls `Pane.define({ parent: conversationPane, path: "…" })`. Includes: `code/plugins/docs-button`, `code/plugins/review`, `tasks-panel`, `jsonl-viewer`, plus any others grep turns up.
- **Remaining `Shell.Route` users** — `welcome`, `stats`, `stats/plugins/*`, `config`, `debug/plugins/*`, `screenshot`, others found via grep.

## Implementation phases

Each phase is ship-able and reversible. Phase 2 is the design-validation milestone.

### Phase 1 — Introduce the pane plugin

Create `plugins/pane/` with `Pane.define`, `<Outlet/>`, `<PaneRouter/>`, chrome components, path types. Register in `web/src/plugins.ts`. Wire `<PaneRouter/>` into `shell-layout.tsx` *in addition to* the existing `Shell.Route` logic (both consult the URL; existing routes still work). No other callers change yet.

Ship: empty new registry, existing app works identically.

### Phase 2 — Migrate tasks as the representative

Convert `plugins/tasks/web/` fully. Tasks becomes a three-level pane tree (`tasksRootPane` → `taskDetailPane` → `taskConversationPane`). The URL gains `/tasks/:taskId/c/:convId`. Conversation column opens and closes via URL; ‹ › history works inside the tasks subtree.

This phase exercises: top-level pane, nested pane, `provides`, `Outlet`, chrome, history, expand (`/tasks/:taskId/c/:cid` → `/c/:cid`).

Ship: tasks has the new behavior; everything else untouched. Update this doc as v3 if the real-world migration forces meaningful API tweaks.

### Phase 3 — Migrate conversation sub-panes

Convert `conversation-view` and all its sub-plugins. Delete the three `Open*Pane` commands, the three contexts, and their descriptor types.

Ship: conversation pane, docs, tasks-panel, jsonl, review all driven by URL. Back button works. ‹ › history inside the conversation chrome works.

### Phase 4 — Migrate agents and remaining routes

Agents mirrors tasks. Convert `welcome`, `stats`, `config`, `debug`, `screenshot` to top-level panes. Remove `Shell.Route` from `plugins/shell/web/slots.ts` and `Shell.OpenPane` from `commands.ts`.

Ship: `Shell.Route` no longer exists. Grep confirms zero callers.

### Phase 5 — Cleanup

Delete dead types, dead files. Update `plugins/shell/web/CLAUDE.md` (if exists) and `plugins/pane/web/CLAUDE.md` to document the new primitive. Update `docs/plugins.md` if its generator relies on route contributions.

## Open questions (deferred, not blocking)

- **keepalive for heavy panes.** When review diff is collapsed from main to side and back, scroll resets. Add opt-in `keepalive: true` later if this bites.
- **Layout tree (Option C).** If/when drag-and-drop, tabs, or overlays are needed, introduce a separate `Layout` concept inside `plugins/pane/` that arranges multiple panes from the current match. Pane definitions stay the same; the nested-outlet default becomes the default `Layout`.
- **Persistence of ‹ › history across reloads.** In-memory only for now. Per-pane localStorage is easy to add later.
- **Path matching rules.** `plugins/shell/web/routing.ts` has strict-equal parts. The new matcher must support nested prefixes, optional segments, and wildcards (`:filePath*`). Implement inline in `plugins/pane/web/pane.ts`; carve out if it grows.

## Verification

For each phase, verify end-to-end in the running app (deployed via `./equin build`):

- **Phase 1.** `./equin build`. App renders identically. No console errors. Existing routes unchanged.
- **Phase 2.** Navigate to `/tasks`, click a task → `/tasks/:id`. Click a conversation → `/tasks/:id/c/:cid`, conversation column appears. Back button walks the chain. Expand the conversation → `/c/:cid`, conversation fills main. Reload at each URL — correct layout restores. Switching conversations from the list lets ‹ › flip back.
- **Phase 3.** Click docs → `/c/:cid/docs/…`. Click tasks-panel → `/c/:cid/tasks`. Click review → `/c/:cid/review`. Back button works. Reloads restore state. `conversationPane.useData()` returns the right object in every nested pane.
- **Phase 4.** Every top-level route from before is reachable and identical.
- **Phase 5.** `grep -r "Shell.Route" plugins/ plugin-core/ web/` returns zero. `grep -r "MiddlePaneContext\|RightPaneContext\|MainViewContext" plugins/ plugin-core/` returns zero. `grep -r "ConversationPaneContext" plugins/` returns zero.

Type safety per phase: `bun run typecheck`. Misuses (wrong params, wrong provider, referencing a pane not in the ancestor chain) surface at compile time for the first two and dev-time runtime for the third.
