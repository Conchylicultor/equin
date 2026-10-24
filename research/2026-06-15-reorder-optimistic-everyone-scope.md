# Optimistic "everyone" scope for reorder

## Context

Today the reorder plugin's **everyone** scope (staged defaults) is deliberately
decoupled from the inline display. When a user reorders in everyone mode,
`commitTree` POSTs the materialized tree to the `reorder_staged_default` table
(`stage.mutate`) and **never touches the user's config layer** — so the slot
keeps showing the current effective order. The staged proposal only surfaces in
the Review pane. There is no inline feedback, no commit affordance at the point
of editing, and no signal that an uncommitted everyone-default exists.

Desired workflow:

1. Enter edit mode, select **everyone** scope.
2. Drag → the slot updates **immediately** (optimistic) to the staged order.
3. The slot keeps showing the new (uncommitted) order persistently, and the
   reorder pen button shows an **uncommitted status dot**.
4. On **exiting** edit mode (pen toggle off / Esc) while uncommitted everyone
   edits exist → a **popover anchored to the pen button** offers **Cancel /
   Commit**.
   - **Commit** → triggers the existing background land job (apply-all).
   - **Cancel** → discards the staged set (discard-all).

This makes everyone-scope editing feel as direct as personal scope, while
keeping the human-review safety of a commit step.

### Design decisions (confirmed)

- **Commit/Cancel act on the whole uncommitted staged set** (apply-all /
  discard-all). Per-slot control remains in the Review pane.
- **Surfacing**: a status dot on the reorder pen button + inline staged order in
  the slots. No per-slot badge.
- **Exit prompt**: a popover anchored to the pen button (dismissable; dismissing
  leaves edits staged).

### Key existing infra (reused, not modified)

- `optimistic-mutation` primitive — `useOptimisticResource` (consume only).
  `plugins/primitives/plugins/optimistic-mutation/web`.
- `stagedReorderDefaultsResource` — `mode: "push"` live resource, already gets a
  **confirming WS push** via `stagedReorderDefaultsResource.notify()` in the
  stage handler. `plugins/reorder/plugins/staging/{shared,server}`.
- Apply path (land job) — `POST /api/reorder/staged-defaults/apply-all`
  (`applyAll`) → `landDefaultsJob`. `plugins/reorder/plugins/staging/server`.
- config_v2 effective order — `useConfig(descriptor)` (read only, unchanged).

## Architecture

The crux: in everyone-relevant situations the slot's displayed `items` must come
from the **optimistically-overlaid staged tree** when one exists for that slot,
falling back to the config_v2 effective order otherwise. The staged tree is a
single array resource shared by all slots, so a **single app-level provider**
owns the optimistic overlay and exposes per-slot reads + a dispatch.

### New: staged-defaults web provider (in the staging plugin)

`plugins/reorder/plugins/staging/web/` — add a context provider that owns the
optimistic overlay so all slots share one pending-ops layer (avoids N
independent overlays racing on the same resource cache key):

```ts
// internal/staged-defaults-context.tsx
const { data, dispatch } = useOptimisticResource({
  resource: stagedReorderDefaultsResource,
  apply: (rows, vars) => upsertRow(rows, vars),   // last-write-wins by slotId, mirrors DB PK
  mutate: (vars) => stageReorderDefault POST,
  isConfirmedBy: (rows, vars) =>
    rows.some(r => r.slotId === vars.slotId && deepEqual(r.items, vars.items)),
});
```

Exposed hooks/values:

- `useStagedTree(slotId): ReorderTree | undefined` — the optimistic staged tree
  for a slot (undefined when none).
- `useStageDefault(): (slotId, pluginId, items) => void` — dispatches the
  optimistic upsert + POST. Replaces the raw `useStageReorderDefault().mutate`
  call in the middleware's everyone branch.
- `useStagedSlotIds(): string[]` / `useHasStagedDefaults(): boolean` — drive the
  dot + popover + provider gating.

Mount point: the provider must wrap the app surface where reorderable slots and
the action bar both live. Confirm exact root during implementation (the reorder
provider / app shell root that already wraps both the slots and the
edit-mode/action-bar host). It is a thin context; one mount.

> Boundary note: the middleware (`plugins/reorder/web`) consuming the staging
> sub-plugin's web barrel is a legal parent→child import
> (`@plugins/reorder/plugins/staging/web`). The staging plugin already depends on
> nothing in the parent, so no cycle.

### Changed: inline display source (`dnd-list-middleware.tsx`)

`plugins/reorder/web/internal/dnd-list-middleware.tsx` — the load-bearing
middleware. Two edits:

1. **Display source.** Today:
   ```ts
   const { items, setConfig } = useReorderConfig(descriptor);
   const state = useMemo(() => applyTree(contributions, items), [contributions, items]);
   ```
   New: prefer the staged tree when present, else config_v2 effective order.
   ```ts
   const stagedTree = useStagedTree(slotId);            // from staging provider
   const effectiveItems = stagedTree ?? items;          // staged preview wins while uncommitted
   const state = useMemo(() => applyTree(contributions, effectiveItems), [contributions, effectiveItems]);
   ```
   This means: once an everyone edit is staged, the author sees the proposed
   order inline (a preview of the default), with the uncommitted dot signalling
   it is not yet live. **Tradeoff:** if the author also has a personal override,
   the staged everyone preview takes display precedence while uncommitted — this
   is intentional (you are previewing the proposal you are actively editing).

2. **Everyone commit path.** Replace the raw stage mutation in `commitTree` with
   the provider's optimistic dispatch:
   ```ts
   if (scope === "everyone") {
     stageDefault(slotId, reorderPluginIdForSlot(slotId), tree);  // optimistic
     return;
   }
   setConfig("items", tree);
   ```
   The personal branch is unchanged.

