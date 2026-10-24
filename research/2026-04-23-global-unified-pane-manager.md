# Unified Pane Manager

## Context

Today, the app has **three separate pane systems** that don't share anything:

1. **Shell-level routes** (`plugins/shell/`) — `Shell.Route` slot + `Shell.OpenPane` command + flat `PaneDescriptor { title, component, path }`. One pane at a time, no nesting.
2. **Tasks / Agents split view** (`plugins/tasks/web/components/tasks-panel.tsx`, `plugins/agents/web/components/agents-panel.tsx`) — ad-hoc `ConversationPaneContext { activeId, open, close }` + hand-rolled `ResizablePanelGroup`. The third column (conversation) is not represented in the URL.
3. **Conversation sub-panes** (`plugins/conversations/plugins/conversation-view/web/`) — `Conversation.OpenMiddlePane / OpenRightPane / OpenMainView` commands + three separate React contexts (`MiddlePaneContext`, `RightPaneContext`, `MainViewContext`) + descriptor shape `{ id, component }` with `{ conversation }` prop-drilled. Also not represented in the URL.

Each system handles different concerns (routing, layout, state passing) differently. Adding features like history navigation, expand-to-main, per-pane action slots, or nested URLs today requires patching each system separately.

This doc unifies them under **one `Pane` primitive** with built-in chrome (history ‹ ›, expand button, action slot) and nested URL routing. The API is the user-visible product; this doc is primarily about caller-facing shape.

