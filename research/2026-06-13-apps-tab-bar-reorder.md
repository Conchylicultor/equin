# App tab bar: drag-to-reorder tabs

## Context

The app tab bar (`plugins/apps/`) lets users open (+), switch, and close tabs,
but tabs **cannot be reordered** — they sit in fixed insertion order. Once more
than a couple of tabs are open, a user can't group/arrange them, which makes a
multi-tab workflow awkward. This plan adds horizontal drag-to-reorder by reusing
the existing `SortableList` primitive.

### Scope notes (verified against current code)

- **Close already exists** — `closeTab` is fully implemented in
  `plugins/apps/web/internal/use-tabs.tsx:320` (never-zero guard + neighbor
  focus), and the `×` button is rendered in
  `plugins/apps/web/components/app-tab-bar.tsx:162` (visible on hover, and
  always partially visible on the active tab). The original task listed "cannot
  be closed", but that is no longer accurate. **No close work is needed.** If
  the real complaint is *discoverability* of the `×`, that's a separate UI tweak
  — out of scope here unless requested.
- **Keyboard shortcuts: deferred** per the user ("no shortcut for now"). The
  groundwork (`defineShortcut`, the `tabsNavigator` module-pointer precedent)
  exists if we revisit later, but nothing is built now.

So this plan is exactly one feature: **horizontal drag-to-reorder**.

## How tabs work today (relevant facts)

- Tab state is **purely client-side**: an in-memory `Tab[]` array in
  `TabsProvider` (`use-tabs.tsx`), persisted to `sessionStorage` via
  `savePersistedTabs(tabs, focusedTabId)` (`tabs-store.ts:74`). No DB, no server,
  no schema, no migration.
- **Array index *is* the display order.** New tabs are appended; closed tabs are
  filtered out. There is no `rank` field — reorder just mutates array order.
- `savePersistedTabs` already serializes the array in its current order, so
  **reorder persists for free** — no persistence changes needed.
- `SortableList` (`plugins/primitives/plugins/sortable-list/web`) already
  supports `orientation="horizontal"` and uses a `PointerSensor` with a **4px
  activation distance** (`sortable-list.tsx:51`). That means the **whole chip
  can be draggable while clicks (activate / close) still fire** — no separate
  drag handle is required. Reference consumer:
  `plugins/layouts/plugins/miller/web/components/miller-columns.tsx`.

## Implementation

Two files change. No new plugin, no server, no schema, no migration.

### 1. `plugins/apps/web/internal/use-tabs.tsx` — add a `moveTab` action

Add to the `TabsApi` interface:

```ts
/** Reorder: move the tab `activeId` to the position of `overId`. */
moveTab(activeId: string, overId: string): void;
```

Implement inside `TabsProvider` (mirrors the existing array-mutation actions;
**does not touch focus or store liveness** — reordering keeps the same focused
tabId, just changes position):

```ts
const moveTab = useCallback((activeId: string, overId: string) => {
  const prev = tabsRef.current;
  const from = prev.findIndex((t) => t.tabId === activeId);
  const to = prev.findIndex((t) => t.tabId === overId);
  if (from < 0 || to < 0 || from === to) return;
  const next = [...prev];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  tabsRef.current = next;
  setTabs(next);
  persist();
}, [persist]);
```

Add `moveTab` to the `useMemo` `api` object + its dependency array
(`use-tabs.tsx:359`).

> The existing `useEffect` that re-subscribes route listeners on `tabs` change
> (`use-tabs.tsx:203`) handles the new array harmlessly — same stores,
> re-subscribed.

### 2. `plugins/apps/web/components/app-tab-bar.tsx` — wrap chips in `SortableList`

- Import `SortableList`, `SortableItem` from
  `@plugins/primitives/plugins/sortable-list/web` (legal runtime barrel).
- Pull `moveTab` from `useTabs()`.
- Wrap the rendered chip strip (the `resolved.map(...)` inside `containerRef`)
  in a `SortableList`, and each chip in a `SortableItem`:

```tsx
const tabIds = resolved.map(({ tab }) => tab.tabId);
// ...
<div ref={containerRef} className="flex min-w-0 flex-1 items-center gap-2xs overflow-x-auto [&::-webkit-scrollbar]:hidden">
  <SortableList
    items={tabIds}
    onMove={(activeId, overId) => moveTab(activeId, overId)}
    orientation="horizontal"
    disabled={tabs.length < 2}
  >
    {resolved.map(({ tab, app, label }) => {
      const active = tab.tabId === focusedTabId;
      return (
        <SortableItem
          key={tab.tabId}
          id={tab.tabId}
          className={(s) => cn("min-w-0", s.isDragging && "opacity-50")}
        >
          {() => (
            <TabChip
              appId={tab.appId}
              icon={app.icon}
              label={label}
              active={active}
              collapsed={collapsed && !active}
              onActivate={() => focusTab(tab.tabId)}
              onClose={() => closeTab(tab.tabId)}
            />
          )}
        </SortableItem>
      );
    })}
  </SortableList>
</div>
```

Notes / why this is safe:

- **No drag handle** — the whole chip is draggable; the 4px activation distance
  means `onActivate` (click) and `onClose` (× click) still fire. Mirrors
  browser tab UX.
- **`SortableList`/`SortableContext`/`DndContext` add no DOM wrapper** — only the
  per-item `SortableItem` div. So `containerRef` still directly contains the
  flex items, and `gap-2xs` spacing is preserved.
- **The hidden `measureRef` overflow strip is untouched** — it renders
  `ChipShell` directly and drives the collapse decision off container width, not
  off the rendered children, so wrapping the visible chips in `SortableItem`
  doesn't perturb the collapse math.
- `disabled={tabs.length < 2}` disables the sensor when there's nothing to
  reorder.

## Critical files

- `plugins/apps/web/internal/use-tabs.tsx` — add `moveTab` action + `TabsApi` field.
- `plugins/apps/web/components/app-tab-bar.tsx` — wrap chips in `SortableList`/`SortableItem`.
- (reference only) `plugins/primitives/plugins/sortable-list/web/internal/sortable-list.tsx`,
  `plugins/layouts/plugins/miller/web/components/miller-columns.tsx`.

## Verification

1. `./equin build` (regenerates plugin docs so the `plugins-doc-in-sync`
   check stays green after the new `sortable-list` import).
2. Open the app at `http://<worktree>.localhost:9000`, open 3+ tabs (`+`).
3. **Drag** a tab left/right by its chip body → it reorders with smooth
   displacement; the dragged chip shows `opacity-50`.
4. Confirm a single click on a tab still **activates** it (no drag), and the `×`
   still **closes** it (both fire because of the 4px drag threshold).
5. **Reload the browser tab** → the new order is preserved (sessionStorage via
   the unchanged `savePersistedTabs`).
6. With only one tab open, dragging does nothing (`disabled`).

A scripted Playwright drag (`page.dragAndDrop` between two `[data-app-tab]`
chips, then reload and assert order) can automate step 3 + 5 if desired.