> Note: `materializeTree` already derives the new tree from the **currently
> displayed** list. Because the displayed list will now be the staged tree in
> everyone scope, sequential drags compose correctly (each drag re-materializes
> from the previously-staged order).

### New: discard-all endpoint (staging server)

`plugins/reorder/plugins/staging/server/` — add `discardAllStagedDefaults`
mirroring the existing `applyAll`/per-slot discard:

- Endpoint: `DELETE /api/reorder/staged-defaults` (no `:slotId`) — `DELETE FROM
  reorder_staged_default`, then `stagedReorderDefaultsResource.notify()`.
- Register in the staging server barrel alongside the existing handlers.
- Web hook `useDiscardAllStagedDefaults()` in the staging web barrel.

(The per-slot `apply` / `discard` and `apply-all` endpoints already exist and are
reused as-is. Commit = `applyAll`.)

### New: exit popover + dot (edit-mode plugin)

`plugins/reorder/plugins/edit-mode/web/` — extend the pen button host. No change
to the load-bearing `edit-mode-store` exit semantics is required: we observe
state rather than intercept `setEditMode`.

- **Dot:** the pen button renders a `StatusDot` (from
  `@plugins/primitives/plugins/status-dot/web`) when `useHasStagedDefaults()` is
  true. Always visible (in and out of edit mode) so the uncommitted state is
  discoverable.
- **Exit popover:** a small component tracks the previous `useEditMode()` value.
  On the `true → false` transition, if `useHasStagedDefaults()`, it opens a
  `Popover` (`@plugins/primitives/plugins/popover/web`) anchored to the pen
  button with two actions:
  - **Commit** → `applyAll.mutate({})` then close. (Land job runs in background;
    on completion the job clears staged rows + notifies, the dot disappears, and
    the slot falls back to the now-committed config_v2 order.)
  - **Cancel** → `useDiscardAllStagedDefaults().mutate({})` then close. (Staged
    rows deleted, dot disappears, slots revert to prior effective order.)
  - Dismissing the popover (outside-press/Esc) leaves edits staged (dot
    persists).

> Why observation over interception: `setEditMode(false)` synchronously resets
> scope to `"personal"` before notifying listeners, so a component cannot see
> `scope === "everyone"` at exit. But the popover trigger does **not** need
> scope — it triggers purely on "edit mode just closed AND uncommitted staged
> edits exist," which is scope-independent and avoids modifying the load-bearing
> store.

## Files

**New**
- `plugins/reorder/plugins/staging/web/internal/staged-defaults-context.tsx` —
  optimistic provider + `useStagedTree` / `useStageDefault` /
  `useHasStagedDefaults` / `useStagedSlotIds`.
- `plugins/reorder/plugins/staging/server/internal/` — `discardAll` handler +
  endpoint def (co-locate with existing handlers).
- `plugins/reorder/plugins/edit-mode/web/internal/exit-commit-popover.tsx` —
  exit popover + pen-button dot wiring.

**Modified**
- `plugins/reorder/web/internal/dnd-list-middleware.tsx` — display source +
  everyone dispatch (load-bearing; this feature is the explicit reason).
- `plugins/reorder/plugins/staging/web/index.ts` — export provider + hooks +
  `useDiscardAllStagedDefaults`.
- `plugins/reorder/plugins/staging/server/index.ts` — register discard-all
  endpoint.
- `plugins/reorder/plugins/edit-mode/web/internal/pen-button.tsx` (+ barrel) —
  render the dot + mount the exit popover.
- Provider mount root (reorder web app-shell root that wraps slots +
  action bar) — wrap with `StagedDefaultsProvider`. Confirm exact file in impl.

**Unchanged / read-only**
- `optimistic-mutation`, `config_v2`, `stagedReorderDefaultsResource` loader,
  `landDefaultsJob`, the Review pane (`review/reorder-defaults`).

## Tradeoffs / notes

- **Staged preview takes display precedence over a personal override while
  uncommitted.** Intentional: the author is previewing the default they are
  proposing. Once committed (or cancelled) the normal config_v2 precedence
  (personal > git) resumes. Documented so it is not surprising.
- **Global staged set.** The table is keyed by `slotId` (last-write-wins, global
  to the worktree), so commit/cancel acting on the whole set matches the data
  model. Per-slot granularity stays in the Review pane.
- **No new polling / timers** — entirely live-state + WS push driven.
- **Load-bearing touch** is confined to `dnd-list-middleware.tsx` (display
  source + dispatch swap); `edit-mode-store` is observed, not modified.

## Verification

1. `./equin build` (from the worktree dir).
2. Scripted Playwright run (`bun e2e/screenshot.mjs`) against
   `http://<worktree>.localhost:9000`:
   - Enter edit mode, switch scope to **everyone**, drag an item in a
     reorderable slot (e.g. a sidebar/toolbar slot). Assert the slot order
     changes **immediately** (before any reload) — optimistic.
   - Assert the pen button shows the status dot.
   - Reload the page → assert the staged order **persists** (driven by the
     resource, not local state) and the dot remains.
   - Exit edit mode (Esc) → assert the Cancel/Commit popover appears anchored to
     the pen button.
   - **Cancel** → assert order reverts to the prior effective order, dot gone,
     and `query_db` shows `reorder_staged_default` empty.
   - Re-stage, **Commit** → assert the land job runs (Review pane / push), staged
     rows clear, dot gone, and the committed order is now the effective default.
3. `query_db` against `reorder_staged_default` to confirm row lifecycle
   (upsert on drag → delete on commit/cancel).
4. Confirm personal scope is unaffected (drag in personal scope still writes
   config_v2 and shows no dot/popover).
5. `./equin check` (boundaries, type-check, plugins-doc-in-sync).
