# Sidebar page delete → trash, no confirmation, Cmd+Z restores

**Date:** 2026-07-12
**Status:** Proposed

## Context

Deleting a page from the Pages sidebar today opens a destructive confirm dialog
("…cannot be undone", plus a descendant count) and then hard-commits. That copy
is now **a lie**: the `infra/trash` primitive landed on this branch, and
`DELETE /api/blocks/:id` already routes through `deleteBlocksSubtree`, which
*soft-deletes* any subtree containing a `type="page"` block — the rows keep their
content, docs, side-tables and version history, and the Trash dialog can restore
them. The delete is already reversible; the UI just doesn't say so, and there is
no keyboard path back.

The wanted behavior is Notion's: **delete is instant and silent, and Cmd+Z puts
the page back** — from the sidebar, on the same history as your edits in the page
body.

The reason that doesn't work today is a **layering error**, not a missing
feature. `undo-redo`'s own doc says it provides "one independent history **per
surface tab**" — but the only `<UndoRedoProvider>` in the app is mounted *inside*
`<BlockEditor>` (`block-editor.tsx:218`). So the history is really per-editor.
The sidebar sits outside that subtree (they only meet up in generic infra —
`AppShellLayout`, and above it `TabSurface`), so it has no stack to record into,
and bolting a second provider around the sidebar would put two `mod+z`
registrations (same id, same priority) into the page-global `ShortcutManager`,
whose winner is then arbitrary — it would `console.warn` about the collision and
could restore a page when you meant to undo a keystroke.

**The fix is to move the provider to where the primitive already claims it
lives: the tab.** Everything else follows from that.

## Design

### 1. The undo stack belongs to the tab (`apps-core/tab-surface`)

Mount `<UndoRedoProvider>` once per tab in `TabSurface`, directly alongside the
`<SyncStatusProvider>` that is already mounted there — the exact same
"surface-scoped primitive, one instance per tab" precedent, inside the one
`PaneSurfaceProvider` whose `surfaceId={tab.tabId}` the undo shortcuts are
already gated on. Register `useUndoRedoShortcuts()` there too, once.

```tsx
// plugins/apps-core/plugins/tab-surface/web/components/tab-surface.tsx
<PaneSurfaceProvider surfaceId={tab.tabId} …>
  <TabTitleReporter tabId={tab.tabId} />
  <SyncStatusProvider>
    <UndoRedoProvider>          {/* NEW — one history per tab */}
      …{renderIsolated(Apps.App.id, app)}…
    </UndoRedoProvider>
  </SyncStatusProvider>
</PaneSurfaceProvider>
```

`<BlockEditor>` then **drops both of its own `<UndoRedoProvider>` mounts and its
`useUndoRedoShortcuts()` call** and simply records into the tab's stack. The
sidebar records into that same stack. Shared history, no shortcut collision, and
undo becomes a platform capability any plugin can record into rather than a thing
the page editor happens to own.

This is safe for every existing host: the only three `<BlockEditor>` mount sites
(Pages `panes.tsx`, Story `story-editor.tsx`, the website `editor-toy` demo) all
render inside a `TabSurface`, and no test mounts `<BlockEditor>` directly. Apps
that record nothing keep an empty stack, so `canUndo` is `false`, the `when`
guard rejects, and `mod+z` is never claimed — native input undo is untouched
everywhere else.

### 2. Entry lifetime: scoped entries (`undo-redo`)

Moving the provider up has one real consequence. `openPane(…, {mode:"swap"})`
mints a fresh `instanceId`, Miller keys its columns by it, so **navigating page A
→ B remounts the column today and silently clears the editor's history**. With a
tab-level provider those entries would survive — but they *cannot service
themselves*: the editor's thunks close over its own mount (the per-`pageId`
optimistic store; per-block `Y.UndoManager`s that die with the doc). Replaying one
after unmount is a silent no-op at best and a patch dispatched into the wrong
page's overlay at worst.

So make the rule explicit in the primitive instead of accidental:

> **An entry whose thunks depend on a live mount must declare a scope; a scope's
> entries are dropped from `past`/`future` when that mount unmounts.**

Small, generic addition to `undo-redo/web`:

