# ST3 — `views` config descriptor + polymorphic instance row

> Sub-task **ST3** of [research/2026-06-15-global-unified-view-switcher.md](./2026-06-15-global-unified-view-switcher.md).
> Scope: the **storage layer** for config-driven named view-instances. The resolver/render
> wiring + switcher edit UX is **ST4** (out of scope here).

## Context

`data-view` renders a typed `FieldDef[]` source through swappable view-types (gallery / table /
tree / list). Today the set of views is fixed in code: `useResolvedInstances` synthesizes exactly
**one instance per registered view-type** (`id === type`, `name === title`). There is no way for a
user or agent to declare **N named instances of the same view-type**, each with its own saved
sort/filter/options — the Notion "Todo / Board / Done" model.

ST3 adds the **data model + persistence** for that: a per-consumer, git-committable config list of
named instances, and a new **type-dispatched (`variant`) field** under `fields/` so each instance's
`options` blob is shaped by the chosen view-type. This is the roadmap's riskiest increment because
everything downstream (ST4 resolver, ST5 reference set, ST6 extraction, ST7 tasks) depends on this
data model. The intended outcome of ST3 alone: a hand-authored `views.jsonc` round-trips through
build → origin → config load → per-type validation, with zero behavioral change to existing
consumers.

### What ST1/ST2 already landed (verified)

- **ST1 done.** `plugins/primitives/plugins/view-switcher/` exists; `data-view`'s switcher delegates to it.
- **ST2 done.** `DataViewContribution` already carries the full target shape
  `{ type, title, icon, order?, hierarchical?, configSchema?, component }` (`slots.ts:9`).
  `configSchema?: FieldsRecord` is **forward-declared for ST3** and currently unused. `ViewInstance`
  (`{ id, name, type, options? }`) and `useResolvedInstances` (default-synthesis) are in place
  (`web/internal/resolve-instances.ts`).
- **Already true (roadmap predates this):** per-view **sort + filter are already in config_v2**, not
  localStorage. `use-view-state.ts` persists them via a **single global `viewStateDescriptor`**
  (`shared/view-state-config.ts`) whose one `surfaces: jsonField<Record<storageKey, …>>` field holds
  every surface's `{ activeView, views:{ [viewId]:{sort,filter} } }`. localStorage now only holds
  `query` + tree `expanded`. **This is the existing precedent we mirror the *shape* of but
  deliberately diverge from** (see Decisions). `viewStateDescriptor` is untouched by ST3; ST4 will
  migrate sort/filter from it into each instance's `options`.

## Decisions (confirmed with user)

1. **Storage model = per-consumer `views.jsonc`** (mirrors `reorder`), not the single global
   surfaces-map. Each opting-in DataView consumer registers its **own** `views` config descriptor
   under its plugin tree → git-committable per plugin, per-app scopable, and editable through the
   standard config field renderer.
2. **`options` = a new generic type-dispatched field under `fields/`** (the `variant` field), not a
   data-view-local json blob. Honors the type-dimension-owned-by-`fields/` rule and is reusable.

### Deliberate divergence from the roadmap's mechanism (and why)

The roadmap feared surfaces are "invisible to the server → needs a build-time manifest (mirror
`reorderable-slots.generated.ts`) + a new `*-in-sync` check." That fear assumes auto-discovery of
`<DataView storageKey="…">` call sites. We avoid it: **registration is opt-in and explicit per
consumer.** `reorder` needs a generated manifest because reorderable slots are auto-discovered facets
that can't self-register; DataView surfaces are ordinary call sites whose owning plugin can add two
lines to its `web`/`server` barrels. Consequences:

- **No new manifest, no new check.** A consumer's `ConfigV2.Register({ descriptor })` is discovered
  by the *existing* `discoverConfigs` walk (it already inspects every `server/index.ts` for
  descriptor-shaped contributions), so `./equin build` emits `views.origin.jsonc` and the
  existing `config-origins-in-sync` check covers it. This is exactly how every other plugin's config
  is discovered.
