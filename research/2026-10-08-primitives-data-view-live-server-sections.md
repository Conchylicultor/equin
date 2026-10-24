# DataView: server-sectioned grouping for live sources

> **Superseded (2026-10-09):** the segmented scroll (`useLiveScroll`, `shared/scroll-plan.ts`, every loaded segment live, the 16-segment cap) is replaced by live key-range pages (`useLiveCollectionPages`, `shared/page-plan.ts`) whose liveness follows the viewport — see `research/2026-10-09-global-live-key-range-pages-v2.md`. Where this doc reads a scroll or its segments, read the paged read and its pages.

## Context

All-conversations grouped by **Model** shows a single "Opus 5.5" section. A live
DataView (`liveDataSource` → `useLiveScroll`) groups **client-side** over the rows
it has loaded:

1. The head window is the newest 100 conversations (`createdAt desc`), all Opus 5.5.
2. `model` is not sortable, so the group-by prepend in
   `data-view/web/internal/live-source.ts:172-185` (oneBucketPerValue over a
   *sortable* column → order prefix, `sectionOrder: "appearance"`) does not fire.
3. The next page loads only while the paged tail is on screen
   (`data-view-body.tsx` `tailCollapsed`); the tail is inside the collapsed
   "Opus 5.5" section, so paging holds forever and no other model ever appears.

So the sections a live grouped view shows depend on what happens to be loaded,
which tells the user nothing true about their data. The fix: **the server says
which sections exist (with exact, live counts), and each section pages its own
rows.** The collection already serves the needed primitive: every
`liveCollection` has a `:groups` push resource (`useLive(c, { groupBy, where, limit })`,
`SELECT col, count(*) … GROUP BY col`), today used only by facet options
(`data-view/web/internal/facet-options.tsx`).

Outcome: grouping any live DataView by an enum/bool/text column lists every
group with its exact count, kept live by the change feed; expanding a section
scrolls through that group's rows only.

## Design

### When a grouping is server-sectioned

A `(field, grouping)` pair under a live source **lowers to server sections** iff:

