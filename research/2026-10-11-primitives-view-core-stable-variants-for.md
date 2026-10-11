# view-core: `variantsFor` as a stable per-view getter

## Context

`useViewModel().actions.variantsFor(id)` (`plugins/primitives/plugins/data-view/plugins/view-core/web/internal/use-view-model.ts:139`)
builds a fresh `Map` on every call, and the callback itself is rebuilt whenever
*any* view's config row or the source entries change. The one consumer,
`ViewSettingsPopover`, papers over it with a `useMemo` (and a comment explaining
why). data-view just solved the same class for `ReadyViewModel` getters with a
branded `ViewGetter<T>` minted only by `useViewGetter` (per-id input-identity
cache) plus a `GettersAreStable` tsc assertion — but that lives in
`data-view/web/internal/view-getter.ts`, which view-core (below data-view) cannot
import. Goal: `variantsFor` returns the same object for a view until *that*
view's inputs change, enforced by type, not by each consumer memoising.

## Approach

### 1. Move the primitive down into view-core (it already belongs to the lower layer)

- `git mv` `data-view/web/internal/view-getter.ts` →
  `view-core/web/internal/view-getter.ts` (unchanged: `ViewGetter`,
  `useViewGetter`, `UnstableGetters`).
- Add one generic assertion helper beside it so each model states its own check
  in one line instead of re-spelling the conditional type:
  ```ts
  export type AssertStableGetters<M> = [UnstableGetters<M>] extends [never]
    ? true : ["getters that are not ViewGetters:", UnstableGetters<M>];
  ```
- Export `ViewGetter`, `useViewGetter`, `AssertStableGetters` (types + hook) from
  `view-core/web/index.ts`. (`UnstableGetters` stays internal unless needed.)
- data-view imports them from `@plugins/primitives/plugins/data-view/plugins/view-core/web`
  (it already depends on that barrel; no cycle, no re-export).
- Test fake: move `data-view/web/testing/fake-view-getter.ts` →
  `view-core/web/testing/` (new `index.ts` barrel exporting `fakeViewGetter`);
  update the five data-view `__tests__` imports to
  `@plugins/primitives/plugins/data-view/plugins/view-core/web/testing`. Delete the old
  file (no cross-plugin re-export).

### 2. Make `variantsFor` a `ViewGetter`

- `ViewActionsCore.variantsFor: ViewGetter<Map<string, VariantEntry>>`, and the
  same in data-view's `ViewActions` (`use-data-view-model.ts:41`).
- In `useViewModel`:
  ```ts
  const variantsFor = useViewGetter(
    useCallback((id: string) => {
      const resolved = cfg.instances.find((r) => r.instance.id === id);
      return [
        resolved && entries.find((e) => e.id === resolved.instance.source),
        resolved?.viewType,
      ] as const;
    }, [cfg.instances, entries]),
    deriveVariants,  // module-level: (entry, viewType) => Map
  );
  ```
  Inputs are already-stable slots: the source entry object (from the
  caller's stable `entries`) and the instance's resolved `viewType` contribution
  (registry object; it changes exactly when the view's type changes). Renaming /
  re-iconing / editing another view, or this view's options, no longer changes
  the Map. Unknown id → `[undefined, undefined]` → one cached empty Map.
  `deriveVariants` keeps today's logic verbatim (usableTypes + always list the
  current type).

### 3. Enforce structurally

- view-core: `export const actionsGettersAreStable: AssertStableGetters<ViewActionsCore> = true;`
  next to the interface — a future `fooFor: (id) => Foo` on the actions fails tsc.
- data-view: rewrite `GettersAreStable` via `AssertStableGetters<ReadyViewModel>`
  and add the same for `ViewActions` (the `actions` member is a non-function
  object, so `UnstableGetters<ReadyViewModel>` doesn't reach inside it today —
  this closes that gap).
- Test fakes that write `variantsFor: () => new Map()` (`sections-toolbar.test.tsx:196`,
  `data-view-model-identity.test.tsx:26`) become `fakeViewGetter(() => EMPTY)`.

### 4. Drop the consumer workaround

`view-settings-popover.tsx:54-57`: remove the `useMemo` + comment; read
`actions.variantsFor(id)` directly (the `viewField` memo keyed on it stays and
now holds by contract). Update the `ViewActionsCore.variantsFor` doc comment to
say it is stable per view.

## Critical files

- `view-core/web/internal/use-view-model.ts`, `view-core/web/internal/view-getter.ts` (moved), `view-core/web/index.ts`, `view-core/web/testing/index.ts` (new)
- `view-core/web/components/view-settings-popover.tsx`
- `data-view/web/internal/use-data-view-model.ts`, `data-view/web/testing/fake-view-getter.ts` (removed), data-view `__tests__` imports
- Regenerated docs (`CLAUDE.md`/`REFERENCE.md`, `docs/plugins-details.md`) via `./singularity build`

## Verification

- New jsdom test `view-core/web/__tests__/variants-for-identity.test.tsx`: two
  views; `variantsFor(a)` keeps identity after renaming `b`, after editing `a`'s
  options/name; changes after switching `a`'s type; unknown id is stable.
- `./singularity test plugins/primitives/plugins/data-view` (covers view-core + data-view suites).
- `./singularity check type-check plugin-boundaries boundary-rules` (barrel/R12–R13: `fakeViewGetter` only via `web/testing`).
- `./singularity build`, then open a DataView's view settings popover, switch type and type in Name — no regression.
