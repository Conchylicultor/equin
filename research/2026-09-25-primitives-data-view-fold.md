# DataView fold: "… N more" per section

## Context

The conversation sidebar's Queue list grows without bound: old conversations drown the live ones. The user wants rows **older than 30 days hidden** while every group **still appears** (even when all of its rows are hidden), each ending with a `… N more` line that expands the rest in place.

Nothing about this is conversation-specific, so it ships as a generic DataView per-view setting — a *softer filter*: a filter removes rows, a fold keeps them counted and one click away. The rule reuses the existing `FilterGroup` language, so any field type's operators work (`is-within-past`, enum `is-any-of`, …) and the editor, the summary text and the persistence format already exist.

Queue default (user decision): fold everything whose **last activity** (`updatedAt`) is older than 30 days, **except** the Pinned and Disconnected sections.

## Model

```ts
// core/internal/types.ts
/** Rows NOT matching `keep` fold behind a "… N more" line at the end of their section. */
export interface FoldRule { keep: FilterGroup }

interface ViewState { …; fold?: FoldRule }          // persisted in the view row, like filter/groupBy

interface DataViewSection<TRow> {
  …                                                  // `count` stays the TOTAL (header "Done 42")
  /** Present only when ≥1 entry fails `keep`. `entries` = kept rows while closed, all rows while open. */
  fold?: { hidden: number; open: boolean };
}

interface DataViewRenderProps { …; openFolds?: ReadonlySet<string>; setFoldOpen?: (sectionKey: string, open: boolean) => void }
```

The ungrouped implicit section (`key === null`) uses a sentinel fold key (`UNGROUPED_FOLD_KEY`) exported from core.

Naming note: `grouped-sections.test.tsx` already uses "Fold" as a label for the tree's fold-children header action. That's unrelated. Keep test descriptions and doc prose explicit ("fold line", "folded rows") so the two are never confused.

## Rules

