# Design: saved/shareable sort presets for the data-view sort builder

Status: **implementation contract** — chained from
[`research/data-view-generic-sort-vision.md`](./data-view-generic-sort-vision.md)
non-goal *"Saving sorts as shareable presets beyond the existing per-view
persistence."* The multi-level sort builder and type-specific direction labels
have already landed; this layers named, reusable sort **presets** on top.

## Goal

Notion-style **saved sort presets**: named `{ label, rules: SortRule[] }` entries
authored in (and promotable through) the **same per-surface config JSON** that
already backs the view instances, surfaced in the sort builder popover as
one-click *"apply this preset"* options. Applying a preset writes its rules into
the active view's live per-view sort (composing with the existing persistence),
and the rule preview stays type-aware (reuses the shipped field-identity
direction labels).

## Decisions (the resolved design questions)

1. **Where presets live — a sibling top-level key, scoped per data-view id.**
   Presets reference `fieldId`s, which only make sense on the surface that
   declares those fields, so a per-id scope (not a global library) is correct and
   matches the existing per-id config file. They land as a **sibling key
   `sortPresets`** next to `views` in the *same* `config/<plugin>/<id>.jsonc`
   file — git-committable and promotable exactly like `views`. Mirrors how the
   per-view `sort` already rides inside the same file.

