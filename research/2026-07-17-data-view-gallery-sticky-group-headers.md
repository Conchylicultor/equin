# DataView: gallery group headers must pin and stack like list/table

## Context

`useDataViewSections` is one shared pipeline (group-by → manual rank → aggregate)
feeding three flat views. But the **group-header chrome** built on top of it is
hand-rolled per view, and it has already drifted three ways:

| View | Group header | Since |
|---|---|---|
| `list` | `StickyStack` + `StickyStackItem` → pins, stacks up to 5 groups, degrades to swap hand-off | acb400bd3 |
| `table` | same, through `data-table`'s subgrid `col-span-full` rows | acb400bd3 |
| `gallery` | plain `SectionHeaderRow` inside a per-section `<Collapsible>` — **never pinned at all** | never |

Scrolling a grouped gallery therefore loses all sense of which group you are in.
There is **no reason a card grid should behave differently** — Notion's own gallery
pins its group headers, the viewport tax is identical to the list's, and the
`StickyStack` cap (5) already prices it. So gallery is an oversight, not a decision.

The narrow fix (mirror list's markup into gallery) closes today's gap but leaves the
cause intact: the sticky/stacking *policy* lives in each view child's JSX, so the
**next** flat view child will forget it exactly the same way. Per the repo rule —
*fix the structural issue, not the specific instance* — the policy moves next to the
pipeline that produces the sections.

## Approach

### 1. Hoist the grouped-section chrome into the data-view parent

New internal + barrel export in the **parent** `data-view` plugin (`list`/`gallery`
already import `useDataViewSections` from it, so the edge exists and stays a legal
child→parent import):

`plugins/primitives/plugins/data-view/web/internal/grouped-sections.tsx`

```tsx
export interface GroupedSectionsProps {
  sections: DataViewSection<unknown>[];       // key !== null (grouped branch only)
  collapsedSections?: ReadonlySet<string>;
  setSectionCollapsed?: (key: string, collapsed: boolean) => void;
  /** Horizontal inset matching the view body's own padding (list `px-sm`, gallery `px-xl`). */
  headerClassName?: string;
  children: (section: DataViewSection<unknown>) => ReactNode;
}
```

Its body is exactly list's current grouped branch, verbatim — the `<Stack gap="none">`
shared containing block, the `<StickyStack keys base={var(--dv-header-offset,0px)}>`,
per-section `<CollapsibleProvider>` (DOM-less: a wrapper would re-bound each header's
sticky containing block), `<StickyStackItem itemKey mask layer="raised">` wrapping the
`SectionHeaderRow` (label + `count` in `actions`), and `<CollapsibleContent>{children(section)}</CollapsibleContent>`.
The long explanatory comment currently in `list-view.tsx` moves here — one home.

Export `GroupedSections` from `plugins/primitives/plugins/data-view/web/index.ts`.

### 2. `list` consumes it (pure deletion)

`plugins/primitives/plugins/data-view/plugins/list/web/components/list-view.tsx` —
its grouped branch collapses to:

```tsx
<GroupedSections
  sections={sections}
  collapsedSections={props.collapsedSections}
  setSectionCollapsed={props.setSectionCollapsed}
  headerClassName="px-sm"
>
  {(section) => renderEntries(section.entries, activeId)}
</GroupedSections>
```

Drops its `StickyStack` / `StickyStackItem` / `CollapsibleProvider` /
`CollapsibleContent` / `SectionHeaderRow` / `DATA_VIEW_HEADER_OFFSET_VAR` imports.
Rendered output is byte-for-byte identical.

### 3. `gallery` consumes it — the actual fix

`plugins/primitives/plugins/data-view/plugins/gallery/web/components/gallery-view.tsx`
(lines 336–368) becomes the same call with `headerClassName="px-xl"` (matching its
`p-xl` grid body) and `{(section) => renderGrid(cellsFor(section))}`. Drops the
`Collapsible` import.

Gallery's in-section windowing needs no change: `VirtualRows` self-discovers the
scroll parent and folds the sticky chrome into its measured `scrollMargin` — the
same composition list already runs.

### 4. Fix the adjacent aggregate drop (same oversight class)

Gallery's grouped branch builds its cells without `aggregateCount` (line 342–346),
so the `×N` badge silently vanishes under group-by while the ungrouped branch shows
it. One-word fix (`aggregateCount: e.aggregateCount`), restoring the documented
"aggregate composes with every flat view" contract.

### 5. Docs

- `plugins/primitives/plugins/data-view/CLAUDE.md` — a short **"Grouped sections"**
  section: `GroupedSections` is the one home for the pinned/stacked group header;
  every flat view child renders its grouped branch through it. Records why `table`
  is the documented exception (its headers are `col-span-full` subgrid rows — the
  chrome cannot own a `<Stack>` without breaking column alignment — so it composes
  `StickyStack` directly inside `data-table`, under the same policy).
- `plugins/primitives/plugins/data-view/plugins/gallery/CLAUDE.md` +
  `.../list/CLAUDE.md` — one line each pointing at the shared chrome.
- Same file's **"Row virtualization"** section is stale — it claims "`table` and
  `gallery` are the remaining follow-ups", but both window today (gallery
  lane-aware at 60 cards; table's *ungrouped* body at 100 rows, grouped mode
  deliberately never windowed). Correct it while here.

## Why not a lint rule

The rule would have to say "a view child rendering a grouped `DataViewSection` must
wrap it in sticky chrome" — unstateable statically. Hoisting makes the divergence
unrepresentable instead: there is one grouped branch, shared.

## Files

- **New:** `plugins/primitives/plugins/data-view/web/internal/grouped-sections.tsx`
- `plugins/primitives/plugins/data-view/web/index.ts` (export)
- `plugins/primitives/plugins/data-view/plugins/list/web/components/list-view.tsx`
- `plugins/primitives/plugins/data-view/plugins/gallery/web/components/gallery-view.tsx`
- `plugins/primitives/plugins/data-view/CLAUDE.md`, `plugins/gallery/CLAUDE.md`, `plugins/list/CLAUDE.md`

Reused, nothing new invented: `StickyStack`/`StickyStackItem`
(`css/sticky/plugins/stack/web`), `CollapsibleProvider`/`CollapsibleContent`
(`collapsible/web`), `SectionHeaderRow` (`css/row/web`), `DATA_VIEW_HEADER_OFFSET_VAR`
(`data-view/core`), `Stack` (`css/spacing/web`).

## Verification

1. `./equin build` (regenerates the plugin docs; `plugins-doc-in-sync` +
   `type-check` + `eslint` gate).
2. `bun test plugins/primitives/plugins/css/plugins/sticky/plugins/stack` — the
   existing `stickyStackTop` unit test must stay green (untouched).
3. In-app, scripted Playwright (`bun e2e/screenshot.mjs`) on **Debug → Reports**
   (the surface acb508's author verified list/table on — it has a gallery view and
   both a 2-group `noise` mode and a 12-group `kind` mode):
   - gallery + group by `noise` (2 groups): scroll; **both** headers stay pinned,
     the second at the first's measured bottom edge, both below the DataView toolbar.
   - gallery + group by `kind` (12 groups): all headers share `--dv-header-offset`
     and hand off (cap degradation).
   - list + table under the same two modes: unchanged from today (regression check
     on the hoist).
4. Confirm the `×N` badge appears on an aggregating grouped gallery.
