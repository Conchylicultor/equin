# DataView: in-memory filter/fold rules that never resolve refuse instead of matching everything

## Context

A DataView filtered in the browser (`rows`, no `source`) lowers its filter with
`lowerFilterGroup` (`web/internal/evaluate-filter.ts`). That function treats a rule
whose field or operator does not resolve as TRUE, so the rule matches every row. Since 6e5d5e8cb7, `rulesPending`
(`web/internal/body-state.ts`, computed in `web/components/data-view-body.tsx:816`)
shows the loading state while the deferred tier is still loading. Once that tier has
loaded, a rule left dangling (deleted custom column, renamed field id, a plugin that
failed to load) is still dropped. The list then shows rows the view says it hides,
and nothing on screen says so.

The live path already refuses this. `lowerViewFilter` returns `UnavailableFilterRuleError`
(`web/internal/live-filter.ts`). `useLiveSource` holds it as pending until
`deferredComplete`, then reports it as an error (`live-source.tsx:233`). `BodyFallback`
then prints the message, which tells the user to "remove that rule" but gives them no
button to do it.

Goal: one rule on both paths. A rule that does not resolve shows the loading state
while plugins are still loading. After that it shows an error naming the rule, with
a **Remove** action that writes the pruned tree back to the view. This covers the
filter and the fold's `keep` rule.

## Findings: fold `keep` and `hideWhenEmpty` today

- **Fold `keep`** is evaluated in the browser on **both** paths (`useRowFilter(fold.keep)`
  in `data-view-body.tsx:531` and `use-data-view-sections.ts:456`). A dangling keep
  rule lowers to `null`, so every row is kept: nothing folds and no fold line is
  drawn (`foldSummary` is null too). The fold silently stops working, and the live
  path is affected as well. `fieldsReadByView` skips ids that no field has, so a
  keep rule whose field arrives with the deferred tier makes the view render
  unfolded first and fold afterwards (the same flash `rulesPending` fixed for the
  filter).
- **`hideWhenEmpty`**: `emptinessFilter` (`data-view-body.tsx:839`) uses the same
  `useRowFilter`. A dangling rule matches every row, so `hasNoRows` is false and the
  section is shown listing everything. Before the deferred tier finishes, the body
  state is `loading`, so the section is hidden, which is correct. Once the body state
  carries the new error arm, `sectionHidden` (hidden only on `loading` or on an empty
  `view`) shows the section with the error. The error is not swallowed, and no code
  change is needed beyond that arm. A test pins it.

## Design

### 1. The lowering reports unavailable rules (type level)

`lowerFilterGroup` now returns `unavailable: UnavailableRule[]` next to `filter` and
`readsClock`, where `UnavailableRule = { id, fieldId, operatorId }` and `id` is the
rule node's id, used for removal. The lowering still treats the rule as TRUE (other
consumers need a filter), but the drop is now part of what it returns.
`unavailableRules()` in `live-filter.ts` is rewritten as a thin call to it, so there
is one walk and one definition.

`useRowFilter` (public, `web/index.ts:120`) becomes a discriminated result:

```ts
type RowFilter<TRow> =
  | { kind: "all" }                                  // constrains nothing
  | { kind: "match"; matches: (row: TRow) => boolean }
  | { kind: "unavailable"; rules: UnavailableRule[] };
```

Today `null` means both "no filter" and "a filter we couldn't run", which is the
absorbable-failure shape `no-absorbed-failure` exists to stop. Callers to update:

- internal: `use-flat-rows.ts` (`useRowMatcher`), `hierarchy/use-hierarchy-tree.ts`,
  `use-data-view-sections.ts`, and `data-view-body.tsx` (fold, emptiness). The body
  never renders a view while rules are unavailable (§2), so internal callers treat
  `unavailable` as `all`, with a comment pointing to the body gate.
- external: `apps/places/.../tag-sidebar.tsx:125`, the faceted tag counts. When the
  rest of the filter is unavailable, show no counts instead of counts over every
  place. The DataView body beside it shows the error.
- `applyFilter` (pure) keeps its signature. It is used only by tests.

### 2. One body-state arm for both paths, with a remove action

Add an arm to `BodyState`, placed before `loading` in precedence:

```ts
| { kind: "rule-error"; error: UnavailableFilterRuleError | UnavailableSortRuleError }
```

- `UnavailableFilterRuleError` gains `tree: "filter" | "fold"` and carries the full
  `UnavailableRule` (with `id`). The message reads "This view folds on …" for
  `fold`. `UnavailableSortRuleError` stays as it is (its rules are keyed by `fieldId`).
- `resolveBodyState` takes `unavailable: { filter: UnavailableRule[]; fold: UnavailableRule[] }`
  and `deferredComplete`, replacing `rulesPending`:
  - server path: `server.error instanceof Unavailable…Error` → `rule-error`. Other
    errors stay `server-error`. The fold check applies here too, because the fold
    runs in the browser on this path as well.
  - in-memory path: any unavailable rule → `loading` while `!deferredComplete`, else
    `rule-error`. Readiness and field errors still take precedence.
- `BodyFallback` renders `rule-error` as the error placeholder plus a **Remove rule**
  button ("Remove rules" when there are several). It ignores the host's `errorState`,
  just as `server-error` does, because a host error UI would hide the way out. The
  button calls a new `onRemoveRules` prop, which `data-view-body` builds:
  - filter → `viewModel.setFilter(activeViewId, pruned)`
  - fold → `viewModel.setFold(activeViewId, pruned ? { ...fold, keep: pruned } : null)`
  - sort → `viewModel.setSort(activeViewId, sort.filter(r => !ids.has(r.fieldId)))`.
    The sort removal is a single line, so the live path's sort refusal gets the same
    way out.
  - Pruning reuses `deleteNode` from `filter-tree-ops.ts`, applied once per id. When
    the root ends up with no rule left (`countRules === 0`), the result is `null`.

The writes go through the existing view-model setters, so they persist like any other
filter edit, and the filter editor still shows the rule as "(unknown field)" until it
is removed.

### 3. Behaviour change for existing saved views

A saved view holding a stale rule changes from listing every row to showing the error
with Remove. This is intended: it now says honestly that the filter can't run, and
removing the rule is one click. Nothing is migrated automatically. The rule can't be
judged dangling from the DB alone, because field ids resolve at runtime.

## Files

- `plugins/primitives/plugins/data-view/web/internal/evaluate-filter.ts`: `unavailable` in `LoweredFilter`
- `.../web/internal/use-row-filter.ts`: the discriminated `RowFilter`
- `.../web/internal/live-filter.ts`: `unavailableRules` via the lowering; error gains `tree` and rule ids
- `.../web/internal/body-state.ts`: `rule-error` arm; `unavailable` + `deferredComplete` inputs
- `.../web/components/body-fallback.tsx`: Remove button, `onRemoveRules`
- `.../web/components/data-view-body.tsx`: compute filter and fold unavailability, build the remover, emptiness via the new result
- `.../web/internal/{use-flat-rows,use-data-view-sections}.ts`, `hierarchy/use-hierarchy-tree.ts`: consume `RowFilter`
- `plugins/apps/plugins/places/plugins/places-map/web/components/tag-sidebar.tsx`: no counts when unavailable
- `.../web/internal/body-state.ts` doc comment and the data-view `CLAUDE.md` filter section, updated

## Verification

- Unit (`body-state.test.ts`): the in-memory path with dangling filter or fold rules →
  `loading` before deferred, `rule-error` after; the server path with an
  `UnavailableFilterRuleError` → `rule-error`; precedence against `error` and `field-error`.
- Unit (`evaluate-filter.test.ts`, `live-filter.test.ts`): `unavailable` lists the
  rule ids for nested and `or` groups.
- jsdom (`web/__tests__/`): an in-memory DataView with a saved filter on a missing
  field shows the error, not the rows. Clicking Remove calls `setFilter` with the
  pruned tree (or `null`) and the rows come back. The same for a fold `keep` on a
  missing field (`setFold`). A `hideWhenEmpty` section with a dangling rule renders
  with the error, not hidden and not listing everything.
- `./singularity test plugins/primitives/plugins/data-view plugins/apps/plugins/places`,
  then `./singularity build`. Manually: add a custom column, filter a view on it,
  delete the column, and check that the view shows the error with Remove at
  `http://<worktree>.localhost:9000`.
