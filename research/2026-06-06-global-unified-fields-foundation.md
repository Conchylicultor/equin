# Implement the `fields/` primitive foundation (task 1)

## Context

Field-type behavior is fragmented between **config_v2** (an editable-scalar system keyed
by `field.type.id`) and **data-view** (a row projection with hand-written per-consumer
cells and a wired-but-unapplied filter hook point). They share *type identity* but cannot
reuse each other's renderers. The umbrella plan
[`research/2026-06-06-global-unified-fields-primitive.md`](./2026-06-06-global-unified-fields-primitive.md)
stands up a single top-level `plugins/fields/` primitive organized as a **type × capability
matrix**, mirroring the facets sub-plugin pattern.

This doc plans **task 1 of 8** — the *foundation only*. It delivers the canonical token +
identity in `fields/core` (with `extends` derivation and `coerce`), and the two new
per-type capability **slots owned by data-view** (`data-view.cell`, `data-view.filter`)
plus their dispatch wiring (extends-chain fallback + 3-tier cell precedence). Later tasks
do the visible Sonata/config validation (task 2), populate the full type taxonomy (task 3),
and migrate/unify the config_v2 token (tasks 4–8). Nothing here is load-bearing or
behavior-changing for existing consumers.

### Scope decisions (confirmed with the user)

- **Foundation only, no UI.** No filter-bar is built. The filter **predicate** is applied
  in the row pipeline (so the mechanism is real and unit-correct), but no Control is
  rendered yet — `ViewState.filters` stays empty in practice, so filtering is dormant.
  The cell dispatch *is* wired into `table-view` but produces byte-identical output for
  today's consumers (Sonata's fields either carry a `cell` override → tier ①, or are
  `text` with no contributed type cell → tier ③ `String`). Net visible change: none.
- **Widen `type` only, keep the name.** `data-view`'s `FieldDef.type` widens from the
  closed union to an open `string` id (needed to register a derived `int`). The
  `FieldDef` → `FieldProjection` rename is **deferred to task 2** per the umbrella plan.
