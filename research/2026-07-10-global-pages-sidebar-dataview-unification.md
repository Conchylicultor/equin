# Pages sidebar unification — Favorites becomes a filtered view

**Date:** 2026-07-10
**Status:** design, ready to implement
**Predecessor:** [`research/2026-07-09-global-per-view-manual-order-and-pages-sidebar-unification.md`](2026-07-09-global-per-view-manual-order-and-pages-sidebar-unification.md) — its **Part A** (the `data-view/view-order` sub-plugin) has **landed**. This doc is the revised, verified **Part B**.

## Context

The Pages sidebar stacks two hand-rolled surfaces that show *the same rows*:

- `apps/pages/page-tree` renders a `<DataView>` (`pages-sidebar`, one authored `tree`
  view) inside a `SidebarPaneSection` titled "Pages".
- `apps/pages/starred` renders `FavoritesSidebar` — a bespoke `SortableList` over its
  own `page_blocks_ext_starred.rank` column, with its own live resource and a
  `POST /api/pages/:pageId/starred/move` endpoint — inside a `SidebarPaneSection`
  titled "Favorites".

Favorites is conceptually nothing but *"pages where starred = true"*, yet it costs a
parallel renderer, a rank column, a mutable-order-by live resource forced to
`recompute: {kind:"full"}`, and an endpoint.

**Intended outcome:** one `DataView` whose **view switcher is the sidebar chrome**.
"Pages" and "Favorites" become two view instances of one surface; the user can add
their own views (`+`) — filtered, grouped, sorted — with zero code. Favorites is *just*
a `list` view filtered on a contributed `starred` bool field.

