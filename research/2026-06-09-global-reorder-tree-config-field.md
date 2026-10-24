# Reorder layout → materialized `reorder-tree` config field

> Revises `research/2026-06-04-global-reorder-config-integration.md` (the
> string-list directive model) and supersedes the spacer approach in
> `research/2026-06-08-reorder-spacers-in-directive-model.md`. Read those for the
> original reorder→config_v2 migration; this doc only describes the delta.

## Context

Today the `reorder` plugin persists each slot's layout as a config_v2
**directive** `{ order: string[]; hidden: string[] }` of `entryKey` strings,
with a deliberately **empty default** (`{ order: [], hidden: [] }`). At render,
`applyDirective()` applies the directive over the *live* catalog: unmentioned
contributions append in natural order. This was designed to be **drift-tolerant**
— a new contribution silently appends, the config hash never shifts, overrides
never go stale.

That drift-tolerance is the opposite of what we want. When a new contribution
appears, it lands in an **arbitrary** natural-order position; the layout author
has no say. We want the committed layout to be the **explicit, materialized**
list of every item, so that adding/removing a contribution **shifts the hash**,
marks the committed layout stale, and **hard-fails push** until an agent
explicitly places the new item. The config file becomes the authoritative
layout, not a sparse patch over a live list.

We also want the value to grow into spacers and (later) groups, which a flat
`string[]` cannot express. So the value becomes a **recursive tagged-node tree**.

### Settled decisions

1. **Materialize, don't patch.** The generated origin's default is the *full
   current catalog* (every item, in natural order). Catalog changes shift the
   origin hash → existing overrides go stale. This is normal config_v2
   staleness — **no bespoke stable-hash logic**.
2. **Two reconciliations, both existing config_v2 behavior:**
   - **Code ↔ git config:** a committed override (`config/<plugin>/<slot>.jsonc`)
     whose `@hash` no longer matches the regenerated origin **hard-fails the
     `config-origins-in-sync` check**, which runs on `push` → push is blocked
     until an agent reconciles. This is the agent-facing forcing function.
   - **User override ↔ git config:** on hash conflict, **git wins** (the existing
     `effective()` revert — the slot shows the origin/natural order). The user
     sees the conflict in the config settings UI and manually fixes it. No
     special-casing, no `effective()` bypass.
3. **Value = recursive tagged-node union** with a bare-string terseness escape
   hatch; `hidden` is a **per-node flag**, not a parallel array:
   ```ts
   type ReorderNode =
     | string                                   // terse: coerces to { item }
     | { item: string; hidden?: boolean }
     | { spacer: string }                       // spacer id
     | { group: string; items: ReorderNode[] }; // reserved — groups come later
   type ReorderTree = ReorderNode[];
   ```
4. **Groups deferred.** The `{ group }` arm is in the union now so groups slot in
   without a format migration, but the editor never emits/parses it yet. The
   `groups` sub-plugin and its Postgres tables stay **untouched** — DB-backed as
   today; `applyTree` keeps the existing groups pass.
5. **New field type** lives at `plugins/fields/plugins/reorder-tree/`. The
   settings-pane renderer is **minimal** (the in-app pen-drag editor stays the
   real editor); a follow-up task tracks extracting a shared DnD editor.
6. **Delete `string-list`** entirely — `reorder` is its only consumer
   (verified: the sole non-doc/non-generated import is
   `plugins/reorder/shared/directive.ts`).

---

## Why a new field type (not `list` or `string-list`)

- `string-list` is `z.array(z.string())` — flat, can't express spacers/groups,
  and its renderer is a free-text textarea (we want drag-only, closed-set).
- `list` injects per-item `id`/`rank` via `injectCollectionIds` (gated on
  `"itemFields" in field`) — pollution + hash churn, and it's for fixed-shape
  objects, not a recursive union with bare-string members.
- A dedicated `reorder-tree` type has **no `itemFields`**, so the server passes
  the value through untouched (`registry.ts` `injectCollectionIds` skips it), and
  its zod schema is a `z.lazy()` recursive union the server `.parse()`s on set.

