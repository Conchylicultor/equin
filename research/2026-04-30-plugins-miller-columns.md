# Miller Columns layout plugin

## Context

Today, navigating to a deep URL like `/c/abc/docs` produces one mounted root pane that places `<Outlet/>` somewhere inside its body to embed the child. Side panes are achieved through ad-hoc `ResizablePanelGroup` splits inside individual pane components (conversation-view, attempt-view, task-detail), and "full-screen" sub-panes (review, code-explorer file-tree) bypass the parent entirely via a `markMainPane` flag. The renderer is the bottleneck — every "open a pane to the right" pattern reinvents the layout.

Miller Columns is the right primitive: the existing `matchRegistry()` already returns the full root→leaf chain via `chain: MatchEntry[]`. Render that chain horizontally as a sequence of equal-status columns and the URL becomes the column chain for free. No new routing concept; no new navigation API (`pane.open(params)` already does the right thing once the renderer changes).

Scope: one concrete plugin, `plugins/layouts/plugins/miller/`. **Not** a generalized `Layout.define` primitive — that is deferred until a second layout type (tabs, grid) actually motivates the abstraction.

## Architecture

`<MillerColumns/>` is a drop-in replacement for `<PaneRouter/>` at the single mount in `plugins/shell/web/components/shell-layout.tsx:212`. Same registry sync + match. Instead of mounting one `<PaneLevel depth={0}/>` and relying on nested `<Outlet/>` calls, it maps `match.chain` to a flat row of `<Column/>`s.

```
<main>
  <MillerColumns>           usePathname() → useMatchForPath() → match.chain
    PaneMatchContext.Provider value={match}
    flex-row, h-full, overflow-x-auto
    ├ <Column depth={0}/>   width=chrome.width ?? 400, resize handle on right
    ├ <Column depth={1}/>   width=...,            resize handle on right
    └ <Column depth={N-1}/> flex-1 min-w=200      (last column)
        each Column: PaneDepthContext.Provider value={depth} → <entry.pane.component/>
```

`<entry.pane.component/>` does NOT call `<Outlet/>` under Miller. Each pane is the sole owner of its own column body.

## Plugin layout

Path follows the umbrella convention (`plugins/<umbrella>/plugins/<child>/`) so future tab/grid layouts slot in alongside.

```
plugins/layouts/
  CLAUDE.md
  package.json
  plugins/
    miller/
      CLAUDE.md
      package.json
      web/
        index.ts                       # barrel: definePlugin + export MillerColumns
        components/
          miller-columns.tsx
          column.tsx
          resize-handle.tsx
        hooks/
          use-column-collapse.ts
          use-column-widths.ts
```

**Wiring:**
- Add `import millerPlugin from "@plugins/layouts-miller/web"` (or whatever the workspace import resolves to — match other umbrella imports in `web/src/plugins.ts`) and include in the plugin list.
- `plugins/layouts/plugins/miller/web/index.ts` exports `MillerColumns` from its barrel. The shell imports it via `import { MillerColumns } from "@plugins/layouts-miller/web"` and replaces `<PaneRouter/>` in `shell-layout.tsx:212`. `MillerColumns` is the *only* public export; no slot contributions.
- `<PaneRouter/>` itself stays exported from the pane primitive (used by tests / future fallback) but is no longer mounted anywhere in the app.

## `<MillerColumns/>` component