- **Zero change to non-adopters.** The 7 single-view call sites register nothing → no descriptor →
  the resolver keeps using default-synthesis (ST4 detail). Only `sonata:library` adopts in ST3 (for
  verification) and ST5 (committed reference set).
- We still **mirror `reorder`'s descriptor-singleton** (`reorder/web/internal/descriptors.ts`): a
  reference-stable memoized `viewsDescriptor(storageKey)` factory, because `useConfig` matches the
  registration by `descriptor === reference`.

## Data model

**Instance row** (one `listField` item; `id`+`rank` auto-injected by `listField`/server):

```jsonc
// config/apps/sonata/library/views.jsonc
// @hash <12-hex>
{ "views": [
  { "id": "<uuid>", "rank": "a0", "name": "Cards", "view": { "type": "gallery", "coverField": "icon" } },
  { "id": "<uuid>", "rank": "a1", "name": "All",   "view": { "type": "table", "sort": { "fieldId": "title", "direction": "asc" } } }
]}
```

- `name` — a plain `textField` sub-item (type-independent display label).
- `view` — the new **`variant` field**: value `{ type: string, ...options }`. The discriminant
  `type` lives **inside the field's own value** (mirroring a `reorder-tree` node `{type, …payload}`),
  so its renderer never needs sibling access. `options` is flattened into the value, exactly like
  reorder-tree carries payload alongside `type`.
- Storage is **opaque/passthrough** at the config boundary (`z.object({ type: z.string() }).passthrough()`).
  Per-type validation of `options` happens **downstream on the web**, against the chosen view-type's
  `DataViewContribution.configSchema` — precisely how `reorder-tree-renderer.tsx:66` does
  `nodeType.schema.safeParse(payload)`. The server/codegen never need the per-type schemas.

> Note: the row is `{id, rank, name, view:{type,...options}}` rather than the roadmap sketch's flat
> `{id,rank,name,type,options:{}}`. A single config field can only own one value key, and we want the
> discriminant inside the polymorphic field (clean dispatch, no sibling coupling) — functionally
> identical, cleaner.

## Implementation

### 1. New generic field: `plugins/fields/plugins/variant/`

Mirror the two-level layout of `plugins/fields/plugins/reorder-tree/` exactly.

- **`variant/core/internal/variant.ts`** + `core/index.ts` — `defineFieldType<VariantValue>("variant")`
  and `defineFieldIdentity` (label "Variant", an icon e.g. `MdCallSplit`). `VariantValue =
  { type: string } & Record<string, unknown>`. No `coerce`, no `extends`. (Pattern: `object/core`.)
- **`variant/web/index.ts`** — `Fields.Identity({ identity: variantIdentity })`. (Pattern: `object/web`.)
- **`variant/plugins/config/core/internal/variant.ts`** + `core/index.ts` — the **`variantField`
  factory** (pattern: `object/plugins/config/core/internal/object.ts` and
  `reorder-tree/plugins/config/core/internal/reorder-tree.ts`):
  ```ts
  export interface VariantFieldDef extends FieldDef<VariantValue> {
    /** Web-only: per-type sub-schema + label registry for rendering/validation.
     *  Omitted on the server build (opaque storage there). Optional so the
     *  shared descriptor stays server-safe. */
    readonly useVariants?: () => Map<string, { label: string; fields: FieldsRecord }>;
  }
  export function variantField(opts?: FieldMeta & {
    default?: VariantValue;
    useVariants?: VariantFieldDef["useVariants"];
  }): VariantFieldDef // schema = z.object({ type: z.string() }).passthrough(); defaultValue = opts.default ?? { type: "" }
  ```
  Plus a pure downstream helper `validateVariant(value, variants)` that resolves the per-type
  `fields: FieldsRecord` → `buildFieldsSchema` → `safeParse(payload)` (payload = value minus `type`),
  used by data-view at read time. Keep it pure (co-located `*.test.ts` target).
