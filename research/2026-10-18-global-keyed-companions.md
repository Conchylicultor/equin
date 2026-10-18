# Keyed companions: required-if-used contributions (DataView views and field cells)

Track: wiki *Mental model → Plugin system → Composition* (block-6b4d4ded…), item
**[Usage]**. Mental model: block-136ef01b-5cd2-4d6a-a212-7d48b46425bf.
Predecessors: `research/2026-10-15-global-token-usage-closure-edges.md` and
`research/2026-10-17-global-companion-contributions.md`.

## Context

`pack("data-views", [...])` in `plugins/plugin-meta/plugins/composition/core/config.ts:403`
hand-lists 27 plugins: three view renderers plus field-type dimension plugins. Nothing
imports any of them. They contribute to `primitives.data-view`'s slots, and DataView
resolves them at runtime by a string key:

- **View renderers.** `DataViewSlots.View({ type: "table" })`. A config row
  `{"view": {"type": "map"}}` with no renderer is silently skipped
  (`view-core/web/internal/resolve-instances.ts`). Zero rows renders "No views configured".
- **Field dimensions.** `DataViewSlots.Cell({ match: "date" })`, plus CellEditor, Filter,
  ValueCodec, ColumnConfig and Grouping. They are looked up along the type's `extends`
  chain. A missing one silently degrades: a text cell, read-only, not filterable, not
  groupable.

The pack is already wrong:
- It lacks `data-view.{map,icons}`, `fields.avatar.table`, `fields.location.{table,filter}`
  and all three `*.data-view-group` plugins.
- Only `sonata` extends it. Every other app gets whatever happens to be imported.

These plugins are needed **only when used**. `fields.date.table` is required if and only if
the bundle has a DataView *and* has date fields. Neither a plain edge nor an unconditional
companion can express that.

## Should there be one system? Yes: one flag, the slot decides the condition

The track now has four kinds of runtime need. They differ in **evidence** (how we learn
that something is needed), not in **meaning**. Each one says: "if these plugins ship,
that plugin ships."

| Kind | Rule | Evidence |
|---|---|---|
| import | A ⇒ B | `import` (cross-refs) |
| token | P ⇒ owner(G) | var / Tailwind scan (cross-refs `tokenUses`) |
| companion | owner(S) ⇒ C | `companion: true` on a slot with `companions: true` |
| **keyed companion (new)** | owner(S) ∧ R ⇒ C, for each R that references C's key | `companion: true` on a slot with `companions: { key }` + a reference index |

We unify at two levels.

1. **One authoring concept.** A contributor still writes only `companion: true`. The **slot
   owner** declares when its companions are needed:
   - `companions: true`: always (icons, fonts, slot middleware, as today).
   - `companions: { key: "match", space: "field-type" }`: only while something in the
     bundle references the contribution's key.

   The consent rule is unchanged: tsc refuses `companion` on a slot that didn't opt in.
2. **One engine concept.** The closure becomes the least fixpoint of **requirement
   rules** `{ when: PluginId[], then: PluginId, via, evidence }`.
   - Import, token and companion edges are the one-premise case. They keep living in
     `hardForward` / `hardReverse`, so nothing downstream changes.
   - Keyed companions add two-premise rules.
   - `classifyEdges` gets one explicit `via` per source. Today `"companion"` is the
     fall-through of a ternary, so a fourth source would be mislabelled.

Tokens stay a scanner edge. They fit the model as "P references key `--x`, whose provider
is G". Re-expressing them as a contribution would buy nothing.

## Design

### 1. Key spaces: a closed list in core

There are two spaces, so they are plain data rather than a slot
(`plugin-meta/closure/core/key-spaces.ts`). Each space has a **definer** marker and a
**reference** rule.

| Space | Definer (static marker parse, like `defineTokenGroup`) | Referenced by |
|---|---|---|
| `field-type` | `defineFieldType("<id>")`, e.g. `fields.date/core` | the definer itself. Anything using dates imports `dateFieldType` (via `dateField`, `FieldDef.type`), so "the type ships" is exactly "the definer is in the closure". `extends` needs nothing extra: `int` importing `numberFieldType` pulls `fields.number`, whose dimensions then follow. |
| `view-type` | the renderer's `DataViewSlots.View({ type })` | a plugin P with `defineDataView("<id>")` whose authored `config/<P path>/<id>.jsonc` has a row of `view.type` K (the path rule in `data-views.generated.ts`), plus K appearing in a literal `views={[…]}` on P's call site (the add-menu whitelist) |