```tsx
export function MillerColumns() {
  useSyncPaneRegistry();
  const pathname = usePathname();
  const match = useMatchForPath(pathname);
  if (!match) return null;

  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Scroll new rightmost column into view on chain growth.
    if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth;
  }, [match.chain.length]);

  return (
    <PaneMatchContext.Provider value={match}>
      <div ref={ref} className="flex h-full overflow-x-auto">
        {match.chain.map((entry, depth) => (
          <Column key={entry.pane.id} entry={entry} depth={depth}
                  isLast={depth === match.chain.length - 1} />
        ))}
      </div>
    </PaneMatchContext.Provider>
  );
}

function Column({ entry, depth, isLast }) {
  const [collapsed, toggle] = useColumnCollapse(entry.pane.id);
  const [width, setWidth] = useColumnWidth(entry.pane.id, entry.pane.chrome.width ?? 400);
  if (collapsed) return <CollapsedBar entry={entry} onExpand={toggle} />;

  return (
    <>
      <div
        style={{ width: isLast ? undefined : width }}
        className={isLast ? "flex-1 min-w-[200px]" : "shrink-0"}
      >
        <PaneDepthContext.Provider value={depth}>
          <entry.pane.component />
        </PaneDepthContext.Provider>
      </div>
      {!isLast && <ResizeHandle onResize={(dx) => setWidth(width + dx)} />}
    </>
  );
}
```

`useCurrentPane()` and `pane.useParams()` continue to work unchanged — they read `PaneMatchContext` (still set by Miller) and `PaneDepthContext` (still wrapped per-column).

## Per-pane default width

Add an optional `width` field to `PaneChromeConfig`:

```ts
// plugins/primitives/plugins/pane/web/pane.ts (lines 48-59)
export interface PaneChromeConfig<Params> {
  title?: string | ((params: Params) => string);
  history?: boolean;
  close?: boolean;
  expand?: (params: Params) => string;
  width?: number; // px, default 400
}
```

Each pane registration sets its sensible default (e.g. `agentsRootPane: 280`, `commitsGraphPane: 520`, most side panes: 400). Miller reads this via `entry.pane.chrome.width`. The leaf column ignores its own `width` and flex-grows.

## Resizable columns

Each non-leaf column has a 4px-wide drag handle on its right edge (`<ResizeHandle/>`). Dragging updates the column's width via `setWidth(width + dx)` on `pointermove`. State lives in a module-level `Map<paneId, number>` + `useState` trigger (same shape as collapse state).

**Persistence: none for v1.** Per user's confirmation, "ok if reset at refresh." Module-level Map survives within the SPA session (route changes preserve widths) but resets on full reload. SessionStorage persistence is a trivial follow-up if desired.

Min width: 200px. Max: none.

## Collapse mechanic

UI: 32px-wide vertical bar. Top: a chevron expand button. Below: pane title rotated 90° (`writing-mode: vertical-rl; text-orientation: mixed`). Clicking anywhere on the bar expands. Bar is a `<button>` so keyboard-focusable (Enter/Space toggles).

State: `useColumnCollapse(paneId)` — module-level `Map<string, boolean>` + `useState` trigger. Persisted to `sessionStorage` under `miller.collapse.${paneId}` so collapsed columns survive route changes within the session (resets on full reload, like widths).

Lifecycle: when collapsed, only the body is replaced with the bar. The full pane component subtree is **NOT** mounted in collapsed state — that's intentional, because re-mount cost is negligible for collapsed panes (terminal etc. aren't typically collapsed; if they are, reconnect on expand is acceptable). If a specific pane needs mount-stay-alive when collapsed, we can add a `chrome: { keepMountedWhenCollapsed: true }` flag in a follow-up. **Confirm with user if any current pane needs this.** (Open question — see §Open questions.)

## `<Outlet/>` migration

**Delete `<Outlet/>` calls from every pane component**, since Miller now owns column composition. The `<Outlet/>` export itself stays in the pane primitive (public API).

Files to edit:
- `plugins/agents/web/panes.tsx` — remove `<Outlet/>` from `AgentsRoot` and `AgentDetailBody`. The right-side panel JSX wrapper goes too; each pane just renders its own content.
- `plugins/tasks/plugins/task-detail/web/panes.tsx` — remove `<Outlet/>` from `TasksRoot` and `TaskDetailBodyContent`. (TaskDetailBodyContent still renders its `SidePanel` slot internally — see §Deferred work.)
- `plugins/attempt-view/web/components/attempt-pane.tsx` — remove `<Outlet/>` from the right `ResizablePanel`, then remove the entire `ResizablePanelGroup` (the right panel becomes empty under Miller; the left list now fills the whole `attemptPane` column).
- `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx` — remove the `mainAndSide` `ResizablePanelGroup`, the `isMain` branch, and both `<Outlet/>` calls. `ConversationView` simplifies to: render `mainBlock` always inside `<PaneChrome>` + `<conversationPane.Provider>`.

