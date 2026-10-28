# DataView fold by count — `fold.limit`

Task: task-1791548298-id5g14 ("DataView views cannot cap how many rows they show").

## Context

A DataView view can't show just its first N rows. The Pages sidebar's Recent
section (`config/apps/pages/page-tree/pages-sidebar.jsonc`) gets around this with
a 7-day `is-within-past` filter, so how long it is depends on how much was edited
that week. The user wants the cap to be part of the existing **fold**
(`ViewState.fold`, `FoldRule`). Fold already keeps rows counted and one click
away behind a "… N more" line. Today it folds only by a rule (`fold.keep`), not
by count.

Outcome: `fold.limit: N` shows each section's first N entries in the view's
current order, and the rest go behind the fold line. It works with `fold.keep`,
works per section (group-by, declared sections, the sections chrome), is
suspended while a search is typed, and can be edited in the view's "Fold rows"
setting. Recent then uses it.

## Semantics

- **`FoldRule` becomes a union, so "fold nothing" can't be written** (rung 2):
  ```ts
  export type FoldRule =
    | { keep: FilterGroup; limit?: FoldLimit }
    | { keep?: undefined; limit: FoldLimit };
  ```
  `FoldLimit` is a positive integer. `readFold` rejects anything that isn't one.
- **How it combines with `keep`:** an entry stays visible when it passes `keep`
  (or there is no `keep`) **and** it is among the first `limit` such entries in
  its section. So "keep the recent ones, at most 10". Folding stays one pass in
  one place.
- **The selected row is never folded** (rule 2 still holds). It counts toward
  the limit while it is inside it. If it sits past the limit, it is shown as
  well, so a section can show `limit + 1` entries. Its position in the order
  stays the same.
- **Per section**: the limit counts each section's own `entries` after
  partition, manual order and aggregation. That is the same unit
  `section.count` uses, so an aggregate counts once. A nested group-by section
  limits its own rows. `section.count` stays the total, as before.
- **Order**: "first" means the order the section is drawn in: the view's sort,
  manual rank, or a live source's server order.
- **Search suspends it**: `effectiveFold` already drops the whole rule.
- **The fold line stays at the end** (rule 4). `hidden` counts every entry
  folded by either reason.

## Changes

### core — `plugins/primitives/plugins/data-view/core/internal/types.ts`
- `FoldRule` union and `FoldLimit` as above, with updated docs on `ViewState.fold`,
  `DataViewSection.fold` ("fails `keep` or falls past `limit`") and
  `DataViewFoldLines`.

### web pipeline — `web/internal/fold-sections.ts`
- Replace the per-entry `isKept` predicate with a per-section pass:
  `foldEntries(entries, { matchesKeep, limit, isSelected }) → boolean[]` (kept
  flags). `makeFoldKeep` becomes the per-entry part of that pass, and its
  selected/aggregate-member logic stays as it is.
- `foldSections` uses it. A tail is folded when the last entry's flag is false,
  so a declared section's paging hold (`canGrow: false`) also works for the
  limit: a section that already has `limit` rows loaded stops paging until its
  line is opened.
- `isTailFolded` (the host's paging gate for a non-sectioned paged view) needs
  the tail's position, not only its row. It changes to take the loaded paged
  entries of the tail's section and returns the tail's flag from `foldEntries`.
  `data-view-body.tsx` already partitions the loaded rows for `tailCollapsed`.
  It will partition once and share the result between both gates. Without a
  group-by there is one section of all paged rows.
- `use-data-view-sections.ts`: pass `fold.limit` alongside `matchesKeep`.
  `useRowFilter(fold?.keep ?? null…)` already handles a limit-only fold.

### persistence and helpers
- `use-data-view-model.ts` `readFold` / `setFold`: accept `limit` with or
  without `keep`. Clearing `keep` keeps a set `limit`, and the reverse. Both
  gone means the key is omitted. `setFold` keeps its signature.
- `canonical-view.ts`: `keep` may be absent.
- `body-state.ts` `fieldsReadByView`: `walk(fold?.keep)` already copes with
  absent. The fold-rule-error prune in `data-view-body.tsx` keeps `limit` when
  pruning empties `keep`.
- Summary (the fold line's tooltip, built in `data-view-body.tsx`): add a small
  `summarizeFold(fold, …)` in `fold-sections.ts`, giving
  `Showing the first 10`, `Folding all but: <keep>`, or
  `Folding all but the first 10 of: <keep>`. `FoldControl` uses it too.

### settings — `web/components/settings/fold-control.tsx`
- The "Fold rows" section gets a `ControlPanel.Setting` row: "Show first" with
  an inline number input (`fit="inline"`, the commit-on-blur/Enter `Input
  type="number" min={1}` from
  `tasks/reports-investigation/.../report-scope-section.tsx`), with empty meaning
  no limit. It writes `viewModel.setFold(id, { ...fold, limit })`.
- The existing Keep row writes `{ keep, limit }` so neither half wipes the
  other. "Clear fold" clears both.

### config — `config/apps/pages/page-tree/pages-sidebar.jsonc`
- Recent: drop the `recent-edited` 7-day rule, keep `recent-origin`, and add
  `"fold": { "limit": 10 }`. Update the comment: a fixed 10 most recently
  edited, the rest behind "… N more". `hideWhenEmpty` stays (it only hides when
  there are no user pages).

### docs
- `data-view/CLAUDE.md` § Fold: `limit` in the example, the composition and
  selected-row rules. `DESIGN.md` § Fold: why the limit is a fold and not a
  filter or a separate option (rows stay counted and reachable, one line, one
  settings section).

## Not changing
- The tree view and nested tables still ignore fold (`activeSupportsFold`).
  Recent is a `list`.
- No SQL `LIMIT`: fold runs on the client over loaded rows, and paging stops at
  a folded tail, so a live source never loads more than it shows plus one page.

## Verification
- `fold-sections.test.ts`: a limit-only fold (first N kept, `hidden` = rest);
  keep + limit (limit counts only kept entries); the selected row past the limit
  is shown, `limit+1`; per-section limits under a group-by; the open line shows
  all; aggregates count once; tail-folded/paging hold driven by the limit;
  `effectiveFold` still suspends.
- `use-data-view-sections.test.ts`: a limit fold through the full pipeline with
  manual order.
- jsdom test of `FoldControl`: setting and clearing the limit keeps `keep`.
- `./equin check`, `./equin build`, then the browser on
  `/pages`: Recent shows 10 rows plus "… N more"; clicking opens and shows
  "Show less"; typing in its search shows every match; the section's settings
  show the "Show first" value and editing it updates the section.
