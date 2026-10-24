---
title: Explicit pane registration via `Pane.Register` contribution
date: 2026-04-28
status: proposed
---

# Explicit pane registration

## Context

Today every plugin that owns a route-bearing pane has a load-bearing
`import "./panes"` (or a value import that happens to trigger module
evaluation) inside its `web/index.ts`. The reason: `Pane.define` in
`plugins/primitives/plugins/pane/web/pane.ts` mutates a module-local
`registry: Map` and `topLevel: PaneInternal[]` as a side effect of being
called. Drop the import and the route silently never matches — there is
no compile-time check, no test, nothing.

This is the only place in the plugin system that uses module-load side
effects to register something. Every other extension goes through the
`contributions: [...]` mechanism. Panes deserve the same treatment:

- A defined-but-not-registered pane becomes a localized, visible bug
  (the pane variable is built but never passed to `Pane.Register`),
  not a missing import.
- docgen — which already scans `contributions: [...]` — picks up panes
  for free, so the per-plugin `CLAUDE.md` reference blocks gain a
  visible `Pane.Register` line instead of hiding panes entirely.
- The `import "./panes"` ritual disappears.

## Approach

Split `Pane.define` from registration:

- `Pane.define(...)` becomes a pure factory — builds and returns a
  `PaneObject`, no global mutation. Parent linkage (`PaneInternal.parent`,
  `fullPath`) still happens here because it depends only on the parent
  PaneObject reference passed in, not on the matcher.
- A new top-level slot `Pane.Register` accepts `{ pane: PaneObject<…> }`.
  Plugins contribute `Pane.Register({ pane: foo })` once per pane.
- `<PaneRouter/>` reads `Pane.Register.useContributions()` at the start
  of render and rebuilds the matcher's lookup structure synchronously
  via `useMemo` before anything reads it.

`pane.close()` and `pane.expand()` keep working unchanged because they
are imperative methods called from event handlers *inside* the React
tree under `<PaneRouter/>`. By the time they fire, the sync-on-render
has already populated the module-local registry.

The `PaneInternal.children` field is currently mutated during register
but never read anywhere (`rg` confirms zero call sites). Drop the field
to remove a foot-gun.

## Files to modify

### `plugins/primitives/plugins/pane/web/`

- **`slots.ts`** *(new)* — single static `defineSlot` so docgen finds it:
  ```ts
  import { defineSlot } from "@core";
  import type { PaneObject } from "./pane";

  export const Pane = {
    Register: defineSlot<{ pane: PaneObject<any, any, any> }>("pane.register"),
  };
  ```

- **`pane.ts`** —
  - Remove `registry.set(...)` / `topLevel.push(...)` / `parentInternal.children.push(...)` from `define()` (lines 453-455). Keep the `registry.has(args.id)` HMR warn but move it to the sync hook (see below).
  - Drop the `children: PaneInternal[]` field on `PaneInternal` and stop initializing it.
  - Re-export `Register` on the existing `Pane` namespace:
    ```ts
    import { Pane as PaneSlots } from "./slots";
    export const Pane = { define, Register: PaneSlots.Register };
    ```
  - Add `useSyncPaneRegistry()`:
    ```ts
    export function useSyncPaneRegistry(): void {
      const contribs = PaneSlots.Register.useContributions();
      // useMemo runs synchronously during render; matchRegistry / close()
      // / expand() see the updated module-local registry before any of
      // their callers fire.
      useMemo(() => {
        registry.clear();
        topLevel.length = 0;
        const seen = new Set<string>();
        for (const { pane } of contribs) {
          const internal = pane._internal;
          if (seen.has(internal.id)) {
            console.warn(`Pane "${internal.id}" registered twice.`);
            continue;
          }
          seen.add(internal.id);
          registry.set(internal.id, internal);
          if (!internal.parent) topLevel.push(internal);
        }
      }, [contribs]);
    }
    ```
  - Remove `_getAllPanes` / `_getTopLevelPanes` exports — both are dead
    public API per the exploration grep.

- **`components/pane-router.tsx`** — call `useSyncPaneRegistry()` as the
  first hook so the registry is fresh before `useMatchForPath`.

- **`index.ts`** — re-export `Pane` (now including `.Register`). The
  primitive plugin itself contributes nothing; it only exposes the slot.

### Per-plugin `web/index.ts` updates (24 panes across 22 plugins)

Add `import { Pane } from "@plugins/primitives/plugins/pane/web";` and a
`Pane.Register({ pane: <var> })` entry to the existing `contributions`
array. Remove any `import "./panes"` / `import "./pane"` side-effect
line. For plugins that already do `import { foo } from "./panes"` for a
non-side-effect reason, leave that import untouched.