---

## Implementation

### 1. New field type `reorder-tree` (mirror `dynamic-enum`'s file tree)

Identity layer (`fields/` matrix):

- `plugins/fields/plugins/reorder-tree/core/internal/reorder-tree.ts`
  ```ts
  export const reorderTreeFieldType = defineFieldType<ReorderTree>("reorder-tree");
  export const reorderTreeIdentity = defineFieldIdentity<ReorderTree>({
    type: reorderTreeFieldType, label: "Reorder Tree", icon: MdReorder,
    // no coerce — not a sortable/filterable scalar (like string-list)
  });
  ```
- `plugins/fields/plugins/reorder-tree/core/index.ts` — re-export token + identity.
- `plugins/fields/plugins/reorder-tree/web/index.ts` —
  `contributions: [Fields.Identity({ identity: reorderTreeIdentity })]`.

Config capability (`plugins/config` sub-plugin):

- `plugins/fields/plugins/reorder-tree/plugins/config/core/internal/reorder-tree.ts`
  — the canonical **node/tree types** (`ReorderNode`, `ReorderTree`), the zod
  schema, and the factory:
  ```ts
  const nodeSchema: z.ZodType<ReorderNode> = z.lazy(() =>
    z.union([
      z.string(),
      z.object({ item: z.string(), hidden: z.boolean().optional() }),
      z.object({ spacer: z.string() }),
      z.object({ group: z.string(), items: z.array(nodeSchema) }),
    ]),
  );
  export interface ReorderTreeFieldDef extends FieldDef<ReorderTree> {
    readonly type: typeof reorderTreeFieldType;
  }
  export function reorderTreeField(opts?: FieldMeta & { default?: ReorderTree }): ReorderTreeFieldDef {
    return Object.freeze({
      type: reorderTreeFieldType,
      schema: z.array(nodeSchema),
      defaultValue: opts?.default ?? [],   // code-tier fallback; origin is materialized in codegen (step 4)
      meta: pickMeta(opts),
    });
  }
  ```
  No zod `.transform()` — bare strings stay strings on disk (terse); normalization
  to `{ item }` happens at point of use (`applyTree`, renderer) via a small
  `normalizeNode()` helper.
- `plugins/fields/plugins/reorder-tree/plugins/config/core/index.ts` — re-export
  factory, `ReorderTreeFieldDef`, `ReorderNode`, `ReorderTree`.
- `plugins/fields/plugins/reorder-tree/plugins/config/web/components/reorder-tree-renderer.tsx`
  — **minimal** `FieldRendererComponent<ReorderTree>` with
  `.type = reorderTreeFieldType` (read-only list of entryKeys / spacer markers,
  showing hidden state). No options slot needed for the minimal version.
- `plugins/fields/plugins/reorder-tree/plugins/config/web/index.ts` —
  `contributions: [Fields.Renderer(ReorderTreeRenderer)]`.