The old blocker (Favorites' custom drag order) is gone: `view-order` now gives **every**
`list`/`table` view a per-`(dataViewId, viewId)` manual order, so `starred` needs no rank
column at all and collapses to a pure presence marker.

---

## Part 1 — `CreatorsControl` folds when compact (data-view primitive)

Root-page creation moves from the deleted section-header "+" to
`DataViewProps.creators`. But the Pages sidebar is `16rem` (256px), below the toolbar's
`COMPACT_BREAKPOINT = 360`, so it renders the **folded** toolbar (search collapses to a
magnifier; sort/filter/fields collapse behind one `MdTune` popover).
`CreatorsControl` is the one control that never folds — with a single creator it always
renders a labelled `<Button>`, which crowds a 256px sidebar.

Fold it, mirroring every sibling control. The three existing `creators` consumers
(`apps/story/shell`, `apps/sonata/library`, `apps/home/app-cards`) are all wide surfaces
that never hit the breakpoint, so this is a visual no-op for them.

**`web/components/creators-control.tsx`** — add `compact?: boolean`; when
`compact && creators.length === 1`, render the `MdAdd` `IconButton` (tooltip = the
creator's `label`) instead of the labelled `Button`. The N-creator branch is already an
`MdAdd` `IconButton` + dropdown — unchanged. The shared `busy` flag is unchanged.

**`web/components/toolbar/data-view-toolbar.tsx`** — the toolbar is the only component
that knows `compact` (it measures itself). Replace the pre-built
`creatorsControl: ReactNode` prop with `creators?: CreateOption[]`, and build the element
once in the body — preserving the file's "each control element is built once and handed
to the toolbar, which only relocates it" discipline:

```tsx
const creatorsControl = <CreatorsControl creators={creators} compact={compact} />;
```

**`web/components/data-view.tsx`** — pass `creators={creators}` instead of
`creatorsControl={<CreatorsControl creators={creators} />}`. The separate
`CreatorsControl` in the *no-views-configured* placeholder path stays non-compact.

---

## Part 2 — `page-tree`: one DataView, two views

### 2a. Mint the field-extension factory

`plugins/apps/plugins/pages/plugins/page-tree/web/slots.ts`:

```ts
export const PageTree = {
  RowActions: defineItemActions<Block>("pages.tree.row-actions"),
  Fields: defineFieldExtensions<Block>("pages.tree.fields"),   // NEW
};
```

`defineFieldExtensions` is the sanctioned per-consumer seam (disjoint row types ⇒ a
factory, not a global slot). The working precedent is
`plugins/apps/plugins/sonata/plugins/library/web/slots.ts` (`Library.Fields`), consumed
by `playback-history/web/components/playback-fields.tsx`. `web/index.ts` already
re-exports `PageTree` — no barrel change.

### 2b. Rewrite `web/components/pages-sidebar.tsx`

| Change | Detail |
|---|---|
| Drop `<SidebarPaneSection title="Pages" labelExtra={PagesHeaderAdd}>` | The DataView's view switcher *is* the sidebar chrome. `<Scroll fill className="py-xs">` becomes the root — it already carries `min-h-0 flex-1 overflow` as a direct flex child of `AppShellLayout`'s sidebar `Stack`, which is exactly what `SidebarPaneSection` provided. The DataView never owns a scroll; its `<Sticky>` toolbar pins against this `Scroll`. |
| Delete `PagesHeaderAdd` | Superseded by `creators` (below). |
| `loading={result.pending}` | Replaces the outer `result.pending ? <Loading/> : <DataView/>` branch, so the switcher chrome paints immediately and only the body shows the skeleton. The host already owns loading→empty precedence. Keep building `rows` under the not-pending guard (never `pending ? [] : data`). |
| `views={["tree", "list"]}` | Was `["tree"]`. |
| `fieldExtensions={PageTree.Fields}` | New. |
| `creators={[{ id: "new-page", label: "New page", icon: <MdAdd/>, onSelect: createRootPage }]}` | `useMemo`'d. `createRootPage` = the deleted `PagesHeaderAdd` body (`createPageWithSeed({parentId:null})` then `openPane`). |
| `viewOptions.list = { leading: (b) => <PageIcon nodes={pageData(b).iconSvgNodes}/>, size: "sm" }` | Gives Favorites rows the same page icon + density they have today. `ListViewOptions` is a plain literal — never import the view child. |
| `viewOptions.tree` | Unchanged (`leadingIcon`, `rowMenu`, `addLabel: null`, `dragOverlay`). |

`hierarchy`, `itemActions={PageTree.RowActions}`, `selectedRowId`, `onRowActivate`, the
`title` field + its `onEdit` all stay. The `list` view honors `selectedRowId`,
`onRowActivate`, `itemActions`, and inline rename of the primary field for free.

---

## Part 3 — `starred`: contribute a field, delete the rank

| File | Change |
|---|---|
| `web/components/starred-field.tsx` | **new** — a `FieldExtensionProps<Block>` component (mirror `PlaybackFields` byte-for-byte). Reads `starredPagesResource` into a `Set<string>`, yields one `FieldDef<Block>`: `{ id: "starred", label: "Starred", type: "bool", value: (b) => set.has(b.id), filterable: false, groupable: false }` |
| `web/index.ts` | Replace `Pages.Sidebar({id:"favorites", …})` with `PageTree.Fields({ id: "starred", component: StarredField })`. Drop the `Pages` + `MdGrade` imports. The two star toggles (`PageTree.RowActions`, `PageDetail.HeaderActions`) stay. |
| `web/components/favorites-sidebar.tsx` | **delete** |
| `shared/resources.ts` | `StarredPageRowSchema` → `z.object({ parentId: z.string() })` (drop `rank`, drop the `RankSchema` import) |
| `shared/endpoints.ts` | delete `movePageStarred` |
| `server/internal/tables.ts` | `defineExtension(_blocks, "starred", {})` — presence-only. Drop the `rankText` import. |
| `server/internal/mutations.ts` | `setPageStarred` → `starred ? upsert(pageId, {}) : delete(pageId)`. Delete `movePageStarred` + the `nextRankIn` import. |
| `server/internal/routes.ts` | delete `handleMovePageStarred` |
| `server/internal/resource.ts` | `select: { parentId }` only; **drop `orderBy`** and **drop `recompute: {kind:"full"}`** — its justification was verbatim "mutable order-by column", which no longer exists. Reverts to the default identityTable-scoped keyed resource (cheaper deltas). Drop the `asc` import. |
| `server/index.ts` | drop the move route + its export |
| `CLAUDE.md` | rewrite prose: presence-only marker + a contributed bool field; no sidebar UI, no rank, no order. |

Notes verified against the code:

- `defineExtension(parent, name, {})` is legal — `parentId` / `createdAt` / `updatedAt`
  are always synthesized.
- `upsert(pageId, {})` is legal — the handle always writes `updatedAt`, so the
  `onConflictDoUpdate` `SET` clause is never empty.
- `queryResource`'s `orderBy` is optional. Consumers now build a `Set`; wire order is
  irrelevant, and the Favorites row order comes from `view-order`.
- `filterable: false` keeps `starred` out of the **full-text search accessor** only
  (`isSearchable` in `use-flat-rows.ts`). It stays in the Filter pill, which is gated
  purely on the field type resolving an operator set (`useFilterController`) — so the
  user can still build their own starred-filtered views.
- `groupable: false` is deliberate: `bool` defaults to `groupable: true`, and setting a
  group-by silently disables `rowOrderEnabled` — i.e. it would suspend the Favorites drag
  order with no visible cause.

---

## Part 4 — Config

### 4a. `config/apps/pages/page-tree/pages-sidebar.jsonc`

The `@hash` is the hash of the **origin**, and every DataView's origin is the stable
`{views:[],sortPresets:[],filterPresets:[],customColumns:[]}`. It does **not** change —
keep `6ec84829688d` verbatim. The resolver derives each instance id from `slug(name)`;
`bool` operators are `is` / `is-not` with a literal boolean operand.

```jsonc
// @hash 6ec84829688d
{
  "views": [
    { "name": "Pages", "view": { "type": "tree", "visibleFields": ["title"] } },
    { "name": "Favorites", "view": {
        "type": "list",
        "visibleFields": ["title"],
        "filter": { "kind": "group", "id": "fav", "conjunction": "and",
          "children": [{ "kind": "rule", "id": "fav-starred",
                         "fieldId": "starred", "operatorId": "is", "value": true }] } } }
  ]
}
```

- **`visibleFields: ["title"]` on both** keeps the contributed `starred` bool a pure
  filter dimension — otherwise it renders as a checkbox chip on every row (the default is
  `null` = show all fields). This is the same idiom as
  `config/config_v2/settings/config_v2.settings.nav.jsonc`.
- **Favorites must be a `list`, not a filtered `tree`.** `tree-view.tsx` walks
  `parentById` up from each match and keeps every ancestor, so a filtered tree would
  render the *unstarred* ancestors of every starred page.
- Renaming `"Tree"` → `"Pages"` shifts the instance id `tree` → `pages`. The
  device-local `pages-sidebar:active-view` key may still hold `"tree"`; the view model
  falls back to the first instance. Harmless.

### 4b. `config/apps/pages/shell/pages.sidebar.jsonc` — remove the Favorites item

```jsonc
"items": [
  "apps.pages.content-search:search",
  "apps.pages.page-tree:pages"
]
```

**This one's `@hash` DOES change.** Reorder origins are *materialized catalogs* — the
origin's `items` is the full live contribution list — so deleting the `Pages.Sidebar`
"favorites" contribution regenerates `pages.sidebar.origin.jsonc` with a new hash, and a
committed override carrying the old hash **hard-fails `config-origins-in-sync` on push**.
After `./equin build`, copy the regenerated origin's `@hash` into the override.

### 4c. `config/apps/pages/page-tree/pages.tree.fields.jsonc` — **new, required**

`defineFieldExtensions` is a `defineRenderSlot`, so `pages.tree.fields` enters
`reorderable-slots.generated.ts` and the **`reorder:configs-authored` check demands an
authored override**. After the build regenerates `pages.tree.fields.origin.jsonc`, copy
it verbatim (it will contain the single `"apps.pages.starred:starred"` entry). Precedent:
`config/apps/sonata/library/sonata.library.fields.jsonc`.

---

## Migration

`./equin build` regenerates everything — **never invoke `drizzle-kit`**:

- `ALTER TABLE page_blocks_ext_starred DROP COLUMN rank`
- `reorderable-slots.generated.ts` (+ `pages.tree.fields`, − `pages.sidebar`'s favorites entry)
- `pages.sidebar.origin.jsonc` and `pages.tree.fields.origin.jsonc`

**No data migration.** `SELECT count(*) FROM page_blocks_ext_starred` on main returns
**1**, so preserving the old favorites order is not worth a hand-written SQL step.
Existing favorites seed into source order on first render.

---

## Known, accepted behaviors

- If the `starred` plugin is ever disabled, the `starred` field disappears and
  `evaluateNode` fail-softs on an unresolvable rule (`resolveRuleOperator` → `null` ⇒
  returns `true`, keeping the row), so the Favorites view would list *all* pages flat.
  The instance is authored in `page-tree`'s config and cannot be conditionally dropped.
  Disabling `starred` also removes the star row-action, so nothing could be starred anyway.
- The "New page" creator is visible on the Favorites view too, and creates an unstarred
  page that does not appear there. Notion-consistent.
- Favorites no longer hides itself when empty — it is a view instance, so it renders the
  DataView's empty state. Intended.
- A user-created **unfiltered** `list` view makes one drag write `O(all pages)` order
  rows — the always-on cost `view-order`'s `CLAUDE.md` already documents. Favorites
  itself only ever ranks the starred rows.

---

## Critical files

- `plugins/primitives/plugins/data-view/web/components/creators-control.tsx` — `compact` prop
- `plugins/primitives/plugins/data-view/web/components/toolbar/data-view-toolbar.tsx` — build `CreatorsControl` with `compact`
- `plugins/primitives/plugins/data-view/web/components/data-view.tsx` — pass `creators` not `creatorsControl`
- `plugins/apps/plugins/pages/plugins/page-tree/web/slots.ts` — `PageTree.Fields`
- `plugins/apps/plugins/pages/plugins/page-tree/web/components/pages-sidebar.tsx` — the unification
- `plugins/apps/plugins/pages/plugins/starred/**` — field contribution; delete rank, endpoint, sidebar
- `config/apps/pages/page-tree/pages-sidebar.jsonc` — the two view instances
- `config/apps/pages/shell/pages.sidebar.jsonc` — drop favorites, re-stamp `@hash`
- `config/apps/pages/page-tree/pages.tree.fields.jsonc` — **new**

Reference/template files (read, do not edit):

- `plugins/apps/plugins/sonata/plugins/library/web/slots.ts` + `plugins/apps/plugins/sonata/plugins/playback-history/web/components/playback-fields.tsx` — the `defineFieldExtensions` precedent
- `plugins/primitives/plugins/data-view/plugins/view-order/CLAUDE.md` — the order semantics Favorites inherits
- `config/apps/sonata/library/sonata.library.fields.jsonc` — the reorder-config precedent

---

## Verification

1. `./equin build`. Confirm the generated migration drops `page_blocks_ext_starred.rank`,
   and that `pages.tree.fields.origin.jsonc` appeared. Copy its body to the override; re-stamp
   `pages.sidebar.jsonc`'s `@hash` from its regenerated origin.
2. `./equin check` — must pass `migrations-in-sync`, `config-origins-in-sync`,
   `reorder:configs-authored`, `data-view:configs-authored`, `reorderable-slots-in-sync`,
   `plugins-doc-in-sync`, `plugin-boundaries`, `type-check`.
3. Open `http://<worktree>.localhost:9000/pages`. The sidebar shows the Search row, then a
   single surface with a `Pages | Favorites | +` switcher and **no** section headers. The
   toolbar is the compact form: switcher, magnifier, a `+` icon (New page), a tune icon.
4. `bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/pages --click "Favorites" --out /tmp/fav`
   — before/after of the switcher, and the script prints the button's `aria-pressed`.
5. Star a page from its row action → it appears in Favorites; unstar → it leaves. Page icons
   render on Favorites rows.
6. Drag two favorites; reload → order persists. Then:
   `query_db: SELECT * FROM data_view_row_order WHERE view_id = 'favorites'` → rows for the
   starred pages **only**. `query_db: SELECT * FROM page_blocks_ext_starred` → no `rank` column.
7. In Favorites, pick a sort → drag suspends and the sort wins; clear it → the custom order
   returns (the `view-order` Notion rule).
8. Click `+` → add a custom `list` view, filter it, confirm it persists to
   `config/apps/pages/page-tree/pages-sidebar.jsonc`.
9. Regression: `http://<worktree>.localhost:9000/agents` queue sidebar still orders by
   priority; the Sonata library / Home launcher / Story gallery still show their **labelled**
   creator buttons (they are wide, so `compact` is false).