Out of scope for this iteration: dynamic layout trees (drag-and-drop, runtime "open right", overlays, tabs). A strictly nested parent-child model is chosen now; the layout-tree model is a future upgrade on top of the same `Pane.define` surface. See [Future: dynamic layouts](#future-dynamic-layouts).

## Design decisions (pre-agreed)

1. **Composition model: nested parent-child.** Each pane has at most one `<Outlet />`. Siblings exist as nested panes. No named slots.
2. **History: pane-scoped.** Each pane maintains its own stack of visited URLs within that pane's subtree. ‹ › buttons operate on that stack and cause `navigate()` calls; they don't hijack browser history.
3. **Top-level shell areas are panes.** `Shell.Route` is removed. Plugins register panes directly via `Pane.define({ path: "/…" })`.
4. **Pane objects are values, not strings.** `Pane.define` returns an object; callers import the object to read params / data / register children. No string-key lookups.
5. **Data passing via `provides` + `useData()`.** Panes that want to expose rich objects to descendants declare `provides: type<{ conversation: Conversation }>()` and render the pane's `<Provider>` internally. Typed `MiddlePaneContext` / `RightPaneContext` / `MainViewContext` all go away.
6. **Params are own-only.** `pane.useParams()` returns that pane's params, not merged ancestor params. Ancestor access is explicit: `ancestorPane.useParams()`.
7. **Default remount on move.** Switching slots or expanding a pane remounts its component. `keepalive` is deferred — add only when a real need shows up.
8. **TypeScript throughout.** Params inferred from path template literals. `provides` type flows to `useData()`. Parent relationship (`parent: somePane`) is a typed reference, not a string.

## Caller-facing API

### 1. Defining a pane

```ts
// plugin-core/pane.tsx — conceptual signature
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
    actions?: SlotRef;           // slot where action buttons render
  };
}): Pane<InferParams<Path>, Provides>
```

The returned `Pane` object exposes:

```ts
interface Pane<Params, Provides> {
  id: string;
  path: string;                  // resolved full path incl. ancestors
  Provider: ComponentType<{ value: Provides; children: ReactNode }>;
  useParams(): Params;           // throws if called outside this pane
  useData(): Provides;           // only present when provides is declared
  open(params: Params): void;    // sugar for navigate(buildPath(path, params))
  close(): void;                 // sugar for navigate(parent.path)
  expand(): void;                // sugar for navigate(chrome.expand(params))
  back(): void;                  // pane-scoped history back
  forward(): void;               // pane-scoped history forward
  Actions: Slot<{ component: ComponentType }>;  // auto-created; contribute chrome actions
}
```

### 2. Example: unified tasks view (`/tasks/:taskId/c/:convId`)

```ts
// plugins/tasks/web/panes.ts
export const tasksRootPane = Pane.define({
  id: "tasks-root",
  path: "/tasks",
  component: TasksRoot,     // renders tree + <Outlet/>
});

export const taskDetailPane = Pane.define({
  id: "task-detail",
  parent: tasksRootPane,
  path: ":taskId",          // full: /tasks/:taskId
  component: TaskDetail,    // renders detail + <Outlet/>
  provides: type<{ task: Task }>(),
});

export const taskConversationPane = Pane.define({
  id: "task-conversation",
  parent: taskDetailPane,
  path: "c/:convId",        // full: /tasks/:taskId/c/:convId
  component: ConversationPaneBody,  // reuses the conversation-view body
  chrome: {
    history: true,
    expand: ({ convId }) => `/c/${convId}`,
  },
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
  return ...;
}
```

### 3. Example: conversation sub-panes (`/c/:convId/docs`, `/c/:convId/tasks`, `/c/:convId/review`)

The conversation view today uses three commands (`OpenMiddlePane`, `OpenRightPane`, `OpenMainView`) and three contexts. All are replaced by `Pane.define` contributions.

The `conversation` pane itself provides the `Conversation` object to descendants — one provider instead of three contexts:

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

Sub-panes contributed by child plugins look identical to top-level panes, just with `parent: conversationPane`:

```ts
// plugins/conversations/plugins/conversation-view/plugins/code/plugins/docs-button/web/panes.ts
Pane.define({
  id: "conv-docs",
  parent: conversationPane,
  path: "docs/:filePath*",       // /c/:convId/docs/**
  component: DocsPane,
});

// plugins/.../conversation-view/plugins/tasks-panel/web/panes.ts
Pane.define({
  id: "conv-tasks-panel",
  parent: conversationPane,
  path: "tasks",                 // /c/:convId/tasks
  component: TasksPanelBody,
});

// plugins/.../conversation-view/plugins/code/plugins/review/web/panes.ts
Pane.define({
  id: "conv-review",
  parent: conversationPane,
  path: "review",                // /c/:convId/review
  component: ReviewDiff,
});
```

Only one child is mounted at a time (nested single-outlet model). Opening a different sub-pane is a navigation; the previous sub-pane unmounts. History ‹ › lets users flip back.

To "open" a sub-pane, a caller navigates:

```tsx
<Button onClick={() => navigate(`/c/${convId}/docs/CLAUDE.md`)}>Docs</Button>
// or, more ergonomically:
<Button onClick={() => convDocsPane.open({ convId, filePath: "CLAUDE.md" })}>Docs</Button>
```

### 4. Action buttons

Every pane auto-creates an `Actions` slot. Other plugins contribute:

```ts
// plugin that adds a refresh button to the conversation pane chrome
conversationPane.Actions({ component: RefreshButton });
```

The standard pane chrome renders action contributions in a header bar alongside ‹ › and expand. Pane authors who want custom header layout opt out of the standard chrome (`chrome: false`) and render the pieces themselves via `<PaneHistoryButtons pane={…} />`, `<PaneActionsSlot pane={…} />`, etc.

### 5. What callers stop using

- `Shell.Route` — removed.
- `Shell.OpenPane` + `PaneDescriptor` — removed. Top-level navigation becomes `somePane.open(params)` or `navigate(url)`.
- `Conversation.OpenMiddlePane` / `OpenRightPane` / `OpenMainView` — removed.
- `MiddlePaneContext` / `RightPaneContext` / `MainViewContext` — removed. Descendants use `conversationPane.useData()`.
- `ConversationPaneContext` / `ConversationPaneController` (in tasks, agents) — removed. Column 3 is a child pane with its own URL.

## Rendering model (sketch — not the focus of this plan)

Enough detail to confirm the API is implementable. Internals can evolve.

- **Registry.** `Pane.define` pushes into a module-level registry keyed by pane id. Parent refs are resolved to pointers; children are indexed under their parent for `<Outlet />` lookup.
- **Router.** A single `<PaneRouter />` lives at the shell root (replaces `ShellLayout`'s inline routing). It reads `location.pathname`, matches against the flat list of "full paths" produced by walking the tree (parent.path + "/" + child.path), picks the longest match, and exposes a chain of matched panes (root → leaf) via `PaneMatchContext`.
- **`<Outlet />`.** Reads `PaneMatchContext`, finds the next pane in the chain, and renders it.
- **`useParams()`.** Reads the pane's entry in the match chain. Throws if the pane is not in the current match.
- **`useData()`.** Reads a React context that the pane's `<Provider>` installs. Throws with a clear error if the provider is missing in the ancestor tree.
- **Pane-scoped history.** A `PaneHistoryContext` per pane (provided by the pane chrome) holds a `{ past, future }` stack. Each nested-route change in the pane's subtree pushes onto `past`; `back()`/`forward()` move through the stacks and call `navigate()`. The stack survives the pane's own remounts (stored one level up, in the parent's match entry).
- **Stable component identity across navigations.** Preserve the current trick in `shell-layout.tsx:93-105` (component→id map so `/tasks/a` → `/tasks/b` doesn't remount the tree). Lift to the pane router so it applies across all panes.

## Files

### New

- `plugin-core/pane.tsx` — `Pane.define`, `<Outlet/>`, `<PaneRouter/>`, `<PaneHistoryButtons/>`, `<PaneActionsSlot/>`, path-to-params type helper, `buildPath()`, registry. Single file for now; can split later if it gets large.
- `plugin-core/pane-chrome.tsx` — standard header component composing title + history + expand + actions slot. Pane authors render it when `chrome` is set.

### Modified

- `plugin-core/index.ts` — re-export `Pane`, `Outlet`, `type`, path helpers.
- `plugins/shell/web/components/shell-layout.tsx` — strip the URL-matching / `panels` state / `ShellCommands.OpenPane` handler. Replace the `<main>` body with `<PaneRouter />`.
- `plugins/shell/web/slots.ts` — remove `Shell.Route`.
- `plugins/shell/web/commands.ts` — remove `Shell.OpenPane` and `PaneDescriptor`. `Shell.Toast` stays.

### Migrated (one per phase)

- **`plugins/tasks/web/`** — replace `Shell.Route` contributions with `Pane.define` calls. Delete `conversation-pane-context.tsx`. Rewrite `tasks-panel.tsx` to use `<Outlet/>`. Conversation column becomes a nested pane at `c/:convId`.
- **`plugins/agents/web/`** — same shape as tasks.
- **`plugins/conversations/plugins/conversation-view/web/`** — delete `commands.ts` contexts, rewrite `conversation-view.tsx` to be a pane with a single `<Outlet/>` (replacing the middle/right/main fork). The special "middle pane" case (stacked above terminal) becomes a nested pane whose body renders its own `<Split direction="v">`.
- **`plugins/conversations/plugins/conversation-view/plugins/*/`** — every sub-plugin that called `Conversation.OpenMiddlePane / OpenRightPane / OpenMainView` now calls `Pane.define({ parent: conversationPane, path: "…" })`. List: `code/plugins/docs-button`, `code/plugins/review`, `tasks-panel`, `jsonl-viewer`, `title` (if it uses a pane), any others found during migration.
- **Remaining `Shell.Route` users** — `welcome`, `stats`, `stats/plugins/*`, `config`, `debug/plugins/*`, `screenshot`, `tasks-core` (if it contributes routes). Grep for `Shell.Route(` to finalize the list.

## Implementation phases

Each phase is ship-able and reversible. Phase 2 is the design-validation milestone.

### Phase 1 — Land the primitive alongside the old system

Add `Pane.define`, `<Outlet/>`, `<PaneRouter/>`, chrome components, path types. Wire `<PaneRouter/>` into `shell-layout.tsx` *in addition to* the existing `Shell.Route` logic (both consult the URL; the old one handles `Shell.Route` contributions, the new one handles `Pane.define` contributions). No callers change yet.

Ship: empty new registry, existing app works identically.

### Phase 2 — Migrate tasks as the representative

Convert `plugins/tasks/web/` fully. Tasks becomes a three-level pane tree (`tasksRootPane` → `taskDetailPane` → `taskConversationPane`). The URL gains `/tasks/:taskId/c/:convId`. Conversation column opens and closes via URL; ‹ › history works inside the tasks subtree.

This phase exercises: top-level pane, nested pane, `provides`, `Outlet`, chrome, history, expand (conversation → `/c/:convId`).

Ship: tasks has new behavior; everything else untouched.

Expect API tweaks based on real usage. Update this doc as v2 if anything non-trivial changes.

### Phase 3 — Migrate conversation sub-panes

Convert `conversation-view` and all its sub-plugins. Delete the three `Open*Pane` commands, the three contexts, and their descriptor types.

Ship: conversation pane, docs, tasks-panel, jsonl, review all driven by URL. Back button works. ‹ › history inside the conversation chrome works.

### Phase 4 — Migrate agents and remaining routes

Agents mirrors tasks. Convert `welcome`, `stats`, `config`, `debug`, `screenshot` to top-level panes. Remove `Shell.Route` from `plugins/shell/web/slots.ts` and `Shell.OpenPane` from `commands.ts`.

Ship: `Shell.Route` no longer exists. Grep confirms zero callers.

### Phase 5 — Cleanup

Delete dead types, dead files, update CLAUDE.md docs in `plugin-core/` and `plugins/shell/web/` to describe the new primitive. Update `docs/plugins.md` generator if it relies on route contributions.

## Open questions (deferred, not blocking)

- **keepalive for heavy panes.** When review diff is collapsed from main to side and back, scroll resets. Add opt-in `keepalive: true` later if this bites.
- **Layout tree (Option C).** If/when drag-and-drop, tabs, or overlays are needed, introduce a separate `Layout` concept that arranges multiple panes from the current match. Pane definitions stay the same; the nested-outlet default becomes the default `Layout`.
- **Persistence of ‹ › history across reloads.** For now, in-memory only. Per-pane localStorage is easy to add later.
- **Path matching rules.** The current `matchRoute` in `plugins/shell/web/routing.ts` is strict-equal parts. The new matcher must support (a) nested prefixes, (b) optional trailing segments (`:convId?` for `/tasks/:taskId` vs `/tasks/:taskId/c/:convId`), and (c) wildcards (`:filePath*`). Implement inline for now; if it grows, carve out a module.

## Verification

For each phase, verify end-to-end in the running app (deployed via `./equin build`):

- **Phase 1.** `./equin build`. App renders identically. Open devtools, confirm no console errors. Navigate between existing routes — unchanged.
- **Phase 2.** Navigate to `/tasks`, click a task → URL becomes `/tasks/:id`, detail pane appears. Click a conversation → URL becomes `/tasks/:id/c/:cid`, conversation column appears. Back button walks the chain. Click expand on the conversation → URL becomes `/c/:cid`, conversation fills the main area. Reload at each URL state — correct layout restores. Inside the conversation column, switch to a different conversation from the list → ‹ › on the conversation column lets you flip back.
- **Phase 3.** In a conversation, click docs → URL becomes `/c/:cid/docs/…`. Click tasks-panel → URL becomes `/c/:cid/tasks`. Click review → URL becomes `/c/:cid/review`, takes over main. Back button works. Reloading each URL restores state. `conversationPane.useData()` returns the right `conversation` object in every nested pane (verify via a temporary `console.log` or component).
- **Phase 4.** Every top-level route from before is reachable and behaves identically. Sidebar entries still open the right pane.
- **Phase 5.** `grep -r "Shell.Route" plugins/ plugin-core/ web/` returns zero. `grep -r "MiddlePaneContext\|RightPaneContext\|MainViewContext" plugins/ plugin-core/` returns zero. `grep -r "ConversationPaneContext" plugins/` returns zero.

Type safety checks per phase: `bun run typecheck` (or whatever the project uses; confirm during implementation). Expect all misuses (wrong params, wrong provider, referencing a pane object not in the ancestor chain) to surface at compile time for the first two and at dev-time runtime for the third.