- `HistoryEntry.scope?: string` (`internal/stack.ts`) + a pure
  `dropScope(state, scope)` filtering `past`/`future` — unit-testable next to the
  existing `stack.test.ts`.
- `store.dropScope(id)` (`internal/store.ts`).
- `useScopedUndoRedo()` (`internal/use-scoped-undo-redo.ts`): a `useId()`-derived
  scope, a `record` that auto-stamps it, and an unmount effect that calls
  `dropScope`.

`BlockEditorProvider` swaps `useUndoRedo()` → `useScopedUndoRedo()`
(`block-editor-context.tsx:553`) — a one-line change that **preserves today's
clear-on-navigate behavior exactly**. The sidebar keeps plain `useUndoRedo()`:
its thunks are pure server calls, valid anywhere in the tab, so its entries
rightly outlive any pane.

Net semantics: *delete a page, navigate anywhere, Cmd+Z still restores it; edit
page A, navigate to B, Cmd+Z does not reach back into A* (as today).

### 3. The reusable "trashed → undoable" seam (`infra/trash`)

Do **not** hand-roll restore in the delete button. The fact is generic across
every trash source: *a mutation that trashes returns an entry handle; undo is
`POST /api/trash/:sourceId/:entryId/restore`; redo re-runs the mutation, which
mints a **new** entry id.* That belongs to the plugin that owns the concept.

**Discriminated outcome** (`infra/trash/core/schemas.ts`) — a nullable `entryId`
would be an absorbable failure, so:

```ts
export const TrashOutcomeSchema = z.discriminatedUnion("trashed", [
  z.object({ trashed: z.literal(true), sourceId: z.string(), entryId: z.string() }),
  z.object({ trashed: z.literal(false) }),   // page-free subtree → hard delete, nothing to undo
]);
```

**New web barrel** `infra/trash/web` (the plugin is server+core today):

```ts
const trashWithUndo = useUndoableTrash();

await trashWithUndo({
  label: `Delete ${title}`,
  trash: () => deletePage({ params: { id: pageId } }),   // → Promise<TrashOutcome>
  onUndo: () => openPane(pageDetailPane, { pageId }),    // optional, see §4
});
```

It runs `trash()`, and when the outcome is `trashed` records one entry whose
`undo` calls `restoreTrash(sourceId, entryId)` and whose `redo` re-runs `trash()`
and **reassigns the captured `entryId`** (a redo mints a new ledger row; without
this a second undo would restore a consumed entry and take the typed 404). A
`trashed: false` outcome records nothing — honest, not silent. A restore that
404s (the user emptied the Trash dialog meanwhile) throws
`UndoRedoThunkError` — loud, per the repo's fail-loudly rule.

The seam takes no toast and no navigation of its own: it depends only on
`undo-redo` + `endpoints` + its own core (no `infra → shell` inversion).

**Server:** `deleteBlocksSubtree` already mints the entry ids — it just discards
them, returning `{ trashed: boolean }`. Widen to
`{ trashed: true; entryIds: string[] } | { trashed: false }`; a single page root
yields exactly one entry (leftovers fold into the first), so
`handle-delete-block` maps it to one `TrashOutcome`. `deleteBlock`
(`core/endpoints.ts:110`) gains `response: TrashOutcomeSchema`.

**Also fix the leaked id:** `PAGES_TRASH_SOURCE` is private to the server
(`server/internal/trash-blocks.ts:19`) while the web re-declares
`const SOURCE_ID = "pages"` (`pages-trash.tsx:33`). Move the constant to
`page/editor/core` and have both sides import it — one name per concept.

### 4. The delete button, and the open page

`DeletePageAction` loses the dialog, `countDescendants`, and the loading gate
(~60 lines deleted) and becomes a single call to the seam.

Deleting the page currently open in the detail pane would leave the pane
rendering a page that is no longer in the tree, so the action navigates the pane
back to the Pages landing surface when the deleted subtree contains the open
`pageId`; the `onUndo` hook re-opens the restored page, so Cmd+Z puts the user
back exactly where they were.