Notes:
- Config is the single source of truth for a surface's views
  (`view-core/shared/internal/views-descriptor.ts`), so authored rows are the primary
  evidence.
- A `views` prop that is omitted or non-literal adds no references. The add-menu then
  offers what shipped, which is honest.

### 2. API (web-sdk, slot-declaration)

- `SlotMeta.companions` becomes `true | { key: string; space: KeySpace }`.
- `defineSlot` and `defineDispatchSlot` forward it. The overloads keep `companion?: true`
  available only where the slot opted in.
- Opt in the six slots in `primitives/data-view/web/slots.ts`:
  - `View`: key `type`, space `view-type`.
  - `Cell`, `CellEditor`, `Filter`, `ValueCodec`, `ColumnConfig`, `Grouping`: key `match`,
    space `field-type`.
- `Fields.Identity` (`fields/web/slots.ts`) is **not** keyed. The identity lives in the
  definer's own `web/`, so it ships with the type.

### 3. Facets

- **contributions facet.** For a companion on a keyed slot, the static parse also reads
  the key prop as a **string literal** (`match: "date"`). A non-literal key throws, naming
  the file, the same rule as `companion: someVar`. Contributions that spread a separate
  object have their key inlined. Example: `fields.date.filter`'s
  `DataViewSlots.Filter(dateOperatorSet)` gets `match: "date"` and `companion: true` at
  the call.
- **Definers.** Add `fieldTypes: string[]` to cross-refs, parsed with `findMarkerCalls`
  in `core/` the way `tokenGroups` is. View-type definers come from the keyed
  contributions themselves.
- **View references.** Add `viewTypeRefs: string[]` to cross-refs. They are collected in
  `prepareRelate` under `runWithFsSnapshot` (the token pass's pattern) from:
  - `defineDataView` ids → their config file → `views[].view.type`;
  - literal `views=` arrays.

  Confirm the FS snapshot covers `config/`. If it doesn't, extend `buildFsSnapshot`
  rather than reading the disk.

### 4. Engine (`plugin-meta/closure/core`)

- `EdgeGraph` gains `rules: KeyedRule[]`, where `KeyedRule` is
  `{ when: [owner, ref], then, key, space }`. They are built in `classifyEdges`:
  for each keyed companion C and each R in `refs(space, key)`, add a rule.
- Keys with no definer are reported by the check (§5), never dropped silently.
- `hardClosure` (`resolve-composition.ts:23`) becomes a fixpoint:
  1. Run the BFS.
  2. Fire every rule whose premises are all in the set.
  3. Continue the BFS from the conclusions.
  4. Repeat until stable.
  It is still linear in practice: about 45 field rules, plus view rules.
- `Edge.via` adds `"usage"`. Rules also appear in the flat `edges` as `owner → C` and
  `ref → C`, tagged `usage`, so Studio and serialize work unchanged. `explainInclusion`
  words it as: "ships because `primitives.data-view` and `fields.date` both ship
  (`date` cell)".
- **Negation.** `!fields.date.table` while both premises ship goes to
  `unsatisfiedExclusions` (loud). To drop the cell, drop a premise.
  `removalClosure` is unchanged: removing a premise leaves the conclusion unneeded, so
  it falls out on its own.
- Refactor `classifyEdges` into a list of sources `{ via, collect(tree) }` with
  first-match precedence import > token > companion > usage. Each source is explicit; none
  is a fall-through.

### 5. Guards (rungs 2–4)

- **tsc:** `companion` is refused on a slot that didn't opt in (existing).
- **Checks:**
  - Extend `closure:companions-visible` to compare runtime against static **and** the
    static key: keyed contributions are counted per `(slot, key)`.
  - New `closure:keys-defined`: every key a keyed companion names has a definer, and
    every `view.type` in an authored DataView config has a renderer contribution.
    A typo'd `"view": {"type": "tabel"}` fails the build instead of disappearing.
- **Runtime:** deferred to the track's [Guard] item (runtime asserts where a
  missing companion fails silently). `buildInstanceFromRow` still skips an orphan
  row. With renderers now derived from the authored rows and `keys-defined`
  rejecting a misspelt type, the remaining case is a renderer deleted later.

### 6. Apply and shrink

- Add `companion: true` to every dimension contribution under `plugins/fields/plugins/*/plugins/{table,inline,filter,data-view-codec,column-config,data-view-group}/web/index.ts`,
  and to the five view renderers under `primitives/data-view/plugins/{list,table,gallery,map,icons}`.
- Delete `pack("data-views")` and sonata's `["data-views"]` extend
  (`config.ts:228-231`), together with the comment telling apps to extend it.