- **No config_v2 changes.** `fields/core` defines its own token fresh (byte-identical
  shape to config_v2's). The temporary `config_v2/core` re-export is **task 4**, so no
  boundary-check exception is needed now.
- **Minimal contributors to exercise the slots:** `fields/plugins/number` (base: identity
  + cell + filter) and `fields/plugins/int` (identity only, `extends: number`). The pair
  exercises the cell/filter dispatch *and* the extends-chain fallback (`int` → miss →
  `number` → hit). No other types are populated.

## Architecture & dependency direction

```
fields/core        ── pure browser-safe sink: FieldType token + FieldIdentity + resolveTypeChain
   ▲        ▲                  ▲
fields/web  data-view/{core,web}     (data-view → fields/core is TYPE-only)
   ▲                  ▲      ▲
fields/plugins/number/web  fields/plugins/int/web   (→ fields/web identity slot + → data-view/web cell/filter slots)
```

- `fields/core` depends on nothing (only a type-only `ComponentType` from react for the
  identity icon). Mirrors `facets/core` browser-safety. See memory
  *facets/core is browser-safe* / *Facet core must stay browser-safe*.
- `fields/web` (umbrella barrel) owns the **identity registry slot** `fields.identity`.
  This is the *type-dimension* registry — legitimately owned by `fields`, not a capability
  slot. The two **capability** slots stay owned by their consumer (`data-view`), per the
  facets rule.
- `data-view/web` reads the identity registry **by string-literal id** (`bySlot.get(
  "fields.identity")`) — the sanctioned facets practice — so it has **no import edge** to
  `fields/web`; its only edge is the type-only import of `FieldIdentity` + value import of
  `resolveTypeChain` from `fields/core`. This matches the umbrella plan's DAG exactly.
- The `number`/`int` leaf plugins point *up* at both `fields/web` (identity) and
  `data-view/web` (cell/filter). No cycle: `fields/web` and `data-view/web` never import a
  `fields/plugins/*` leaf.

## Files

### New plugin: `plugins/fields/`

```
plugins/fields/
  package.json                         { name, description, singularity:{collapsed:true} }  (umbrella)
  CLAUDE.md                            prose only — build codegen inserts the AUTOGEN block
  core/
    index.ts                           barrel: defineFieldType, defineFieldIdentity, resolveTypeChain + types
    internal/
      types.ts                         FieldType<T>, FieldMeta, FieldIdentity<T>
      define.ts                        defineFieldType, defineFieldIdentity
      resolve.ts                       resolveTypeChain(typeId, Map<string, FieldIdentity>): string[]
  web/
    index.ts                           default PluginDefinition (no contributions) + export { Fields }
    slots.ts                           Fields.Identity = defineSlot<{ identity: FieldIdentity }>("fields.identity")
  plugins/
    number/
      package.json, CLAUDE.md
      core/index.ts + internal/number.ts   numberFieldType + numberIdentity (coerce: v=>Number(v))
      web/index.ts                          contributes Fields.Identity + DataViewSlots.Cell + DataViewSlots.Filter
      web/components/number-cell.tsx        read-only cell: String(value)
      web/components/number-filter.tsx      Control (min/max) — carried, not rendered yet
      web/internal/number-filter-logic.ts   predicate {min,max} + isActive
    int/
      package.json, CLAUDE.md
      core/index.ts + internal/int.ts       intFieldType + intIdentity (extends: numberFieldType)
      web/index.ts                          contributes Fields.Identity ONLY (no cell/filter → exercises extends)
```

`fields/core/internal/types.ts` — copy the token shape byte-for-byte from
`config_v2/core/internal/types.ts`, add identity:

```ts
import type { ComponentType } from "react";

export interface FieldType<T = unknown> {
  readonly id: string;
  readonly _T?: T;            // phantom — inference only
}

export interface FieldMeta {
  label?: string; description?: string; placeholder?: string; typeHint?: string;
}

export interface FieldIdentity<T = unknown> {
  readonly type: FieldType<T>;
  readonly label?: string;
  readonly icon?: ComponentType<{ className?: string }>;
  /** Base type whose table/filter contributions this type inherits (one hop in practice). */
  readonly extends?: FieldType;
  /** Projection to a sortable/comparable scalar (Date→ms, bool→0/1, …). */
  readonly coerce?: (value: T) => string | number | null;
}
```

`define.ts`:

```ts
export function defineFieldType<T>(id: string): FieldType<T> { return Object.freeze({ id }); }
export function defineFieldIdentity<T>(identity: FieldIdentity<T>): FieldIdentity<T> {
  return Object.freeze(identity);
}
```

`resolve.ts` — pure, the single source of extends-chain truth, reused by both data-view
slots:

```ts
/** [typeId, ...ancestors] following `extends`; cycle-guarded; unknown ids resolve to [typeId]. */
export function resolveTypeChain(
  typeId: string,
  identities: ReadonlyMap<string, FieldIdentity>,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = typeId;
  while (cur && !seen.has(cur)) {
    chain.push(cur); seen.add(cur);
    cur = identities.get(cur)?.extends?.id;
  }
  return chain;
}
```

### Changes to `plugins/primitives/plugins/data-view/`

**`core/internal/types.ts`**
- `FieldDef.type?: FieldType` → `type?: string` (open to the registry id). Keep the
  `FieldType` union export as a deprecated back-compat alias for now (gallery's
  `f.type === "media"` / `"text"` comparisons still compile against `string`); it is
  deleted in task 2. Keep `FieldDef` name, `ViewState.filters`, `setFilter` **unchanged**.
- Add the two new capability prop contracts (mirror the umbrella plan):
  ```ts
  export interface TableCellProps {
    value: FieldValue;                 // = field.value(row), already projected
    field: FieldDef<unknown>;          // for options/align context
    raw?: unknown;                     // the row — escape hatch only, non-canonical
  }
  export interface FilterControlProps {
    value: unknown;                    // ViewState.filters[fieldId]
    onChange: (value: unknown) => void;
    field: FieldDef<unknown>;
  }
  export interface FilterContribution {
    match: string;                     // field type id
    Control: ComponentType<FilterControlProps>;
    predicate: (filterValue: unknown, fieldValue: FieldValue) => boolean;
    isActive: (filterValue: unknown) => boolean;
  }
  ```

**`web/cell-slot.ts` (new)** — `DataViewSlots.Cell = defineDispatchSlot<TableCellProps>(
"data-view.cell", { key: p => p.field.type ?? "text", docLabel })`. Used for the typed
`{ match, component }` contribution shape + `bySlot` registration; **resolution is custom**
(see below), so `.Dispatch` is not used (defineDispatchSlot's built-in dispatch can't walk
`extends`). Export a hook `useResolveCell(): (field, props) => ReactNode | undefined` that:
reads identities → `resolveTypeChain(field.type)` → first chain id present in the cell
contributions → `renderIsolated("data-view.cell", rawContribution, props)`. (`renderIsolated`
is the documented primitive for bespoke tiered selection.)

**`web/filter-slot.ts` (new)** — `DataViewSlots.Filter = defineSlot<FilterContribution>(
"data-view.filter", { docLabel: c => c.match })`. Plain slot (carries predicate/isActive
functions + the `Control`, which stays a renderable `ComponentType` for the future
filter-bar — not rendered in this task). Export `useFilterMap(): (typeId) =>
FilterContribution | undefined` that resolves through `resolveTypeChain`.

**`web/internal/use-field-identities.ts` (new)** — reads `ctx.bySlot.get("fields.identity")`
by string-literal id (no `fields/web` import), `useMemo`s a `Map<string, FieldIdentity>`
from each contribution's `.identity`. Shared by both resolver hooks above.

**`web/internal/use-data-view-rows.ts`** — at the marked no-op hook point (line ~42,
between search and sort), resolve `state.filters` against the filter map: for each
`[fieldId, filterValue]`, find the field, resolve its filter contribution via
`resolveTypeChain`, skip when `!isActive(filterValue)`, else keep rows where
`predicate(filterValue, field.value?.(row))`. The hook gains the filter map as input
(threaded from `<DataView>` via `useFilterMap`, computed at the component level — the
`useConfigRegistrations` pattern). With no Control writing filters yet, this is a
behavior-preserving no-op today; the wiring is exercised by unit-level reasoning and is
ready for task 2's filter bar.

**`web/index.ts`** — extend the exported `DataViewSlots` with `Cell` and `Filter`; export
the new prop types (`TableCellProps`, `FilterControlProps`, `FilterContribution`) and the
resolver hooks. Keep `contributions: []`.

**`plugins/table/web/components/table-view.tsx`** — replace `cell: f.cell` with the
**3-tier precedence** (strictly additive): build `cell` per column as
① `f.cell` (consumer override) → ② `useResolveCell()(f, { value: f.value?.(row), field: f,
raw: row })` when it resolves → ③ `String(f.value?.(row) ?? "")` (today's data-table
fallback). Tiers ②/③ only apply when `f.cell` is absent, so every current consumer is
unaffected.

## Non-goals (explicit — deferred to later tasks)

- No filter-bar UI / no Control rendering (task 2+).
- No `FieldDef` → `FieldProjection` rename, no `FieldType`-union deletion (task 2).
- No `config_v2` edits, no token re-export, no boundary-check exception (task 4).
- No additional field types beyond `number`/`int` (task 3).
- No Sonata changes (its cell overrides keep tier ① — untouched).

## Risks / gotchas

- **`number`/`int` contributions must not be dead.** They are reachable by the resolver and
  proven by the extends chain; their dormancy (no field uses them visibly yet) is expected
  and documented — task 2 makes them visible. Do not delete them as "unused."
- **New plugin discovery** is filesystem-autogenerated (`web.generated.ts`) — no manual
  `plugins.ts` edit. Run `./equin build` to regenerate.
- **CLAUDE.md autogen**: write prose only; the build inserts the `## Plugin reference`
  block (memory *CLAUDE.md autogen block*). New `Core.*`-style slots are not added, so the
  docgen barrel-import stub needs no change.
- **No authored `id:` in barrels**; loader derives plugin ids from path (memory *Plugin id
  derived from path* / *New barrel conventions*). Barrels stay pure (imports + single
  default export + the `Fields` slot namespace re-export).
- Keep `fields/core` free of any fs/server import so vite can bundle it browser-side.

## Verification

- `./equin build` succeeds; `./equin check` passes (plugin-boundaries — no
  exception needed this task — migrations-in-sync, eslint, plugins-doc-in-sync).
- Open `http://<worktree>.localhost:9000` → Sonata → Library → **Table**: renders exactly
  as before (duration via its `cell` override = tier ①; title/composer via `String` =
  tier ③). No regression, no new control. (Visible per-type behavior is task 2.)
- Grep confirms no `switch(field.type)` in `use-data-view-rows.ts` — filtering goes through
  the `data-view.filter` slot only (the umbrella plan's #1 risk).
- Reasoned dispatch check (the foundation's real exercise): a field with `type: "int"` and
  no `cell` override resolves `int` → miss in `data-view.cell` → `number` (via `extends`) →
  `NumberCell`; and resolves its filter the same way. Confirm by a throwaway local field or
  a follow-up in task 2 — no permanent demo is added here.

## Critical files

- `plugins/config_v2/core/internal/types.ts` — token shape to copy byte-for-byte.
- `plugins/plugin-meta/plugins/facets/` — the type×capability template (browser-safe core,
  leaf-consumer dependency direction, read-by-string-id practice).
- `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx` —
  `defineDispatchSlot` / `defineSlot` / `renderIsolated` primitives.
- `plugins/primitives/plugins/data-view/core/internal/types.ts` — `type` widen + new
  contracts.
- `plugins/primitives/plugins/data-view/web/internal/use-data-view-rows.ts` — predicate
  application site (line ~42).
- `plugins/primitives/plugins/data-view/plugins/table/web/components/table-view.tsx` —
  3-tier cell insertion site.
- `plugins/primitives/plugins/data-view/web/{index.ts,slots.ts}` — slot export site.
</content>
</invoke>