## `markMainPane` removal

Per user decision: drop entirely.

Today, `markMainPane(pane)` adds the pane id to a `Set<string>` (`mainPaneIds`). `ConversationView` reads `isMainPaneId(leafPane.id)` and, when true, swaps to a full-Outlet layout that suppresses parent chrome — used by `review` and `code-explorer` to take over the conversation area. Under Miller, "takeover" is unnecessary: each becomes its own rightmost column that flex-grows.

Files to delete / clean:
- `plugins/conversations/plugins/conversation-view/web/panes.tsx` — delete `mainPaneIds`, `markMainPane`, `isMainPaneId`.
- `plugins/conversations/plugins/conversation-view/web/index.ts:8` — remove `markMainPane`, `isMainPaneId` from re-exports.
- `plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/web/panes.tsx:4,18` — remove import + the `markMainPane(convReviewPane)` call.
- `plugins/code-explorer/web/panes.tsx:4,23` — remove import + the `markMainPane(convFileTreePane)` call.

After deletion, both review and the conv file-tree are plain panes whose components render via `<PaneChrome>` like everyone else.

## `openColumn` / open API

**No new function.** `pane.open(params)` already calls `navigate(buildUrl(pane, params))` which `pushState`s the pane's full URL. Under Miller, the same URL produces a longer chain → a new rightmost column. The renderer changes; the navigation API stays the same.

## Deferred: `TaskDetail.SidePanel` slot

Today `task-file-peek` is a `TaskDetail.SidePanel` slot contribution rendered as a `ResizablePanel` inside `TaskDetailBodyContent`, driven by a local `filePath` React context (`useTaskDetailFilePeek()`), not a pane.

Per user decision: defer the conversion to a proper child pane. Miller still works — `taskDetailPane` is a single column whose internals contain the existing split. **Action:** file a follow-up task via the `mcp__singularity__add_task` MCP tool with the title "Refactor task-file-peek into a proper child pane of taskDetailPane" and a body referencing this plan section.

## Migration order

**Step 1 — Land `plugins/layouts/plugins/miller/`.** Create the plugin, the `<MillerColumns/>` renderer, the collapse and width hooks, the resize handle. Add `width` field to `PaneChromeConfig`. Replace `<PaneRouter/>` with `<MillerColumns/>` in `shell-layout.tsx:212`. *At this point, every pane's `<Outlet/>` still fires, so child panes appear twice (once nested via outlet, once as a column). Land Steps 1+2 in the same commit to avoid this transitional state in any reviewable diff.*

**Step 2 — Remove `<Outlet/>` calls from pane components.** All 5 files listed in §Outlet migration. Simplify the now-redundant `ResizablePanelGroup`s in `conversation-view.tsx` and `attempt-pane.tsx`.