- **Behaviour note: custom columns.** The add-column menu offers the shipped identities
  with `customColumn: true`, so an app with no date field no longer offers "Date". That
  is correct for a composition. `custom-columns` stays an optional feature and demands
  no types.

## Critical files

- `plugins/framework/plugins/slot-declaration/core/declaration.ts`, `plugins/framework/plugins/web-sdk/core/slots.ts`, slot-render's `defineDispatchSlot`
- `plugins/primitives/plugins/data-view/web/{slots.ts,cell-slot.ts,filter-slot.ts,…}`, `plugins/primitives/plugins/data-view/plugins/view-core/web/internal/resolve-instances.ts`
- `plugins/plugin-meta/plugins/facets/plugins/{contributions,cross-refs}/{core/types.ts,facet/index.ts}`
- `plugins/plugin-meta/plugins/closure/core/{types.ts,classify-edges.ts,resolve-composition.ts,explain.ts,inclusion-path.ts,serialize.ts}`, new `key-spaces.ts`, `CLAUDE.md` § Edge classification
- `plugins/framework/plugins/tooling/plugins/checks/plugins/composition-closure/check/{companions-visible.ts,keys-defined.ts}`
- `plugins/fields/plugins/*/plugins/*/web/index.ts`, `plugins/primitives/plugins/data-view/plugins/{list,table,gallery,map,icons}/web/index.ts`
- `plugins/plugin-meta/plugins/composition/core/{config.ts,config.test.ts}`

## Verification

1. **Unit (closure):**
   - `classifyEdges` builds rules `data-view ∧ fields.date ⇒ fields.date.table`, and
     `data-view ∧ apps.places.places-map ⇒ data-view.map` (from its authored rows).
   - The fixpoint fires a rule only when both premises are in the set.
   - `!fields.date.table` lands in `unsatisfiedExclusions`.
   - A parse with `match: someVar` on a keyed companion throws.
2. **Unit (runtime):** an authored row of an unregistered type renders the loud
   placeholder, not "No views configured".
3. **Bundle diff:** a one-off `./singularity run` script resolves every committed
   composition with the old and the new graph and config. It prints additions and
   removals per composition.
   - **Expect:** most apps *gain* the dimensions of the types they use, closing the
     pack's silent gaps.
   - **sonata** may *lose* dimensions of types it never references. Each removal is
     judged by hand.
4. `./singularity build`. All checks are green, including `composition-closure`,
   `companions-visible`, `keys-defined`, `plugins-doc-in-sync`, `eager-tier-in-sync`
   and `plugins-registry-in-sync`.
5. **Real served pages:**
   - `screenshot.ts --composition sonata --path <library>` shows the table view with its
     date and number cells and working filters.
   - The same check on one app that never extended the pack (e.g. `deploy`) now shows
     formatted cells instead of raw strings.

## Outcome (implemented 2026-10-18)

- Shipped as designed. Deviations:
  - Runtime placeholder deferred (above).
  - Filter operator sets lost their `match` (`Omit<FilterOperatorSet, "match">`);
    the contribution spells `{ match, companion: true, ...set }`, and the static
    props parse now skips spreads.
  - The slots facet's static parse reads `companions:` at every slot constructor,
    including standalone consts listed in their group by shorthand
    (`DataViewSlots.Cell`), resolving `export { X as Y }`.
  - Field-type references include `type: "<id>"` literals (≈295 hand-written
    `FieldDef`s spell their type as a string), kept only for defined types.
- **Bundle diff** (old = no rules, sonata + the old pack):
  - Every served app gains 22–34 plugins: the cells/filters/editors and view
    renderers its bundled DataViews use, which it previously lacked (e.g. the
    website ships the theme gallery DataView, `ui.theme-engine.theme-gallery`, and
    the background catalog; both had no renderers before).
  - The only removals: sonata's `fields.color.table` and `fields.image.table`,
    which none of its DataViews use.
  - `singularity` (main, `**`) is unchanged.
- **Verified**: `./singularity build` green (incl. `composition-closure`,
  `companions-visible`, `keys-defined`, `eager-tier-in-sync`,
  `plugins-registry-in-sync`); tests green (closure, facets, data-view,
  slot-render, fields, mail threads, studio graph, plugin-view deps);
  `./singularity build --composition sonata` serves the library's gallery and
  table views with typed cells and no pack.
- **Precision note**: a reference is plugin-level, not per DataView. A plugin
  spelling `type: "bool"` anywhere makes bool's dimensions ship wherever it and the
  data-view primitive do. That over-includes a few small leaves, but it never
  misses one.