2. **view-core stays generic — the field is *injected*, never named by the
   engine.** The seam invariant ("view-core never names `sort`/`filter` or any
   host concern") is preserved: `viewsDescriptor` gains a generic
   `extraFields?: FieldsRecord` extension point; the **data-view host** is the one
   that declares `sortPresets`. view-core merely persists an opaque extra sibling
   field the consumer owns and reads itself.

3. **Surface in the popover — a Presets section above the rule editor.** A
   `PresetList` renders at the top of the sort popover (in both the empty-state
   and populated-state branches), hidden entirely when there are no presets.
   Each row applies on click and carries a hover-revealed delete.

4. **Apply vs save.** *Apply* = write the preset's (resolvable) rules into the
   active view's live sort via the existing `SortController.setRules`. *Save
   current sort as preset* = a footer affordance (next to "Delete sort", shown
   only when there are live rules) that captures `controller.rules` under a typed
   name. Rename + delete complete the CRUD.

## Data model

### `SortPreset` (core type)

Add to `core/internal/types.ts` next to `SortRule`, export from `core` + `web`:

```ts
/** A named, reusable multi-level sort. `rules` priority = list order. */
export interface SortPreset {
  /** Stable id (React key + delete/rename target; persisted in the config row). */
  id: string;
  label: string;
  rules: SortRule[];
}
```

### Config storage shape (`config/<plugin>/<id>.jsonc`)

A new sibling key, terse-authorable, next to `views`:

```jsonc
{
  "views": [ /* unchanged */ ],
  "sortPresets": [
    {
      "label": "Priority then due",
      "rules": [
        { "fieldId": "priority", "direction": "desc" },
        { "fieldId": "due", "direction": "asc" }
      ]
    }
  ]
}
```

`id`/`rank` on each preset and each rule are config-injected on persist (listField
behavior) and stripped on read — authored rows stay terse.

### Config field definition (declared by **data-view**, injected into view-core)

New plugin-private module `plugins/primitives/plugins/data-view/shared/sort-presets-field.ts`:

```ts
import type { FieldsRecord } from "@plugins/fields/core";
import { listField } from "@plugins/fields/plugins/list/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { enumField } from "@plugins/fields/plugins/enum/plugins/config/core";

/** Sibling config field the data-view host injects into view-core's
 *  `viewsDescriptor`. Lives in `shared/` so the web descriptor map and the
 *  server registrations import the SAME field def (one definition, two runtimes).
 *  view-core never names this — it is an opaque consumer-owned extra field. */
export const sortPresetsExtraFields: FieldsRecord = {
  sortPresets: listField({
    label: "Sort presets",
    itemFields: {
      label: textField({ label: "Label" }),
      rules: listField({
        label: "Rules",
        itemFields: {
          fieldId: textField({ label: "Field" }),
          direction: enumField({
            label: "Direction",
            options: ["asc", "desc"],
            default: "asc",
          }),
        },
      }),
    },
  }),
};
```

> Nested `listField` is proven (`review/code-review` config uses it).
> `enumField` constrains direction to `"asc" | "desc"` via `z.enum`. **Verify
> `enumField`'s config-core barrel is server-import-safe** when the descriptor is
> built on the server (the views-descriptor already builds `variantField`
> server-side without its web `useVariants`, so core builders are designed
> server-safe). If `enumField` pulls web code, fall back to
> `textField({ label: "Direction" })` — the read path coerces/guards the string
> anyway.

## view-core changes (generic extension point — respects the seam)

**`shared/internal/views-descriptor.ts`** — `viewsDescriptor(id, extraFields?)`:

```ts
export function viewsDescriptor(
  id: string,
  extraFields?: FieldsRecord,
): ConfigDescriptor {
  // cache key must fold in extraFields presence so a (id, fields) pair is stable.
  // data-view passes one stable module-constant per runtime, so keying by id is
  // safe in practice; keep the cache but document the "extraFields stable per id"
  // invariant.
  ...
  fields: {
    views: listField({ ... }),   // unchanged
    ...extraFields,              // consumer-injected sibling fields (opaque to the engine)
  },
}
```

Thread `extraFields` through the two builders consumers call:

- **web** `build-descriptors.ts` → `buildViewDescriptors(ids, extraFields?)` →
  `viewsDescriptor(id, extraFields)` for every id.
- **server** `config-registrations.ts` →
  `buildViewConfigRegistrations(entries, extraFields?)` →
  `viewsDescriptor(e.id, extraFields)`.

Update `view-core/CLAUDE.md`: document the generic `extraFields` extension point
and that it does **not** breach the seam (the engine still never names sort —
the consumer declares and reads the field). Do **not** put `sortPresets` anywhere
in view-core.

> **Caching note:** the canonical reference holders are the maps built once in
> data-view (`descriptors.ts` web; the per-entry server registrations). The
> internal id cache is belt-and-suspenders; with a single consumer passing a
> stable `extraFields`, identity holds. Add a short comment to that effect.

## data-view wiring

### Descriptor map + registrations pass the extra fields

- **web** `web/internal/descriptors.ts`:
  `buildViewDescriptors(dataViews.map(v => v.id), sortPresetsExtraFields)`.
- **server** `server/internal/config-registrations.ts`:
  `buildViewConfigRegistrations(entries, sortPresetsExtraFields)`.

Now `dataViewDescriptors.get(storageKey)` is a descriptor whose schema includes
`sortPresets`, so `useConfig`/`useSetConfig` round-trip it.

### Pure helpers — `web/internal/sort-presets.ts` (unit-tested)

```ts
/** Read + normalize the raw config `sortPresets` into SortPreset[] (strip
 *  injected id/rank on rules; tolerate absent/legacy). */
export function readSortPresets(raw: unknown): SortPreset[];

/** Filter a preset's rules to those whose field still resolves (dangling-safe);
 *  used both for apply and for the resolvable-count badge. */
export function resolvableRules(
  rules: SortRule[],
  sortableFields: FieldDef<unknown>[],
): SortRule[];

/** True when `rules` equal a preset's rules by ordered (fieldId, direction). */
export function presetMatchesRules(preset: SortPreset, rules: SortRule[]): boolean;
```

Co-locate `sort-presets.test.ts` (bun:test) covering: terse read, injected-id
strip, dangling filter, exact/ordered match, empty/legacy input.

### Hook — `web/internal/use-sort-presets.ts`

```ts
export interface SortPresetsController {
  presets: SortPreset[];
  savePreset: (label: string, rules: SortRule[]) => void; // append (explicit id)
  deletePreset: (id: string) => void;
  renamePreset: (id: string, label: string) => void;
}
export function useSortPresets(storageKey: string): SortPresetsController;
```

- Resolve `descriptor = dataViewDescriptors.get(storageKey)` (same map). Throw a
  clear error if missing (mirror `useViewsConfig`).
- `useConfig(descriptor)` → `readSortPresets(config.sortPresets)`;
  `useSetConfig(descriptor)`.
- Keep a light optimistic mirror (mirror `useViewsConfig`'s
  `useState`+JSON-guarded reconcile effect), but **write immediately** on each
  discrete action (no debounce — these are explicit clicks, unlike sort typing).
- Writes go through `setConfig("sortPresets", next)` — an independent key; the
  server merges per-key over the freshest base, so it never clobbers `views` (and
  vice-versa).
- `savePreset` appends `{ id: presetId(), label, rules }` (explicit stable id so
  the optimistic row and the persisted row share identity across round-trip).
  `presetId()` = `preset-${Math.random().toString(36).slice(2,10)}` (mirror
  view-core `newId`).

## UI — mirror the sort/filter builder folder shape

New folder `web/components/sort/presets/`:

1. **`preset-list.tsx`** — `<PresetList presets sortableFields activeRules
   onApply onDelete />`. Renders nothing when `presets.length === 0`. Otherwise a
   `SectionLabel` ("Presets") + a `Stack gap="xs"` of `PresetRow`. Caps nothing;
   list is short by nature.

2. **`preset-row.tsx`** — one preset. A `Row`/`Frame`-based clickable line:
   - leading: label (`TruncatingText`) + a compact rules preview — each
     resolvable rule as field label + direction arrow (`MdArrowUpward/Downward`),
     using `useResolveDirectionLabels(field.type)` for the arrow tooltip/aria
     (type-aware reuse). Render dangling rules muted / omitted.
   - active indicator (check) when `presetMatchesRules(preset, activeRules)`.
   - trailing: hover-revealed delete `IconButton` (reuse
     `useHoverReveal`/`hoverRevealClass`, as `sort-rule-row.tsx` does).
   - click anywhere on the row body → `onApply(preset)` (apply resolvable rules);
     if a preset has **zero** resolvable rules, render it disabled+muted with a
     tooltip ("No matching fields"), delete still available.

3. **`save-preset-affordance.tsx`** — `<SavePresetAffordance onSave disabled />`.
   A ghost `Button` ("Save sort as preset", `MdBookmarkAdd`/`MdSave`) opening an
   `InlinePopover` with a text `Input` + Save button; Enter submits, empty name
   disables Save. Mirror `AddSortAffordance`'s button→popover pattern. Disabled
   when there are no live rules.

### `sort-builder-popover.tsx`

Extend signature to `{ controller, presets, onClose }` (`presets:
SortPresetsController`). Compose apply/save inside (keeps the presets hook
decoupled from the sort controller):

- `onApply = (p) => controller.setRules(resolvableRules(p.rules, controller.sortableFields))`
- `onSave  = (label) => presets.savePreset(label, controller.rules)`
- `onDelete = presets.deletePreset`

Layout (top → bottom):

```
<PresetList ... />                 // only if presets.length > 0
<DropdownMenuSeparator/>           // only if the list rendered
… existing empty-state picker OR rule list + AddSortAffordance …
<DropdownMenuSeparator/>
<Frame leading={ <SavePresetAffordance/> (rules>0) + <Delete sort> }>
```

### `sort-builder-trigger.tsx`

Add a `presets: SortPresetsController` prop, forward it to the popover. The pill
label is unchanged (still counts live rules).

### `data-view.tsx`

- Call `const sortPresets = useSortPresets(props.storageKey)` unconditionally in
  `DataViewInner` (next to the sort controller).
- `{hasSort ? <SortBuilderTrigger controller={sortController} presets={sortPresets} /> : null}`.

## Build + checks (mandatory mechanical steps)

Adding the `sortPresets` field changes each data-view descriptor's **defaults**,
so every `<id>.origin.jsonc` regenerates with a **new `// @hash`**, and the
`config-origins-in-sync` check then fails on the 16 committed `<id>.jsonc`
overrides whose `@hash` is now stale. After `./equin build`:

1. The build regenerates `config/<plugin>/<id>.origin.jsonc` (new hash) for all
   16 data-view ids (see `shared/data-views.generated.ts`).
2. **Re-stamp** each committed `config/<plugin>/<id>.jsonc` first line `// @hash …`
   to match its sibling `.origin.jsonc` first line. Do all 16 mechanically (read
   each origin's first line, patch the override's first line). The 16 ids/plugin
   paths are enumerated in `data-views.generated.ts`.
3. Run `./equin check config-origins-in-sync` and `./equin check
   data-view:configs-authored` — both must pass. Run `type-check`.
4. Optionally seed one or two example presets in a worked-example config (e.g.
   `config/apps/sonata/library/sonata.library.jsonc`) so the feature is visible.

> Do **not** hand-edit `.origin.jsonc` (generated). Only re-stamp the override
> `.jsonc` `@hash` lines.

## Non-goals (this task)

- Cross-surface / global preset library (presets are per-id by design).
- Updating an existing preset in place from the current sort ("overwrite preset")
  — v1 is save-as-new + rename + delete.
- Reordering presets via DnD (the list is short; rank is config-injected).
```
