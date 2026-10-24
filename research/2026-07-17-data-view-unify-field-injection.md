# Unify DataView's two field-injection mechanisms

## Context

The DataView primitive injects extra `FieldDef`s into a surface's schema through
**two** entry points that today carry **two different contribution/prop types**
and are folded by **two nested passes** in the host:

1. **Global slot** — `DataViewSlots.FieldExtension` (`web/slots.ts`), an always-on
   `defineRenderSlot` every DataView folds. Its contributions are typed
   `GlobalFieldExtensionContribution` with props `GlobalFieldExtensionProps =
   { storageKey, rowKey, render }` (row type erased to `unknown`). The sole
   contributor is **custom-columns** (user-defined columns on any surface).
2. **Per-consumer factory** — `defineFieldExtensions<TRow>(id)`
   (`web/internal/field-extensions.tsx`), minted once per consumer, passed as
   `DataView`'s `fieldExtensions` prop. Its contributions are typed
   `FieldExtensionContribution<TRow>` with props `FieldExtensionProps<TRow> =
   { render }` (full `TRow` typing). The sole consumer is Sonata's
   `apps/sonata/library` (play-count / last-played fields via `playback-history`).

**The premise has already partly landed.** An earlier dependency-inversion refactor
(2026-07-02) removed the bespoke host-owned `useCustomColumnFields` bridge — both
mechanisms *already* fold through the same recursive-component machinery
(`CollectFieldExtensions` → `FieldExtensionFold` → `FieldExtensionStep`). What
remains is a **cosmetic split** that hides the fact that they are one mechanism:

- **Two prop/contribution types** — `GlobalFieldExtensionProps`/`…Contribution`
  vs `FieldExtensionProps<TRow>`/`FieldExtensionContribution<TRow>`. They differ
  only in that the global one also carries `{ storageKey, rowKey }` and erases the
  row type. The fold bridges the gap with an opaque `extraProps: Record<string,
  unknown>` escape hatch.
- **Two nested folds** — `DataView` (`web/components/data-view.tsx:72-90`) wraps
  the global fold (always) *outside* the per-consumer fold, so the host reads as
  "two field-injection paths."

**Outcome.** Collapse both to a single contribution shape and a single fold, so
custom-columns is visibly *"the global-registered case of the same
`defineFieldExtensions` factory."* The two remaining differences — **registration
site** (one always-on global slot vs an opt-in per-consumer prop) and **row typing**
(`unknown` vs `TRow`) — are irreducible and correct (cross-cutting vs scoped, per
the same collection-vs-factory rule as `defineItemActions`); we keep both entry
points but make them share one mechanism.

**Out of scope (confirmed):** the server twin `DataViewServer.QueryAugmentor`
(`plugins/.../server-query`) — a separate SQL-augmentation concern only the global
custom-columns case needs; the per-consumer path has no server counterpart, and
unifying the web fold does not touch it. Also out of scope: the **sibling**
`DataViewSlots.RowOrder` global slot (`GlobalRowOrderProps` / `CollectRowOrder`,
contributed by the new `view-order` plugin). It is a deliberate twin of
`FieldExtension` but is **global-only** (no per-consumer variant exists), so there
is nothing to unify there — it stays as-is. (See "Intentional asymmetry" below.)

## Design

**One contribution shape, threaded surface coordinates for everyone.** Fold
`storageKey` + `rowKey` into the single `FieldExtensionProps<TRow>`. Both the
global slot and every per-consumer factory then receive
`{ storageKey, rowKey, render }`; a per-consumer contributor (Sonata) simply
ignores the two coordinates it does not need (it already destructures only
`{ render }`, so it compiles unchanged).

**The global slot becomes an instance of the factory.** Define
`DataViewSlots.FieldExtension = defineFieldExtensions<unknown>("primitives.data-view.field-extension")`.
Same id → the committed reorder-override config
(`config/primitives/data-view/primitives.data-view.field-extension.jsonc`) still
applies, no migration. This makes the unification legible in code: the global slot
is literally the same factory called at `<unknown>`.

**One fold over an ordered list of sources.** Replace the two nested
`CollectFieldExtensions` with a single fold over
`[DataViewSlots.FieldExtension, ...(props.fieldExtensions ? [props.fieldExtensions] : [])]`,
threading `{ storageKey, rowKey }` as typed props (drop the `extraProps:
Record<string, unknown>` bag). The source list length is stable per call site
(`fieldExtensions` is a static prop), so the source-level recursion preserves hook
order exactly as the existing contribution-level recursion does.

### Intentional asymmetry vs `RowOrder`

After this change `GlobalFieldExtensionProps` is gone but `GlobalRowOrderProps`
remains. That is correct and deliberate: `RowOrder` has **only** a global case
(the `view-order` plugin), so its "Global" prop type is just its one shape.
`FieldExtension` unifies because it has **two** cases (global custom-columns +
per-consumer Sonata) that were needlessly wearing two coats. Note this in the doc
so a future reader does not "restore symmetry" by re-splitting.

## Changes

Critical files (all under `plugins/primitives/plugins/data-view/`):