**Step 3 — Delete `markMainPane` + the `isMain` branch in `conversation-view.tsx`** (folded into Step 2 since they're entangled). Clean up the four files in §markMainPane removal.

**Step 4 — Per-pane width tuning.** Set `chrome.width` on every pane registration that benefits from a non-default value. Suggested first pass: `agentsRootPane: 280`, `tasksRootPane: 320`, `commitsGraphPane: 520`, all toggle-side panes (tasks, docs, summary, terminal): 400. Tune by eye after `./equin build`.

**Step 5 — File follow-up tasks** via `mcp__singularity__add_task`:
- "Refactor task-file-peek into a proper child pane of taskDetailPane" (see §Deferred work).
- "Make `chrome: { history: false }` panes use `replaceState` instead of `pushState`" (see Open question 2).
- "Add `chrome: { keepMountedWhenCollapsed: true }` flag for terminal-pane (and any other pane that suffers from reconnect-on-expand)" (see Open question 1).

## Verification

```bash
./equin build
```

Open `http://<worktree>.localhost:9000`:

1. **Agent chain (3 columns):** `/agents/<id>/c/<convId>` — three columns: agents list, agent detail, conversation.
2. **Toolbar toggles add columns:** Open `/c/<convId>`, click each: Tasks, Docs, Summary, Commits Graph, Terminal, Review. Each appends a column on the right; the new column auto-scrolls into view. Clicking the same button closes it.
3. **review + file-tree as columns (markMainPane gone):** Click Review — should appear as the rightmost flex-grow column alongside the conversation, NOT a full-screen takeover. Same for code-explorer's file-tree.
4. **Collapse:** Click the collapse chevron on a middle column. Verify it shrinks to a 32px vertical bar with rotated title. Click the bar to expand.
5. **Resize:** Drag the handle between two columns; widths update live. Within the SPA session (route changes), widths persist; full reload resets.
6. **Per-pane defaults:** Without resizing, agents list looks narrower than commits-graph by default.
7. **Attempt view:** `/a/<attemptId>/c/<convId>` — two columns: attempt (left list filling the whole column, no internal split) and conversation.
8. **Task detail:** `/tasks/<taskId>` — two columns: task list, task detail. Internal task-file-peek split still works inside the task-detail column (deferred work).
9. **History:** Browser back from a deep chain removes the rightmost column.
10. **Direct deep URL load:** Paste `/c/<convId>/docs` in the URL bar — renders 2 columns on first load.

## Open questions

1. **Mount-stay-alive when collapsed:** Resolved — defer to follow-up. Body unmounts on collapse for v1; if reconnect-on-expand becomes annoying for terminal-pane, add `chrome: { keepMountedWhenCollapsed: true }` in a tiny follow-up. Task filed in Step 5.
2. **`chrome: { history: false }` → `replaceState`:** Resolved — defer to follow-up. The flag currently only affects history-button rendering; `pane.open()` always pushes. Task filed in Step 5.
3. **Multi-instance side conversations:** `side-conversation` could plausibly want two open at once (`/c/abc/c/x/c/y`). Today's path pattern (`c/:sideConvId`) supports nesting only via the side-conv pane registering itself as its own grandparent — clunky. Flag for future; not in v1 scope.
4. **`agentSidePane` parent path:** parented to `conversationPane` (path `agent/:agentId`). Visually 3 columns under Miller (agent context + conversation + agentSide). Should be fine; verify during step 1.

## Critical files to modify

- `/plugins/shell/web/components/shell-layout.tsx` (line 212 — swap PaneRouter for MillerColumns)
- `/plugins/primitives/plugins/pane/web/pane.ts` (add `width` to `PaneChromeConfig`)
- `/plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx` (delete `<Outlet/>`s, `mainAndSide`, `isMain`)
- `/plugins/conversations/plugins/conversation-view/web/panes.tsx` (delete `markMainPane`, `isMainPaneId`)
- `/plugins/conversations/plugins/conversation-view/web/index.ts` (remove re-exports)
- `/plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/web/panes.tsx` (remove markMainPane call)
- `/plugins/code-explorer/web/panes.tsx` (remove markMainPane call)
- `/plugins/agents/web/panes.tsx` (remove `<Outlet/>`s)
- `/plugins/tasks/plugins/task-detail/web/panes.tsx` (remove `<Outlet/>`s)
- `/plugins/attempt-view/web/components/attempt-pane.tsx` (remove `<Outlet/>`, simplify split)
- `/web/src/plugins.ts` (register miller plugin)

## New files

- `/plugins/layouts/CLAUDE.md`, `/plugins/layouts/package.json`
- `/plugins/layouts/plugins/miller/CLAUDE.md`, `/plugins/layouts/plugins/miller/package.json`
- `/plugins/layouts/plugins/miller/web/index.ts`
- `/plugins/layouts/plugins/miller/web/components/{miller-columns.tsx,column.tsx,resize-handle.tsx}`
- `/plugins/layouts/plugins/miller/web/hooks/{use-column-collapse.ts,use-column-widths.ts}`