Affected plugins (full list, from the exploration inventory):

```
plugins/agents/web/index.ts                      agentsRootPane, agentDetailPane, agentConversationPane
plugins/attempt-view/web/index.ts                attemptPane, attemptConversationPane           (drops `import "./panes"`)
plugins/auth/web/index.ts                        accountsPane
plugins/code-explorer/web/index.ts               globalFileTreePane, convFileTreePane
plugins/config/web/index.ts                      settingsPane
plugins/conversations-recover/web/index.ts       recoveryPane
plugins/conversations/plugins/conversation-view/web/index.ts                       conversationPane     (drops `import "./panes"`)
plugins/conversations/plugins/conversation-view/plugins/code/plugins/docs-button/web/index.ts  convDocsPane     (drops `import "./panes"`)
plugins/conversations/plugins/conversation-view/plugins/code/plugins/review/web/index.ts       convReviewPane   (drops `import "./panes"`)
plugins/conversations/plugins/conversation-view/plugins/tasks-panel/web/index.ts   convTasksPane
plugins/conversations/plugins/conversation-view/plugins/terminal-pane/web/index.ts convTerminalPane     (drops `import "./panes"`)
plugins/conversations/plugins/summary/web/index.ts                                 convSummaryPane      (drops `import "./panes"`)
plugins/debug/plugins/db-backup/web/index.ts     dbBackupPane
plugins/debug/plugins/logs/web/index.ts          logsPane, logChannelPane
plugins/debug/plugins/queue/web/index.ts         queuePane
plugins/debug/plugins/worktree-cleanup/web/index.ts  worktreeCleanupPane
plugins/events-test/web/index.ts                 eventsTestPane
plugins/screenshot/web/index.ts                  screenshotPane                                   (drops `import "./panes"`)
plugins/stats/web/index.ts                       statsPane
plugins/tasks/web/index.ts                       tasksRootPane, taskDetailPane, taskConversationPane
plugins/welcome/web/index.ts                     welcomePane                                      (drops `import "./panes"`)
plugins/yak-shaving/web/index.ts                 yakShavingPane, yakShavingConversationPane
```

### Special case: `convFilePeekPane`

Defined inline in
`plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/file-peek-pane.tsx`.
The file-pane plugin currently has **no `PluginDefinition`** — its
`web/index.ts` is just re-exports, and the pane gets registered today
only because consumer plugins import `convFilePeekPane` from this
barrel and that transitively evaluates `file-peek-pane.tsx`.

Fix: give file-pane a minimal `PluginDefinition` and register it in
`web/src/plugins.ts`.

- **`plugins/.../file-pane/web/index.ts`**:
  ```ts
  import type { PluginDefinition } from "@core";
  import { Pane } from "@plugins/primitives/plugins/pane/web";
  import { convFilePeekPane } from "./file-peek-pane";

  export { FilePaneView } from "./components/file-pane";
  export { FilePane, resolveRenderers } from "./slots";
  export type { FileRendererContribution, FileRendererTarget, RendererMatch } from "./slots";
  export { convFilePeekPane } from "./file-peek-pane";
  export { FileOpenProvider } from "./file-open-context";

  export default {
    id: "conversation-code-file-pane",
    name: "Conversation: File Peek Pane",
    description: "Hosts the per-conversation file-peek pane and the FilePane.Renderer slot.",
    contributions: [Pane.Register({ pane: convFilePeekPane })],
  } satisfies PluginDefinition;
  ```

- **`web/src/plugins.ts`** — add a default import for the new file-pane
  plugin alongside its existing sub-plugins (raw / markdown / diff /
  image), in the same import-order section.

### Documentation

- **`plugins/primitives/plugins/pane/CLAUDE.md`** — replace the
  "registration happens at module-load time" paragraph with the new
  pattern. Add a `Register` entry to the "Define a pane" example:

  ```tsx
  // panes.ts
  export const tasksRootPane = Pane.define({ id: "tasks-root", path: "/tasks", component: TasksRoot });

  // index.ts
  export default {
    id: "tasks",
    contributions: [
      Pane.Register({ pane: tasksRootPane }),
      Shell.Sidebar({ /* ... */ }),
    ],
  };
  ```

- **`plugin-core/CLAUDE.md`** — the "Panes: use `Pane.define`, not
  commands" sub-section already has a code sample; add a
  `Pane.Register` line to the example so newcomers see the registration
  step.

### docgen

