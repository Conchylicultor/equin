# Places: one tag tree to filter and edit (the shared tag picker)

## Context

Places has two tag-tree UIs, both separate from the one Prototypes uses:

- the **sidebar tree** (`places-map/web/components/tag-sidebar.tsx`: `TagTree` / `TagBranch` /
  `TagTreeRow` / `FilterCheck`): a hand-rolled, select-only tree with its own "Find a tag…" input;
- the **Manage tags** floating card (`places/tag-manager`): a DataView table for editing (colour,
  icon, name, parent, Google types, count, Shade children, + Child, Delete).

The user dislikes Manage tags and wants the sidebar tree to be the shared `tag-tree/picker`
`TagPickerPanel` (what Prototypes' tag chip opens): one tree that both **selects** (filters) and
**edits** (hover ＋ / ⋯, double-click rename, drag to reorder/nest), with **search-or-create** to add
a tag quickly. The picker is made flexible enough for what Places needs; Manage tags is deleted.

## What the picker lacks for Places (gap → generic option)

| Places needs | Picker today | Change (in `tag-tree/picker`) |
|---|---|---|
| Tri-state filter mark: included ✓, excluded (struck, red), partial (a descendant picked) | ✓ for `selected` only | `excluded?: readonly string[]` + `indicator?: "check" \| "checkbox"` (default `"check"`). **Partial is derived** in the picker (a selected/excluded tag under the row, `isTagUnder`) — no prop. Excluded rows: destructive tone + line-through. |
| Roots open, deeper levels folded | everything unfolded | `defaultExpanded?: "all" \| "roots"` (default `"all"`) seeds the fold set. |
| Inline in a sidebar, no focus steal | `autoFocus` hard-coded | `autoFocus?: boolean` (default `true`). |
| A created tag should not filter the map to zero | a created path is picked | `pickCreated?: boolean` (default `true`); Places passes `false` (Enter on an **existing** exact match still toggles it). |
| Zero count reads faint | `""` for 0 | A 0-count row's name gets `tone="faint"` (count cell stays blank), for every tree. |
| Icon per tag | colour only in ⋯ | ⋯ menu gains **Icon…** (`IconPicker`, + No icon) — `icon` is a base `TagRow` field, so every tree gets it (Prototypes too). |
| Shade children | — | ⋯ menu gains a **Shade children** checkbox item on a parent (`childColors: "ramp"`, base field). |
| Role tags (Been / Want to go) not deletable | Delete always offered | `canDelete?: (tag) => boolean` (default all). The server's `refuseDelete` still enforces it; this only hides the item. |
| Google types (read-only "auto-set from") | — | `rowMenuExtra?: (tag: Row) => ReactNode` rendered at the menu's foot; Places draws the types as mono badges, "manual" when none. Panel made generic over `Row extends TagRow` (like `TagPickerPopover`). |

Parent select (Manage tags' Parent column) is covered by drag-to-nest + "Move out of …"; the
manager's "New tag" naming flow by the picker's inline draft row / footer "New tag".

## Changes

### `plugins/tag-tree/plugins/picker`
- `web/internal/types.ts` — add the options above to `TagPickerOptions` (`excluded`, `indicator`,
  `defaultExpanded`, `pickCreated`, `canDelete`); `rowMenuExtra` on `TagPickerPanelProps<Row>`.
- `web/components/tag-picker-panel.tsx` — wire them; replace `Check` with a `RowIndicator`
  (check | checkbox with include / exclude / partial — port `FilterCheck` from `tag-sidebar.tsx`);
  apply it in tree rows and search results; `autoFocus`; fold seed; `pickCreated`.
- `web/components/tag-row-menu.tsx` — Icon…, Shade children, `canDelete`,
  `rowMenuExtra`.
- `web/__tests__/tag-picker-panel.test.tsx` — cover checkbox/excluded/partial, `defaultExpanded="roots"`,
  `canDelete` hiding Delete, `pickCreated={false}`.
- `CLAUDE.md` prose.

### `plugins/apps/plugins/places/plugins/places-map`
- `tag-sidebar.tsx` — the body becomes
  `<TagPickerPanel tags writes={useTagTreeActions(placeTagTree)} indicator="checkbox"
  selected={includedTags(state)} excluded={state.exclude} counts={counts ?? undefined}
  defaultExpanded="roots" autoFocus={false} pickCreated={false} canDelete={(t) => t.role === null}
  rowMenuExtra={(t) => <GoogleTypes types={t.googleTypes}/>}
  onPick={(id) => id !== null && write(toggleTag(state, id, tags))} />`.
  Delete `TagTree`, `TagBranch`, `TagTreeRow`, `FilterCheck`, `INDENT_PX`; drop the footer
  (New tag / Manage tags) and the `onNewTag` / `onManageTags` props. `includedTags` exported from
  `internal/sidebar-filter.ts` if it isn't.
- `places-screen.tsx` — remove `manager` state, `newTag`, the `TagManagerPanel` pin, and the
  manager arm of the right-side card logic (`showCard` / panel conditions).
- `e2e/presets.ts`, `e2e/tour.ts` — `[data-tag-row]` → the tree row's `[data-tree-id]` (scoped to
  the sidebar); drop the tour's "Manage tags" step.
- `CLAUDE.md` prose (sidebar section, the manager paragraph).

### `plugins/apps/plugins/places/plugins/tag-manager` — delete
The plugin folder and `config/apps/places/tag-manager/places.tags.jsonc` (the `places.tags`
DataView's config). Generated registries / `browser-host.generated.ts` / docs regenerate on
`./equin build`. Check `places-core` / `tag-tree` CLAUDE.md for references to it.

### Prototypes
No code change; its picker gains Icon… and Shade children from the shared menu.

## Verification
- `./equin test plugins/tag-tree/plugins/picker` and `plugins/apps/plugins/places`.
- `./equin build` (checks: boundaries, plugins-registry-in-sync, docs).
- `browser_*` on `/places`: pick / unpick a tag (map filters, preset turns dirty), partial mark on a
  parent, excluded tag from an advanced filter shows struck; ＋ sub-tag, rename, recolour, icon,
  shade children, drag to nest; Delete hidden on Been / Want to go; search "food/new" → Enter creates
  the path without filtering. Same quick pass on a prototype's tag chip.
- Run `places-map/e2e/presets.ts` and `tour.ts`.

## Follow-up (not in scope)
- An **Exclude** item in the ⋯ menu when the picker filters (today an exclusion is only written in
  the advanced filter).