- `package.json` at each plugin level (copy `string-list`'s).

### 2. reorder `shared/directive.ts` → tree descriptor

`plugins/reorder/shared/directive.ts`:
- Drop `ReorderDirective`; import `ReorderTree`/`ReorderNode`/`reorderTreeField`
  from `@plugins/fields/plugins/reorder-tree/plugins/config/core`.
- Single field, key `items`:
  ```ts
  export function reorderDirectiveDescriptor(slotId: string): ConfigDescriptor<{ items: ReorderTreeFieldDef }> {
    return defineConfig({ name: slotId, fields: { items: reorderTreeField({ label: "Items" }) } });
  }
  ```
  (Keep the function name to minimize churn across `descriptors.ts` /
  `config-registrations.ts` on both runtimes; only the field shape changes.)

### 3. Read/sort path — `applyDirective` → `applyTree`

`plugins/reorder/web/internal/sorting.ts`:
- Replace `applyDirective(contributions, directive, groupsData)` with
  `applyTree(contributions, tree: ReorderTree, groupsData)`.
- Walk `tree` nodes (via `normalizeNode`):
  - `string` / `{ item }` → resolve `entryKey` in the live `byKey` map; emit the
    contribution. `{ item, hidden: true }` → route to the `hidden` bucket
    (never hides `excludeFromReorder`).
  - `{ spacer }` → emit `{ id: spacer, _spacer: true }`, dedup via the existing
    `emittedSpacers` guard.
  - `{ group }` → **ignore** for now (deferred; groups stay DB-backed).
  - **Append any live, visible contribution not named in the tree** in natural
    order (fail-loud — a contribution is never silently dropped, even in the
    stale window before reconciliation).
  - Pin `excludeFromReorder` items last (unchanged).
- **Groups pass unchanged** — still reads `groupsData` (DB), builds
  `membershipMap`, partitions the sorted entries. `SPACER_PREFIX` constant stays.

### 4. Codegen — materialize the catalog as the origin default

The catalog (per-slot ordered `{ entryKey, label }[]`) already exists at build
time in `collectReorderableSlots()`
(`plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-gen.ts`).
Today it only feeds origin **comments**. We additionally make it the **default
value**, so the hash reflects the catalog.

- `config-origin-gen.ts`: add a generic **origin-defaults provider**, parallel to
  the existing `OriginAnnotationsProvider`:
  ```ts
  export type OriginDefaultsProvider = (descriptor: ConfigDescriptor, hierarchyPath: string) => Record<string, unknown> | undefined;
  export function setDefaultOriginDefaultsPreparer(p: OriginDefaultsPreparer): void; // mirror the annotations preparer
  ```
  In `renderOriginJsonc`, resolve the override default and use it for **both** the
  JSON body and the hash:
  ```ts
  const defaults = originDefaults?.(descriptor, hierarchyPath) ?? descriptor.defaults;
  const hash = computeHash(defaults as JsonValue);
  ...renderFieldLines(descriptor.fields, defaults, "  ");
  ```
  No provider → byte-identical to today (uses `descriptor.defaults`).
- `reorderable-slots-gen.ts`: in the same module side-effect that installs the
  annotations preparer, also `setDefaultOriginDefaultsPreparer` from the catalog:
  `{ items: catalog.get(slotId)!.map(c => c.entryKey) }` (bare strings — terse).
  Trim `buildOriginAnnotationsProvider` to a **slim legend** (`entryKey — label`
  lines + a one-line format note: hide via `{item,hidden:true}`, gap via
  `{spacer:"<id>"}`), since the order now lives in the value itself.
- Both `generateConfigOrigins` (build) and the `config-origins-in-sync` check call
  `renderConfigOriginContent`, which already resolves the shared preparers — so
  the check stays in sync with **no structural change**. It will hard-fail on a
  stale committed override (decision 2), which is the agent forcing function.

### 5. Write path — middleware emits a tree

`plugins/reorder/web/internal/dnd-list-middleware.tsx`:
- Read: `const { items } = useConfig(descriptor)` (the tree) instead of
  `{ order, hidden }`.
- `useSetConfig(descriptor)` now sets the single `items` field.
- **Drag reorder:** materialize the full visible order as a tree — bare string per
  visible item, `{ spacer }` per spacer → `setConfig("items", tree)`.
- **Hide:** rewrite the item's node to `{ item, hidden: true }` (and materialize
  the rest). **Restore:** back to a bare string.
- **addSpacer / deleteSpacer:** operate on the `items` tree (append / filter a
  `{ spacer: uuid }` node) instead of the `order` string array.

### 6. Delete `string-list`

Remove the whole `plugins/fields/plugins/string-list/` subtree (7 source files +
package.jsons). Autogen registry (`web.generated.ts`, docs) refreshes on build.

### 7. Docs

