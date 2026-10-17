# DataView Properties: hiding a field keeps its place

Track: "DataView fields everywhere" (page `block-85963184-057d-4983-a5f0-c9183ae8d71c`), item **[Properties]**.

## Context

A view's Properties list is stored as `ViewState.visibleFields: string[]`: only the
visible ids, in body order (`core/internal/types.ts`). A hidden field has no stored
position. `useVisibleFieldsController` therefore draws the hidden fields after the visible
ones, and a toggle writes back only the visible ids. Hiding a field and showing it again
moves it to the end of its band.

Goal: the Properties list is one stable, reorderable list. Each field can be hidden and
keeps its place. Hidden rows stay where they are, dimmed, and an eye icon on the right
replaces the checkbox. Saved views, including the 17 committed `.jsonc` files (24 views),
keep exactly what they show.

Decisions (user, 2026-10-17):

- **A new field in a customized view arrives hidden, at the end of its band** (Notion
  behaviour). Nothing visible changes.
- **No review flagging.** Fields live in code, not in the views config, so adding a field
  moves no config hash and needs no review. The track's review sub-item is dropped.

## Design

### Storage: `properties` replaces `visibleFields`

Inside the view blob:

```jsonc
"properties": [{ "id": "title" }, { "id": "status", "hidden": true }, { "id": "updatedAt" }]
```

```ts
interface PropertyEntry { id: string; hidden?: true }
ViewState.properties?: PropertyEntry[] | null
```

- **Absent**: the schema's default body set, unchanged (every field except
  `FieldDef.visible: false`, in schema order).
- **Array**: the listed ids in stored order, each shown unless `hidden: true`. Ids the schema
  no longer has are dropped. **Schema fields not in the array are hidden and appended at the
  end of their band** (schema order). This is the "new field arrives hidden" rule, and it
  needs no field catalog.
- **The first edit writes every current field** (visible and hidden) in its displayed order,
  so after that a hidden field has a stored position.
- **"Show all fields"** still clears the key (back to the schema default), as today.

One list rather than `fieldOrder` + `hiddenFields`: order and visibility are written in one
place, so they cannot disagree. The new key name makes the meaning change explicit, so no
reader can mistake an old visible-only array for a full order.

### Migration: `visibleFieldsToProperties`

A `defineConfigMigration` in `shared/view-migrations.ts`, added to `viewMigrations` after
`treeViewToTable`. For every `views[i].view` with a `visibleFields` array, it replaces the
key **at the same position** with `properties: ids.map(id => ({ id }))`. A view without
`visibleFields`, or one already migrated, is returned unchanged (idempotent).

It needs no catalog and loses nothing. Under the new rule an unlisted field is hidden, which
is exactly what an old visible-only array meant. A legacy non-array `visibleFields` (which
used to read as unconfigured) is dropped.

The committed `.jsonc` files are rewritten with a one-off script (a text replace that keeps
comments), so they serialize exactly as the migration does. Same constraint as
`treeViewToTable`: the config hash covers key order, so a migrated user override must match
the new committed origin byte for byte, or it goes stale.

### Readers: one rename through the seam

- `use-data-view-model.ts`: `readVisibleFields` becomes `readProperties` (only an array
  counts). `setVisibleFields` becomes `setProperties`, and an empty array or `null` clears
  the key.
- `resolve-body-fields.ts`: `resolveBodyFields(fields, properties)` keeps the listed,
  non-hidden fields in stored order, then band-orders them (`orderFieldsBySection`, as today).
  Unlisted fields are hidden, so they never reach the body.
- Call sites switch from `state.visibleFields` to `state.properties`: table, nested table,
  list, gallery, icons, `data-view-body.tsx` comments, `field-sections.ts` doc.
- `FieldDef.visible` doc and `compositions-list.tsx` comment updated.

### Controller: `usePropertiesController` (renamed from `useVisibleFieldsController`)

- `items`: absent means schema order with `visible = field.visible !== false`. With an
  array, the stored entries come first in stored order (unknown ids dropped), then unlisted
  fields appended as hidden. Then `orderItemsBySection`, as today.
- Every action (`toggle`, `move`) computes the next `items` and commits the **whole** list
  as `items.map(i => ({ id, ...(i.visible ? {} : { hidden: true }) }))`. That one write path
  is the fix: a toggle no longer drops the hidden field's position.
- `showAll` and `isCustomized` are unchanged.

### UI: eye on the right, hidden rows dimmed in place

`PropertiesControl` keeps one `SortableList` per band. Each row becomes a plain-arm
`ControlPanel.Row`:

- `handle` + `handleProps` (unchanged)
- `onSelect={toggle}`: the row is still the click target
- `muted={!visible}`: dims a hidden row in place
- `trailing={<Icon icon={visible ? visibility : visibility_off} />}`. The trailing cell is
  presentational, which matches the contract because the row is the click target.

This needs no change to ControlPanel. Accessibility: say the state on the row (`aria-pressed`
or a "Hidden" label suffix, whichever `ControlPanel.Row` passes through; check during the
work).

### Docs

`data-view/CLAUDE.md` "Per-view visible fields (Properties)" and the filter-only examples
(`visibleFields: ["label"]` becomes `properties`), `plugins/list/CLAUDE.md`, and the
regenerated plugin docs.

## Files

- `plugins/primitives/plugins/data-view/core/internal/types.ts`: `PropertyEntry`,
  `ViewState.properties`
- `.../shared/view-migrations.ts` (+ `.test.ts`): `visibleFieldsToProperties`
- `.../web/internal/use-data-view-model.ts`, `resolve-body-fields.ts` (+ test),
  `use-visible-fields-controller.ts` (renamed `use-properties-controller.ts`)
- `.../web/components/settings/properties-control.tsx`
- View bodies: `plugins/{table,list,gallery,icons}/web/components/*-view.tsx`
- Tests that seed `visibleFields`: `sections-toolbar`, `pinned-view`, `nested-filter-scope`,
  `nested-leading-field`, `gallery/list leading-field`, `field-sections.test.ts`
- `config/**/*.jsonc` (17 files) rewritten by the script

## Verification

1. `./singularity test plugins/primitives/plugins/data-view`. New cases:
   - Controller: hide then show returns a field to its index. Hiding keeps its place in the
     committed list. An unlisted field shows as hidden at the end of its band. A move keeps
     the hidden entries.
   - Migration: rewrite keeps key position, is idempotent, leaves other rows untouched.
   - `resolveBodyFields`: hidden entries and unlisted fields are left out of the body.
2. `./singularity build` (checks include `config` origin/override sync and type-check).
3. In the browser (`browser_*` tools on this worktree's build), open the Tasks list's view
   settings, then Properties. Hide a middle field: it stays in place, dimmed, with the eye
   crossed out. Show it: same position. Reload: order persisted. Check that the committed
   views (tasks list, all-conversations) render the same columns as before.
4. Update the track page: tick [Properties] and its sub-items, drop the review sub-item,
   update Status, and file the next main task ([Entities]).