- **`variant/plugins/config/web/index.ts` + `components/variant-renderer.tsx`** — contributes
  `Fields.Renderer(VariantRenderer)` into `config-v2.fields.renderer` (pattern:
  `reorder-tree-renderer.tsx`). The renderer reads `field.useVariants?.()`; if present it renders a
  **type selector** (sets `value.type`) + the selected type's sub-fields recursed via `FieldRenderer`;
  if absent (no registry in this context, e.g. generic settings pane) it degrades to a read-only/JSON
  view. **ST3 may ship the minimal renderer** (type label + opaque options) — the rich per-type
  sub-form is exercised by ST4's switcher UI. The field's *storage + validation* is the ST3
  deliverable.
- `package.json` + `CLAUDE.md` for each new plugin level (copy `reorder-tree`'s). Run `./equin build`
  to autoregister into `fields.identity` + `config-v2.fields.renderer` and regenerate docs.

### 2. `views` descriptor factory (in data-view, mirrors `reorder/web/internal/descriptors.ts`)

- **`plugins/primitives/plugins/data-view/shared/views-config.ts`** — the reference-stable factory:
  ```ts
  const cache = new Map<string, ConfigDescriptor>();
  export function viewsDescriptor(storageKey: string): ConfigDescriptor {
    let d = cache.get(storageKey);
    if (!d) {
      d = defineConfig({
        name: "views",                 // → config/<consumer-tree>/views.jsonc
        promotableToGit: true,
        scope: "app",                  // enables per-app override (roadmap decision #3)
        fields: {
          views: listField({
            label: "Views",
            itemFields: {
              name: textField({ label: "Name" }),
              view: variantField({ label: "View" }), // server build: no useVariants
            },
          }),
        },
      });
      cache.set(storageKey, d);
    }
    return d;
  }
  ```
  Lives in `shared/` (plugin-private) so both `web` and `server` barrels can build the *same* logical
  descriptor; the **web** memo guarantees `===` stability for `useConfig` matching. (Reference
  stability only matters within a runtime; server identity is independent.)
  - `textField` from `@plugins/fields/plugins/text/plugins/config/core`; `listField` from
    `@plugins/fields/plugins/list/plugins/config/core`; `variantField` from the new
    `@plugins/fields/plugins/variant/plugins/config/core`.
  - Export `viewsDescriptor` from **both** `data-view/web/index.ts` and `data-view/server/index.ts`
    (barrel-purity: re-export only; no logic).
  - **Multi-surface caveat:** `name:"views"` yields one file per consumer *plugin*. A plugin hosting
    two DataViews must give the second a distinct `name` (derive from `storageKey`). Sonata has one →
    fine. Document in the data-view CLAUDE.md.

### 3. Adopt on one consumer for verification: `apps/sonata/library`

- `apps/sonata/library/web/index.ts` → add `ConfigV2.WebRegister({ descriptor: viewsDescriptor("sonata:library") })`.
- `apps/sonata/library/server/index.ts` → add `ConfigV2.Register({ descriptor: viewsDescriptor("sonata:library") })`
  (registers under the consumer's own pluginId — no explicit `pluginId` needed, unlike `reorder`).
- The `<DataView storageKey="sonata:library" …>` **call site is unchanged** in ST3 (resolver wiring
  is ST4). Registration alone is what makes the descriptor server-visible + origin-generated.

### 4. Hand-author the committed instance set + build

- Create `config/apps/sonata/library/views.jsonc` with two instances (gallery + table), copying the
  `// @hash` from the generated `views.origin.jsonc` after the first build.
- `./equin build` regenerates the origin (default = empty `views: []`) and propagates.

### Out of scope for ST3 (→ ST4)

Resolver consuming config instances; the `<DataView>` branch on "has views descriptor"; demoting
`use-view-state.ts`; the switcher add/rename/duplicate/reorder/delete UI; migrating sort/filter into
`options`. ST4's resolver branch will be: render `<ConfiguredViews descriptor={…}>` (calls
`useConfig` unconditionally) when the consumer passes its descriptor, else `<DefaultViews>` —
avoiding any conditional-hook / unregistered-descriptor `useConfig` throw.

## Gotchas

- **`@hash` invariant.** `setConfig` and `jsoncConfigProxy.read()` throw on a hashless file, and
  `setConfig` throws if no origin exists. ST3 only hand-authors files (with the origin's hash) and
  reads — no runtime `setConfig` on these descriptors yet (that's ST4), so we stay clear, but the
  committed `views.jsonc` **must** carry the `// @hash` from the freshly generated origin.
- **`config-origins-in-sync` re-stamping.** When a view-type's `configSchema` later changes the origin
  default under a committed instance set, this check fails by design → re-stamp `@hash`. (No new check
  is added — the existing one covers `views.*.jsonc`.)
- **Reference stability.** `useConfig` matches by `descriptor === reference`; the consumer's
  `WebRegister` and any later `useConfig` must both go through the memoized `viewsDescriptor(key)`.
  Don't construct a second `defineConfig` inline.
- **Barrel/boundary rules.** New cross-plugin imports must be runtime barrels only
  (`@plugins/fields/plugins/variant/plugins/config/core`, etc.). `shared/views-config.ts` is
  plugin-private — only data-view's own barrels import it. Barrels re-export only (no logic).
- **Server-safety of the shared descriptor.** `variantField`'s `useVariants` is web-only and
  optional; the `shared/views-config.ts` factory omits it (server build is opaque), so importing the
  shared module on the server pulls no web code.
- **Docs sync.** New plugins + changed barrels regenerate the autogen reference blocks;
  `plugins-doc-in-sync` fails on drift → re-run `./equin build` and commit.

## Verification

1. `./equin build` — succeeds; emits `config/apps/sonata/library/views.origin.jsonc`
   (`// @hash …`, `views: []`) and registers `fields.identity` "variant" +
   `config-v2.fields.renderer` "variant".
2. `./equin check` — `type-check`, `config-origins-in-sync`, `plugins-doc-in-sync`,
   `eslint`, `migrations-in-sync` all green (after committing generated files + the hand-authored
   `views.jsonc` with the matching `@hash`).
3. **Field-level unit test** (`bun test`, co-located `variant/plugins/config/core/internal/variant.test.ts`):
   - `variantField().schema.safeParse({ type:"table", sort:{...} })` succeeds; passthrough keeps options.
   - `validateVariant({ type:"table", sort:{ fieldId:"title", direction:"asc" } }, variants)`
     validates against a stub `{ table: { fields: { sort: … } } }` registry; an options blob that
     violates the chosen type's schema is rejected; an unknown `type` fails-soft (skipped, mirroring
     `reorder-tree-renderer` `if (!nodeType) continue`).
4. **Config load** confirmation: read the propagated
   `~/.singularity/config/<wt>/apps/sonata/library/views.origin.jsonc` on disk (and, if needed, a
   throwaway `getConfig(viewsDescriptor("sonata:library"))` log) to confirm the two hand-authored
   instances parse through the descriptor schema (id/rank auto-injected). `query_db` is not
   applicable — config_v2 is file + in-memory, not a DB table.
5. No behavioral change: `sonata:library` DataView still renders its default gallery/table switcher
   (resolver wiring is ST4); the 7 other consumers are byte-for-byte unchanged.

## Critical files

- New: `plugins/fields/plugins/variant/{core,web}` + `variant/plugins/config/{core,web}`
  (templates: `plugins/fields/plugins/reorder-tree/**`, `plugins/fields/plugins/object/**`).
- New: `plugins/primitives/plugins/data-view/shared/views-config.ts`
  (template: `plugins/reorder/web/internal/descriptors.ts` + `shared/directive.ts`).
- Edit: `plugins/primitives/plugins/data-view/web/index.ts`,
  `plugins/primitives/plugins/data-view/server/index.ts` (re-export `viewsDescriptor`).
- Edit: `apps/sonata/library/{web,server}/index.ts` (register the descriptor).
- New (committed data): `config/apps/sonata/library/views.jsonc`.
- Reference (read, do not edit): `plugins/reorder/{web,server}/internal/config-registrations.ts`,
  `plugins/fields/plugins/list/plugins/config/{core,web}`,
  `plugins/config_v2/plugins/fields/web/internal/{slots.tsx,field-renderer.tsx}`,
  `plugins/primitives/plugins/data-view/web/internal/resolve-instances.ts` (ST4 entry point).
```
