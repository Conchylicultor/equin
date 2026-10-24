# Config-tree DataView filters via typed fields

## Context

The config settings surface (`Settings → Config`) renders every registered
config as a Notion-like **DataView tree** (`ConfigNav`). Today its only filter is
a single ad-hoc `Modified` toggle chip (a local `useState` that pre-filters rows
before they reach `<DataView>`), and the tree is noisy: alongside hand-authored
configs it lists dozens of **auto-generated** configs — one per reorderable render
slot (`reorderDirectiveDescriptor`, from every `defineRenderSlot`) and one per
DataView consumer (`viewsDescriptor`) — with no way to tell them apart or filter
them out.

The user wants to filter by:
- **user-edited values** (config differs from its code default),
- **configs with conflicts**,
- **auto-generated configs** (reorder slot directives + data-view view configs),
  each row carrying a **tag** for its source.

The deeper goal is to make the **data-view primitive more flexible**: rather than
bolt on more bespoke chips, we express these as **typed `FieldDef`s** on the
config rows. Once `modified` / `conflict` / `source` are real fields, the
data-view's existing filter-rule builder, sort, and (future) grouping all work on
them *generically* — the same machinery any other DataView consumer gets for free.
This is the pattern to document so the next agent extends it instead of adding
one-off UI.

## Key facts (from exploration)

- **The filter UI is already present and auto-enabling.** `<DataView>` renders a
  `FilterBuilderTrigger` ("Filter" pill) whenever any `FieldDef.type` resolves a
  `FilterOperatorSet` via the `DataViewSlots.Filter` slot
  (`use-filter-controller.ts`). The config nav's existing `label` (text) field
  already trips this — no prop is needed to "turn on" filtering.
- **In the tree view only the `primary` field renders.** Non-primary `bool`/`enum`
  fields are invisible in the tree body but fully participate in filtering
  (`tree-view.tsx` renders only `pickPrimaryField`). So adding filter-only fields
  has **zero** visual cost in the tree.
- **`bool` and `enum` operator sets are already globally registered**
  (`fields.bool.filter`, `fields.enum.filter`). A consumer just writes
  `type: "bool"` / `type: "enum"` (+ `options` for enum) on a `FieldDef` — no new
  field-type plugin.
- **Tree filtering is subtree-preserving** (`tree-view.tsx` keeps matched rows +
  their ancestors), exactly mirroring the current hand-rolled `visibleRows` logic —
  so moving to native filters is behavior-preserving, not a regression.
- **Default-mode filter state** persists to
  `localStorage["config_v2.settings.nav:view-state"][viewId].filter`. The config
  nav is default-mode (no `viewsDescriptor` registration), so no backend wiring.
- **Data sources already exist:** `configV2ModifiedCountsResource` (effective ≠
  code default — the chosen "any value ≠ default" semantics) and
  `configV2ConflictPathsResource`. The nav already reads both via `modifiedCountOf`
  / `hasConflictOf`.
- **No source/origin discriminator exists on `ConfigDescriptor`.** Auto-generated
  configs are only distinguishable by heuristics today. Per the repo's
  "fix the structural issue" rule, we add an explicit discriminator set by the two
  generators. **Name it `source`, not `origin`** — `origin` already means the
  `.origin.jsonc` code/git layer in config_v2 and would collide.

## Design

### 1. Structural: a `source` discriminator on `ConfigDescriptor`

`plugins/config_v2/core/internal/types.ts`
- Add `export type ConfigSource = "manual" | "reorder" | "view";`
- Add `readonly source?: ConfigSource;` to `ConfigDescriptor`.

`plugins/config_v2/core/internal/define-config.ts`
- Accept `source?: ConfigSource` in `defineConfig` opts; default it:
  `source: opts.source ?? "manual"`. Every descriptor is then self-describing.

`plugins/config_v2/core/index.ts`
- Export the `ConfigSource` type from the core barrel.

Generators set their source:
- `plugins/reorder/shared/directive.ts` → `defineConfig({ source: "reorder", … })`.
- `plugins/primitives/plugins/data-view/shared/views-config.ts` →
  `defineConfig({ source: "view", … })`.

`manual` is the default for every hand-authored `defineConfig`, so no other
plugin changes are needed.

### 2. Config nav: replace the ad-hoc chip with three typed fields