**Toast:** with the dialog gone there is no signal that anything happened or that
it is reversible, so raise `showToast({ description: "Page moved to trash", action: … })`.
`ToastArgs` is `{title, description, variant}` today and the wrapper never
forwards sonner's `action` option — so add an optional
`action?: { label: string; onClick: () => void }` to `ToastArgs` and pass it
through in `show-toast.tsx`. Small, generic, and the natural home for the
affordance (the Undo button just calls the tab's `undo()`).

## Files

**Primitive / platform**
- `plugins/apps-core/plugins/tab-surface/web/components/tab-surface.tsx` — mount `<UndoRedoProvider>` + `useUndoRedoShortcuts()`
- `plugins/primitives/plugins/undo-redo/web/internal/{stack.ts,store.ts}` — `scope` + `dropScope`
- `plugins/primitives/plugins/undo-redo/web/internal/use-scoped-undo-redo.ts` — **new**
- `plugins/primitives/plugins/undo-redo/web/index.ts` + `CLAUDE.md` — export + document the scope rule
- `plugins/shell/plugins/toast/{core/index.ts,web/internal/show-toast.tsx}` — optional `action`

**Trash seam**
- `plugins/infra/plugins/trash/core/schemas.ts` — `TrashOutcome` / `TrashOutcomeSchema`
- `plugins/infra/plugins/trash/web/{index.ts,internal/use-undoable-trash.ts}` — **new barrel**
- `plugins/infra/plugins/trash/CLAUDE.md` — document the seam

**Pages / editor**
- `plugins/page/plugins/editor/core/endpoints.ts` — `deleteBlock` response
- `plugins/page/plugins/editor/core/` — export `PAGES_TRASH_SOURCE`
- `plugins/page/plugins/editor/server/internal/trash-blocks.ts` — return `entryIds`
- `plugins/page/plugins/editor/server/internal/handle-delete-block.ts` — return the outcome
- `plugins/page/plugins/editor/server/internal/handle-bulk-delete-block.ts` — follow the widened return type
- `plugins/page/plugins/editor/web/components/block-editor.tsx` — drop both providers + shortcuts call
- `plugins/page/plugins/editor/web/block-editor-context.tsx:553` — `useScopedUndoRedo()`
- `plugins/apps/plugins/pages/plugins/page-tree/web/components/delete-page-action.tsx` — rewrite
- `plugins/apps/plugins/pages/plugins/trash/web/components/pages-trash.tsx` — use the shared constant

No schema change ⇒ **no migration**. The `deleteBlock` response is additive.

## Reuse (do not rebuild)

`deleteBlocksSubtree` / `untrashBlocks` / `purgeTrashedPages`
(`page/editor/server/internal/trash-blocks.ts`) — the whole soft-delete +
restore engine already exists and is tested. `restoreTrash` / `purgeTrash` /
`trashEntriesResource` (`infra/trash/core`). `handle-patch-blocks.ts` already
un-trashes on upsert, so the editor's *in-page* page-delete undo works — the
sidebar is the only path that bypasses it.

## Verification

1. `./equin build`, open `http://att-1783849962-gu0d.localhost:9000/pages`.
2. Scripted Playwright (`e2e/screenshot.mjs` as the base): create a page with a
   sub-page → delete it from the sidebar row → assert **no dialog**, the row is
   gone, the toast shows → press `Cmd+Z` → assert the page **and its sub-page**
   are back in the tree. Then `Cmd+Shift+Z` → gone again → `Cmd+Z` → back (proves
   the redo re-trash / new-entry-id path).
3. `query_db`: `select id, deleted_at, trash_entry_id from page_blocks where …`
   — flagged after delete, cleared after undo; `select count(*) from trash_entries`
   — one row after delete, zero after undo.
4. Cross-check the shared stack: type in the page body, then delete a page in the
   sidebar, then Cmd+Z twice — the delete undoes first, then the text edit. One
   chronological history.
5. Regression: edit page A, navigate to page B, Cmd+Z — must **not** touch A
   (scope drop). Delete a page, navigate to another page, Cmd+Z — must still
   restore it (unscoped entry).
6. `bun test plugins/primitives/plugins/undo-redo` (new `dropScope` cases) and
   `bun test plugins/infra/plugins/trash`.
7. `./equin check`.