- `grouping.oneBucketPerValue === true` (identity / enum / bool), and
- the field's column (`resolveLiveFields(...).columnOf`) is a **groupable** column
  of the collection: an own `filterable` column of domain text / number / boolean
  (`LiveGroupableColumn`; `checkGroupBy` in live's `query-codec.ts`). Contributed
  `$columns.*` are not groupable.

Otherwise the existing behaviour stays (order prefix over a sortable column, or
date buckets over the sort column). A pair that lowers to **neither** is not
offered by the Group-by control under a live source (`isGroupableField` gets
the live lowering as its `hasGrouping` input) — the broken state becomes
inexpressible instead of "works for the first 100 rows". Not lowered = a
contributed/derived field with no sortable column; today it silently shows
partial sections.

Merged live sources (`merged-live-source`, the sidebar History) keep the current
path in this change — a per-arm groups read would have to sum counts across arms;
follow-up task.

### Data flow

`useLiveSource` (`live-source.ts`) returns a discriminated `SourceView`:

```ts
type SourceView =
  | { kind: "flat"; rows; paging; sectionOrder; loading; readError }   // today
  | { kind: "sectioned";
      groups: ServerSection[];        // key, label, order (from grouping.plan), count: exact, value
      rows: Row[];                    // concatenation of the reads of ACTIVE sections
      sectionPaging: ReadonlyMap<string, DataViewPaging>;
      groupsPaging: DataViewPaging;   // load more groups / truncation at LIST_MAX
      loading; readError }
```

- **Groups read** — one `useLive(collection, { groupBy: col, where, limit })`, where
  `where` is the SAME lowered `scope ∧ viewFilter ∧ search` the rows use, so
  headers match rows (a filter on the grouped column hides the other groups).
  Each `{ value, count }` maps to a bucket through `grouping.plan({ values, field })`
  (key + label + order identical to in-memory grouping); NULL → `NULL_GROUP_KEY`
  ("None"). Section order = bucket order × `groupOrder` direction, NOT the
  server's count order — the same order an in-memory DataView shows. Exact
  because the set is complete; when the read is full at `LIST_MAX` (100) the
  footer says so (`groupsPaging.truncated`, "Showing the 100 largest groups"),
  never silently.
- **Section reads** — one `<LiveSectionRead>` component per **active** section
  (sibling-reporter pattern of `FacetRead`, so hooks are not called in a loop and
  a re-key does not remount the body): `useLiveScroll(collection,
  { where: and(where, value === null ? clause(col, "isEmpty") : eq(col, value)),
  orderBy: <view sort or collection default, no group prefix>, columns },
  { resetKey })`. It reports `{ rows, paging: scrollPaging(read) }` up, keyed
  `sectionKey + resetKey`.
- **Activation** — a section is active when it is expanded AND its body has come
  into view once (latch, reset by `resetKey`). Expanded-but-unread sections render
  their footer sentinel immediately; its paging object is
  `{ canGrow: true, loadMore: () => activate(key), complete: false, … }`, so
  "start reading this section" is just the first page of the same
  `useInfiniteScroll` sentinel. 30 groups below the fold read nothing. Collapsing
  deactivates (unsubscribes); live-state's refcounted cache makes re-expand cheap.

### Body and views

- `partitionIntoSections` (`use-data-view-sections.ts`) takes an optional
  `declared: ServerSection[]`: it emits every declared section (an empty one
  too, header + count), buckets loaded rows into them, and uses the declared
  **exact** count instead of `exactCount/atLeastCount` over loaded rows.
  `rowsComplete` is `{ growable: row ∈ non-exhausted section }`, so aggregates
  over a partly loaded section stay lower bounds.
- `DataViewSection` gains `paging?: DataViewPaging`. `GroupedSections` renders,
  after `children(section)` inside the collapsible content, a per-section
  `<SectionPagingFooter>` = `useInfiniteScroll` + `InfiniteScrollFooter` (the
  same pieces the body footer uses). The table view (which composes its own
  `StickyStack` + header rows) renders the same footer in a `col-span-full` row
  after each section's rows. Tree calls `partitionIntoSections` directly — passes
  `declared` through; footer as in list.
- In sectioned mode the body-level tail hold is unused (no single tail); the body
  footer shows `groupsPaging` only. Loading = groups read loading; empty state =
  groups ready with none; `readError` = groups read failed (a section read's
  failure stays in that section's footer with Retry).

### Cost

One `:groups` tuple (full `GROUP BY` recount per write to a table it reads —
bounded at 100 rows out) + one scroll read per active section (≥1 window of
`default.limit`). Bounded by what is on screen, not by the number of groups.

## Files

- `plugins/primitives/plugins/data-view/web/internal/live-source.ts`: the lowering
  decision, `SourceView` union, groups read, section activation state.
- new `data-view/web/internal/live-sections.tsx`: `LiveSectionRead`,
  groups→`ServerSection` mapping (reuse `grouping.plan`, `NULL_GROUP_KEY`,
  `scrollPaging`, `canonicalizeFilter` / `and` / `clause` from
  `network/live/plugins/filter/core`).
- `data-view/web/internal/use-data-view-sections.ts`: `declared` sections.
- `data-view/core/internal/types.ts`: `DataViewSection.paging`, render prop for
  declared sections.
- `data-view/web/components/data-view-body.tsx`: wire the sectioned arm, skip the
  tail hold, body footer = groups paging.
- `data-view/web/internal/grouped-sections.tsx`, `table-view.tsx`,
  `tree-view.tsx`: per-section footer.
- `data-view/web/internal/live-fields.ts` + Group-by control: offer only
  lowerable `(field, grouping)` pairs under a live source.
- `data-view/CLAUDE.md`: rewrite the "Group-by" bullet of the live-source section.

No change in `all-conversations`: `model` is already a filterable `liveText()`.

## Verification

- Unit: `partitionIntoSections` with `declared` (empty sections kept, exact
  counts, NULL group, bucket order); groups→section mapping.
- jsdom (`web/__tests__/live-source.test.tsx` pattern): grouped by a groupable
  enum → one groups read with the full `where`; a section read only once
  expanded + in view, with `eq`/`isEmpty` ANDed; collapse unsubscribes; a
  non-lowerable field is not offered for group-by; full-at-100 shows truncation.
- `./equin test plugins/primitives/plugins/data-view`
- `./equin build`, then screenshot
  `/agents/all-conversations` grouped by Model (`e2e-harness/e2e/screenshot.ts`):
  every model listed with counts; expanding a non-Opus model shows its rows and
  pages on scroll. Spot-check another live DataView (Runs, Events) grouped by an
  enum, and the existing date-bucket grouping on `createdAt`.