1. **`core/internal/types.ts`** — extend `FieldExtensionProps<TRow>` (currently
   `{ render }`, lines 162-166) to:
   ```ts
   export interface FieldExtensionProps<TRow> {
     storageKey: DataViewId;
     rowKey: (row: TRow, index: number) => string;
     render: (fields: FieldDef<TRow>[]) => ReactNode;
   }
   ```
   `DataViewId` is already imported (line 4). Update the doc comment to say every
   contributor receives the surface coordinates. `FieldExtensionsDescriptor<TRow>`
   (lines 175-185) needs no change — it already keys on
   `ComponentType<FieldExtensionProps<TRow>>`.

2. **`web/slots.ts`** — delete `GlobalFieldExtensionProps` (85-91) and
   `GlobalFieldExtensionContribution` (93-98). Change the `FieldExtension` member
   (146-149) to `defineFieldExtensions<unknown>("primitives.data-view.field-extension")`
   (import `defineFieldExtensions` from `./internal/field-extensions` — no cycle:
   `field-extensions.tsx` does not import `slots.ts`). Keep the explanatory comment,
   reworded to "the global-registered instance of the same factory."

3. **`web/internal/field-extensions.tsx`** — replace `extraProps?: Record<string,
   unknown>` on `CollectFieldExtensions`/`FieldExtensionFold`/`FieldExtensionStep`
   with typed `storageKey: DataViewId` + `rowKey: (row: unknown, index) => string`,
   threaded into each contribution's render props as
   `{ storageKey, rowKey, render }`. Change `CollectFieldExtensions` to fold an
   ordered **`sources: FieldExtensionsDescriptor<unknown>[]`** list (a source-level
   recursive step wrapping the existing contribution-level `FieldExtensionStep`),
   emitting `children(mergedFields)` after the last source. `defineFieldExtensions`
   itself is unchanged.

4. **`web/components/data-view.tsx`** — replace the two nested
   `<CollectFieldExtensions>` (72-90) with one:
   ```tsx
   const sources = props.fieldExtensions
     ? [DataViewSlots.FieldExtension, props.fieldExtensions as FieldExtensionsDescriptor<unknown>]
     : [DataViewSlots.FieldExtension];
   return (
     <CollectFieldExtensions
       sources={sources}
       base={props.fields as FieldDef<unknown>[]}
       storageKey={props.storageKey}
       rowKey={props.rowKey as (row: unknown, index: number) => string}
     >
       {(fields) => <DataViewWithModel {...props} fields={fields as FieldDef<TRow>[]} />}
     </CollectFieldExtensions>
   );
   ```

5. **`web/index.ts`** — drop the `GlobalFieldExtensionProps` /
   `GlobalFieldExtensionContribution` re-exports (lines 15-16). Keep
   `FieldExtensionContribution`, `FieldExtensionProps`, `FieldExtensions`,
   `FieldExtensionsDescriptor`.

6. **`plugins/custom-columns/web/components/custom-column-field-extension.tsx`** —
   change the imported `GlobalFieldExtensionProps` (from `…/data-view/web`) to
   `FieldExtensionProps` (from `…/data-view/core`, instantiated `<unknown>`); the
   component body (`{ storageKey, rowKey, render }`) is otherwise unchanged.

7. **`CLAUDE.md`** (data-view) — rewrite the "Field extensions" + "The global
   `FieldExtension` slot" sections to one unified story: one contribution shape
   `{ storageKey, rowKey, render }`; two registration entry points (always-on
   global slot for cross-cutting contributors like custom-columns; per-consumer
   `defineFieldExtensions<TRow>` factory for typed/scoped ones like Sonata); update
   the `FieldExtensionProps` code example; add the "Intentional asymmetry vs
   `RowOrder`" note.

No change needed: **Sonata `PlaybackFields`** (destructures only `{ render }`),
the server side, the `RowOrder`/`view-order` machinery, and the reorder config
file.

## Reused existing pieces

- `defineFieldExtensions` (`web/internal/field-extensions.tsx:43`) — reused verbatim
  to mint the global slot.
- The recursive-component fold (`FieldExtensionFold`/`FieldExtensionStep`) — reused;
  only the props it threads change (typed coords instead of the `extraProps` bag),
  plus a source-level recursion wrapper.
- `FieldExtensionsDescriptor<TRow>` (`core/internal/types.ts:175`) — already the
  structural type both the global slot and per-consumer factory satisfy.

## Verification

1. `./equin build` from the worktree — must pass `type-check` (the deleted
   `Global*` types have no stragglers — confirmed only the 4 files above reference
   them), `plugin-boundaries`, and `plugins-doc-in-sync` (the barrel export delta +
   CLAUDE.md rewrite regenerate the autogen reference block; commit the regen).
2. **Custom-columns (global case) still works** — open a DataView surface
   (e.g. `http://<worktree>.localhost:9000` → Tasks, or Studio → Contributions
   tables), add a custom column via the gear → **Fields**, type a value in a cell,
   confirm it persists (reload) and that the column appears in the **Sort** and
   **Filter** pills. Drive it with `e2e/screenshot.mjs` (click "Fields", capture
   before/after).
3. **Sonata (per-consumer case) still works** — open
   `http://<worktree>.localhost:9000/sonata` library, switch to the table/list
   view, confirm the **Plays** / **Last played** fields render and are sortable.
4. Optional: `bun test plugins/primitives/plugins/data-view` for any co-located
   pure tests touching the fold.