No code change needed. Once `Pane.Register` is a real `defineSlot` in
`plugins/primitives/plugins/pane/web/slots.ts`, docgen's existing
`parseDefineGroup(slotsSrc, "defineSlot", …)` picks it up at
`cli/src/docgen.ts:485`, and contributing plugins' `Pane.Register({...})`
calls render in their reference blocks via the existing
`extractContributionsBlock` path. After running `./equin build`
the `pane` plugin will list `Pane.Register` under its `Slots:` line and
each consumer plugin will gain a `Pane.Register` entry in its
`Contributes:` list.

The slot id is `pane.register` and the rendered label will be
`Pane.Register` (the title-case head matches the existing convention
used for `Shell.Sidebar`, `Code.ToolbarButton`, etc.).

## Order of changes

1. `slots.ts` (new) + edits to `pane.ts` + `pane-router.tsx` for the
   primitive — this alone breaks every consumer because nothing
   contributes panes yet, so do step 2 in the same commit.
2. Update all 22 consumer `index.ts` files in one sweep. Add
   `Pane.Register` contributions; remove side-effect imports.
3. file-pane: add `PluginDefinition`; add to `web/src/plugins.ts`.
4. Update CLAUDE.md docs.
5. Run `./equin check` (catches plugin-boundary regressions and
   the docs-in-sync check, which will demand a docgen refresh).
6. Run `./equin build` to regenerate
   `docs/plugins-compact.md` / `plugins-details.md` / per-plugin
   reference blocks.

## Tricky bits

- **Sync timing** — `useSyncPaneRegistry` must run via `useMemo`, not
  `useEffect`. `<PaneRouter/>` calls `useMatchForPath(pathname)` later
  in the same render; effects run after render commits, which would be
  too late on the first paint and would also miss `close()` / `expand()`
  calls fired during that same paint.

- **`close()` / `expand()` outside render** — these run from event
  handlers and re-do `matchRegistry(window.location.pathname)`. They
  read the module-local `registry`, which is populated synchronously by
  the sync hook on each render of `<PaneRouter/>`. Since the buttons
  that fire them sit inside the `<PaneRouter/>` subtree, the registry
  is always up to date by the time they run.

- **Parent links** — `Pane.define` still walks `args.parent._internal`
  to set `internal.parent` and compute `fullPath`. This works because
  the parent `PaneObject` is built by an earlier `Pane.define()` call
  in another module that the consumer imports directly. Registration
  order does not matter; only construction order does, and that is
  unchanged.

- **HMR** — current code warns on registry id collisions in `define()`.
  After the refactor, the same warn moves into `useSyncPaneRegistry`
  with `seen.has(internal.id)`. HMR re-runs panes files; the new
  PaneObject replaces the previous one in the contribution list when
  the consumer plugin re-renders. The warn fires only on a real
  duplicate (two distinct plugins claiming the same id), not on HMR
  reloads.

- **`file-pane`'s new plugin id** — choose `conversation-code-file-pane`
  to match the existing nesting convention (`conversation-code-review`,
  `conversation-code-docs-button`).

- **Cross-plugin pane references** — `conversationPane` is imported as
  `parent: conversationPane` by 9 plugins. None of them break, because
  the parent reference works at construction time, not registration
  time. Each plugin still registers only the pane(s) it owns; no plugin
  re-registers `conversationPane`.

## Verification

1. `./equin check` — all checks pass (plugin-boundaries,
   plugins-doc-in-sync, typescript).
2. `./equin build` — succeeds; regenerated
   `docs/plugins-compact.md` shows `Pane.Register` under the pane
   plugin and as a contribution under each pane-owning plugin.
3. Open `http://<worktree>.localhost:9000/` — the welcome pane renders
   (no `import "./panes"` anymore).
4. Click through to a conversation, verify the toolbar buttons that
   open panes (Summary, Tasks, Terminal, Docs, Review, Files, Files
   peek) all navigate correctly. Click the close (×) button on each to
   confirm `pane.close()` still resolves the parent params via
   `matchRegistry`.
5. Spot-check `pane.expand()`: the conversation pane has an
   `ExpandConversationButton`; click it from a nested route and
   confirm it navigates to the standalone conversation URL.
6. `bunx playwright screenshot --wait-for-timeout 3000 ... /tmp/after.png`
   on the conversation pane to confirm visual parity.
7. Grep `rg 'import "\\./panes"' plugins` — should return zero results.
8. Grep `rg 'import "\\./pane"' plugins` — should return zero results
   (one was in `conversations-recover/web/index.ts`).