1. **Search suspends folding.** Non-empty `query` → fold ignored (a match must never hide behind "…").
2. **The selected row is never folded.** `entry.key === selectedRowId` (or one of an aggregate entry's members) counts as kept.
3. **A group whose rows are all folded still renders**: header, then the fold line only. Partition runs before fold, so the section exists.
4. **Folded rows are pulled from wherever they sort.** The line always sits at the end of the section; opening it re-inserts them in sorted order.
5. **Open state is ephemeral**: in-memory in the DataView body, reset on view switch or reload. It isn't saved to config: a fold re-closes after a reload.
6. **Server-paged sources**: while fold is active, no fold is open, and the **last loaded row is folded**, the infinite-scroll sentinel is not rendered, so it stops auto-fetching pages that would only land behind "…". Opening any fold brings the sentinel back.
7. **Fold runs after aggregation.** It counts the rows the user sees: an aggregate's representative decides.

## Implementation

### Primitive: `plugins/primitives/plugins/data-view`

- **`core/internal/types.ts`**: `FoldRule`, `ViewState.fold`, `DataViewSection.fold`, render props `openFolds` / `setFoldOpen`, `UNGROUPED_FOLD_KEY`. Export them from the `core` barrel.
- **New `web/internal/fold-sections.ts`**: pure `foldSections(sections, { isKept(entry), openKeys })`, shaped like `aggregateSections` / `orderSectionsByRank` in `use-data-view-sections.ts`. `isKept` is built from `evaluateNode(keep, row, fields, resolveOperatorSet)` (`web/internal/evaluate-filter.ts`, no clock plumbing needed) OR the selected row.
- **`web/internal/use-data-view-sections.ts`**: new opts `{ openFolds, selectedRowId }`; read `state.fold`; call `foldSections` in the final memo after `aggregateSections`.
- **`web/internal/use-data-view-model.ts`**: add `readFold` / `setFold`, mirroring `readGroupBy` / `setGroupBy` (merge write, omit the key when cleared). `stateFor` adds `fold`, and `ReadyViewModel` gains `setFold`. view-core stays ignorant (the `view` blob is opaque; no schema change).
- **`web/components/data-view-body.tsx`**:
  - Keep `openFolds` in `useState`, keyed by the active view id.
  - `effectiveState.fold = activeState.query ? undefined : activeState.fold`. Compute it before the server branch zeroes `query`; the server spread keeps `fold` just like `visibleFields`.
  - Thread `openFolds` / `setFoldOpen` into render props.
  - Rule 6: gate `<InfiniteScrollFooter>` (currently always rendered for server sources) on `!(fold && openFolds.size === 0 && lastRowFolded)`.
- **New `web/components/fold-line.tsx`** (exported): `<FoldLine fold onToggle />`. A muted caption row on the `rail-follow` inset, a real `<button>`. Closed it reads `… N more`, open it reads `Show less`. Tooltip: `summarizeFilter(keep, …)` (`web/internal/summarize-filter.ts`).
- **`web/internal/grouped-sections.tsx`**: after `children(section)`, append `<FoldLine>` when `section.fold` is set, inside `CollapsibleContent` so a collapsed group hides it too. Every grouped view gets it for free.
- **Views**: pass `openFolds` / `selectedRowId` to `useDataViewSections`, and append `<FoldLine>` in the **ungrouped** fast path:
  - `plugins/list/web/components/list-view.tsx`
  - `plugins/gallery/web/components/gallery-view.tsx`
  - `plugins/icons/web/components/icons-view.tsx`
  - `plugins/table/web/components/table-view.tsx`: the table builds its own section chrome, so the fold line there is a `col-span-full` row after each section's rows (and at the end in the ungrouped path).

  All four views must render the line: if one doesn't, its rows would disappear silently.
- **Settings UI, new `web/components/settings/fold-control.tsx`**: a `DataViewSlots.Setting` of scope `view`, modelled on `group-by-control.tsx`.
  - It shows the rule summary with a Clear action, and opens the existing filter editor to edit `fold.keep`.
  - The filter builder (`use-filter-editor.ts`) is hard-wired to `useDataViewControls().filter`. Wrap the fold editor in a nested `DataViewControlsProvider` that overrides only `filter` with `useFilterController(fields, fold?.keep ?? null, keep => setFold(...))` (`web/internal/use-filter-controller.ts`).
  - Don't render the preset section or "Save as preset" in that nested editor: filter presets belong to the view's filter.
  - Register the setting in `web/index.ts`.
- **`CLAUDE.md`**: a short "Fold" section (semantics, rules 1–7, the renderer's obligation to show `FoldLine`).

### Conversations

- **`plugins/conversations/plugins/all-conversations/core/internal/fields.ts`**: add `{ id: "updatedAt", label: "Updated", type: "date" }` to `CONVERSATION_FIELDS`. Leave it **not sortable**: `updatedAt` is bumped up to ~1/s, and the History revision tick deliberately ignores it, so a server keyset sort on it would go stale.
  - Add the matching `fieldValue` case in `web/internal/fields.tsx`.
  - Add `updatedAt: { col: conversations.updatedAt, type: "date" }` to `server/internal/column-map.ts`, so a History filter on it compiles to SQL.
- **`config/conversations/conversations-view/data-view/conversations-sidebar.jsonc`**: the queue row gets its default fold (keep the `@hash` header however the config tooling maintains it):
  ```jsonc
  "view": { "type": "list", "groupBy": "section", "fold": { "keep": {
    "kind": "group", "id": "fold-keep", "conjunction": "or", "children": [
      { "kind": "rule", "id": "recent", "fieldId": "updatedAt", "operatorId": "is-within-past", "value": { "amount": 30, "unit": "day" } },
      { "kind": "rule", "id": "always", "fieldId": "section", "operatorId": "is-any-of", "value": ["pinned", "disconnected"] }
    ] } } }
  ```
  Verify the `is-within-past` operand shape against `RelativeRangeInput` / `withinRange` (`plugins/fields/plugins/date/plugins/filter/core/internal/date-anchor.ts`). The `section` enum field is `filterable: false`, but that flag only gates search (`use-flat-rows.ts`). `evaluateNode` still resolves the enum operator set.

## Tests

- **`web/internal/fold-sections.test.ts`** (bun, pure, modelled on `use-data-view-sections.test.ts`):
  - kept/hidden split and `count` unchanged
  - an all-folded section keeps its header
  - the selected row is kept
  - open fold → all entries in sorted order
  - no failing row → no `fold` field
  - an aggregate entry decided by its representative
- **`web/__tests__/grouped-sections.test.tsx`**: the fold line renders with its count; clicking it calls `setFoldOpen`; a collapsed section hides it.
- **Body / server source** (modelled on `use-server-data-source.test.tsx`): the sentinel is absent while the tail is folded and returns after a fold opens; search suspends the fold.

## Verification

1. Run `./equin test plugins/primitives/plugins/data-view`.
2. Run `./equin build` in the background, then `./equin await`.
3. Screenshot the sidebar: `./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --path /agents --out /tmp/fold`. Check that the Done section ends in `… N more` and that clicking it reveals the older rows (`--click "more"`).
4. Check that Pinned and Disconnected never fold, that searching shows old matches, and that opening an old conversation by URL keeps it visible.
5. Check the gear → Fold rows editor: edit, then clear, and confirm the list updates.
6. Caveat to check: if this worktree already has a saved Queue view row, the authored default may not apply. Confirm how view-core merges authored defaults with saved rows, and note the result in the hand-off.
