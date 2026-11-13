# DataView quick filters

## Context

The deploy Sessions tab used to have two segmented controls — *whose visits*
(Visitors / You / All) and *range* (Today / 7d / 30d). Moving Sessions onto a
`DataViewSwitcher` (4c4dede38f) turned both into rules inside every saved
view's filter (`owner is false`, `startedAt is-within-past 7 day`), reachable
only through the Filter panel. The user wants the one-click toggles back, as a
DataView feature any surface can use.

## Design

A **quick filter** is a surface-declared, one-field segmented control in the
toolbar whose options each *are* a top-level rule of the active view's filter
(or "no rule on this field"). It is a view onto the filter tree, never a second
filter: the selected option is DERIVED from the active filter, and picking one
rewrites the filter through the same `FilterController.setFilter` the Filter
panel uses. So the two can never disagree, a quick pick is a draft of the view
under `viewEdits: "draft"` (and rides in the URL), and the Filter panel's count
includes it.

### Types (`data-view/core`)

```ts
interface QuickFilterOption {
  id: string;
  label: string;
  /** The rule this option puts on the field; null = no rule on it. */
  rule: { operatorId: string; value?: unknown } | null;
}
interface QuickFilter {
  id: string;
  /** The field every option's rule is on. */
  fieldId: string;
  /** Accessible label of the segmented control ("Whose visits"). */
  label: string;
  options: readonly QuickFilterOption[];
}
```

`DataViewProps.quickFilters?: readonly QuickFilter[]` (threaded through
`DataViewSwitcher` like the other surface props).

### Pure logic (`web/internal/quick-filter.ts`, unit-tested)

- `activeQuickOption(filter, qf)` → the option id, or `null` when the tree holds
  something no option names (a hand-edited rule, a nested rule on the field, an
  `or` root with the field). Match: root conjunction `and` (or root has no rule
  on the field), the field's top-level rules are exactly one rule equal (operator
  + deep-equal value) to an option's rule — or none, matching the `rule: null`
  option.
- `applyQuickOption(filter, qf, option)` → the new tree: drop the field's
  top-level rules, append the option's rule (reusing the dropped rule's id so
  the edit is a minimal draft diff; else a fresh id). An `or` root is wrapped in
  an `and` group first. Empty result → `null`.

### Rendering

- `ToolbarParts.quickFilters: ReactNode` (null when none declared): one
  `SegmentedControl` (`css/toggle-chip`) per quick filter, built by the toolbar
  host from `useDataViewControls().filter`. No option selected when
  `activeQuickOption` is null (the hand-edited state reads as "custom").
- Default arrangement (`PillsToolbar`) places them after the views pill; the
  compact fold puts them inside the options popover. A custom arrangement places
  the part where it wants (Sessions: in the single toolbar row, after the views).

### Sessions

`sessions-section.tsx` passes:

- `owner`: Visitors (`is false`) / You (`is true`) / All (null)
- `startedAt`: 24h / 7d / 30d (`is-within-past {amount, unit:"day"}`) — "24h",
  not "Today": the relative operator is a rolling window.

`sessionsToolbar` renders `quickFilters` after the view strip. Saved views keep
their existing `r-visitors` / `r-range` rules (they match Visitors / 7d).

## Files

- `plugins/primitives/plugins/data-view/core/internal/types.ts` (+ toolbar-arrangement `ToolbarParts`)
- `plugins/primitives/plugins/data-view/web/internal/quick-filter.ts` (+ test)
- `plugins/primitives/plugins/data-view/web/components/toolbar/{data-view-toolbar,pills-toolbar,compact-controls}.tsx`
- DataView / DataViewSwitcher prop threading; data-view CLAUDE.md section
- `plugins/apps/plugins/deploy/plugins/analytics/plugins/sessions/web/components/{sessions-section,sessions-toolbar}.tsx`, sessions CLAUDE.md

## Verification

- `./equin test plugins/primitives/plugins/data-view` (quick-filter unit tests).
- `./equin build`; screenshot the Sessions tab: toggles show Visitors + 7d
  selected on All; clicking You / 30d changes the list and count, the URL
  carries the draft, the Filter panel shows the rewritten rules; editing the
  owner rule by hand in the panel deselects the segment.

## v1.1 (after review)

- Quick filters sit on a row of their own under the toolbar's pills row, not
  between the views and tools pills.
- Sessions drops the range filter (and the saved views' 7-day rule): the list
  pages back through time as it scrolls. It gets a device filter instead
  (Any device / Desktop / Mobile / Tablet).
- Sessions' toolbar reuses `PillsToolbar` (the standard rendering) between its
  summary line and axis row, instead of a hand-laid row.