Update `plugins/reorder/CLAUDE.md` (tree value model, materialized origin, the
two-reconciliation staleness contract, groups-deferred note) and
`plugins/fields/CLAUDE.md` (drop string-list, add reorder-tree). Autogen blocks
refresh on build. Mark `string-list` research doc + the spacer doc as superseded
by this one.

### 8. Follow-up (file via `add_task` after approval)

Extract reorder's presentational DnD list into a shared
`<ReorderEditor value onChange>` used by **both** the list middleware (wired to
`setConfig`) and the `reorder-tree` field renderer (wired to `onChange`), so the
config settings pane becomes a full drag editor.

---

## Critical files

- **New:** `plugins/fields/plugins/reorder-tree/**` (identity core/web +
  `plugins/config/{core,web}`) — mirror `plugins/fields/plugins/dynamic-enum/`.
- `plugins/reorder/shared/directive.ts` — single `items` tree field.
- `plugins/reorder/web/internal/sorting.ts` — `applyDirective` → `applyTree`.
- `plugins/reorder/web/internal/dnd-list-middleware.tsx` — read/write the tree.
- `plugins/framework/plugins/tooling/plugins/codegen/core/config-origin-gen.ts` —
  generic origin-defaults provider hook.
- `plugins/framework/plugins/tooling/plugins/codegen/core/reorderable-slots-gen.ts`
  — install the defaults preparer + slim the annotations.
- **Delete:** `plugins/fields/plugins/string-list/**`.
- Unchanged: `plugins/reorder/plugins/groups/**` (DB-backed),
  `web/internal/descriptors.ts` + `{web,server}/internal/config-registrations.ts`
  (still map `reorderableSlots` → `reorderDirectiveDescriptor`).

## Staleness / reconciliation semantics (to document in CLAUDE.md)

Adding/removing a contribution to a reorderable slot changes that slot's
materialized catalog → the generated origin's default and `@hash` shift.

- **Committed git override** (`config/<plugin>/<slot>.jsonc`) → `@hash` mismatch →
  `config-origins-in-sync` **fails on push** → agent edits the committed file to
  place the new item explicitly (the regenerated origin shows the full current
  list) and re-stamps the hash. Push blocked until reconciled.
- **User-dir override** (`~/.singularity/config/<wt>/.../<slot>.jsonc`) → stale →
  `effective()` reverts to origin (natural order) at runtime; surfaced as a
  conflict in the config settings UI for the user to fix. No code change — this is
  current config_v2 behavior.
- During the window, `applyTree` still appends any unmentioned live contribution
  (fail-loud) so nothing disappears.

## Verification

1. `./equin build` — generates `config/<plugin>/<slot>.origin.jsonc` whose
   `items` default is the **materialized** entryKey list (bare strings), with a
   slim `entryKey — label` legend comment. `./equin check` passes.
2. Inspect e.g. `config/shell/shell.toolbar.origin.jsonc`: `"items": ["theme:theme-light-dark","build:build",…]`.
3. **In-app drag** (`bun e2e/screenshot.mjs`, toggle pen, drag a toolbar item):
   change persists across reload; the **user-dir** `<slot>.jsonc` now holds the
   reordered `items` tree. Hide an item → node becomes `{item,hidden:true}` and it
   disappears. Add a spacer → `{spacer:"…"}` node renders a gap.
4. **Materialized-default forcing function:** add a dummy contribution to a slot
   that has a *committed* `config/<plugin>/<slot>.jsonc` override, rebuild, run
   `./equin check` → `config-origins-in-sync` **fails** (hash mismatch).
   Reconcile the committed file (add the new entryKey, re-hash) → check passes.
5. **User-tier conflict:** with a user-dir override, add a contribution, rebuild →
   the slot reverts to natural order at runtime and the settings UI shows the
   conflict; manual fix restores the custom order.
6. **Groups untouched:** `query_db "SELECT count(*) FROM reorder_groups"` still
   works; group create/join via the in-app editor still functions.
7. `rg "string-list|stringListField"` returns only doc/research hits — the field
   type is gone and nothing imports it.