`plugins/config_v2/plugins/settings/web/components/config-nav.tsx`
- **Remove** `showModifiedOnly` state, the `visibleRows` memo, the `FilterChip`
  `actions` prop, and the `filter-chips` import. Pass `rows={rows}` directly to
  `<DataView>`. Keep `modifiedCountOf` / `hasConflictOf` (still used by the trailing
  badge and the new field accessors).
- Expand the `fields` memo (now depending on `modifiedCountOf` / `hasConflictOf`)
  to four fields:
  ```ts
  [
    { id: "label", label: "Name", primary: true, value: (r) => r.label },
    { id: "modified", label: "Modified", type: "bool", filterable: false,
      value: (r) => modifiedCountOf(r) > 0 },
    { id: "conflict", label: "Conflict", type: "bool", filterable: false,
      value: (r) => hasConflictOf(r) },
    { id: "source", label: "Source", type: "enum", filterable: false,
      options: [
        { value: "manual",  label: "Authored" },
        { value: "reorder", label: "Reorder"  },
        { value: "view",    label: "View"      },
      ],
      value: (r) => r.registration?.descriptor.source ?? undefined },
  ]
  ```
  - `filterable: false` keeps these out of the full-text **search** accessor; they
    remain fully usable in the **filter builder** (the builder gates on operator-set
    resolution, not on `filterable`). Group/header rows (`registration === null`)
    yield `undefined` source → excluded by a `source is …` rule, with their matched
    descendants pulling them back via subtree preservation.
- The native "Filter" pill now offers `Name` / `Modified` / `Conflict` / `Source`
  rules (e.g. *Modified is Checked*, *Conflict is Checked*, *Source is not View*).

### 3. Surface the source as a row tag

`plugins/config_v2/plugins/settings/web/components/config-row-badge.tsx`
- Accept a `source?: ConfigSource` prop; render a small muted `Badge`
  (`@plugins/primitives/plugins/css/badge/web`) reading "Reorder" / "View" for
  non-`manual` sources (nothing for `manual`, to avoid noise). Keep the existing
  conflict warning + modified-count precedence; the source chip sits alongside.
- Pass `source={r.registration?.descriptor.source}` from the `treeOptions.trailing`
  in `config-nav.tsx`.

### 4. Document the vision

- `plugins/primitives/plugins/data-view/CLAUDE.md` (**Filtering** section): add a
  note that **typed `FieldDef`s are the generic extension point** — a consumer adds
  `bool`/`enum`/etc. fields (filter-only in the tree, zero visual cost) and gets the
  filter builder, sort, and future grouping for free; prefer this over bespoke
  toolbar chips. Reference the config nav as the worked example.
- `plugins/config_v2/CLAUDE.md`: document the new `source` discriminator
  (`manual` | `reorder` | `view`), why it's `source` and not `origin` (layer-name
  collision), that generators set it, and that the settings nav filters/tags on it.

## Files to modify

- `plugins/config_v2/core/internal/types.ts` — `ConfigSource` type + field.
- `plugins/config_v2/core/internal/define-config.ts` — passthrough + default.
- `plugins/config_v2/core/index.ts` — export `ConfigSource`.
- `plugins/reorder/shared/directive.ts` — `source: "reorder"`.
- `plugins/primitives/plugins/data-view/shared/views-config.ts` — `source: "view"`.
- `plugins/config_v2/plugins/settings/web/components/config-nav.tsx` — fields,
  drop the ad-hoc chip.
- `plugins/config_v2/plugins/settings/web/components/config-row-badge.tsx` — source tag.
- `plugins/primitives/plugins/data-view/CLAUDE.md` + `plugins/config_v2/CLAUDE.md` — docs.

## Verification

1. `./equin build` (regenerates nothing schema-wise here; just compiles +
   restarts). Confirm no type/lint errors and the server boots.
2. `./equin check` — exercise `config-origins-in-sync` etc.; adding a
   defaulted `source` to descriptors must not change any generated origin hash
   (the field lives on the descriptor object, not in the config document/schema —
   confirm the check stays green).
3. Scripted Playwright on `http://<worktree>.localhost:9000` → Settings → Config:
   - Open the "Filter" pill, add **Modified is Checked** → only modified configs +
     ancestors remain.
   - Add **Conflict is Checked** → only conflicting configs remain.
   - Add **Source is not View** (and/or **is Reorder**) → auto-generated view
     configs hidden / reorder configs isolated.
   - Confirm reorder/view rows show their source **tag**, and hand-authored rows
     don't.
   Use `e2e/screenshot.mjs --url …/settings --click "Filter"` for before/after.
4. Reload the page → confirm the filter persists (localStorage default-mode state).
