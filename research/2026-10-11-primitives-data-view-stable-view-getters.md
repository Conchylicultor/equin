# DataView model: stable per-view getters

## Context

`ReadyViewModel` (`plugins/primitives/plugins/data-view/web/internal/use-data-view-model.ts`) exposes per-view getters that build a new object on every call:

| getter | mints | via |
|---|---|---|
| `stateFor(id)` | `ViewState` (and a fresh `groupBy` for legacy string configs, a fresh `sort` array for legacy object configs) | `useCallback` literal + `ephemeral.localFor` |
| `sectionFor(id)` | `SectionPresentation` | literal |
| `collapsedSectionsFor(id)` | stable since e830dc69c2 (`collapsedSetOf` WeakMap) | — |
| `useViewEphemeral().localFor(id)` | `{ ...local, query }` | spread |

So every memo keyed on what they return (`useLiveSource`'s `state`, the data-view-body memos, `useDataViewSections`) recomputes on every render. Those recomputes cost work without any visible sign, and they crash when they meet a render-phase `setState` keyed on identity (React #301 in the History sidebar, fixed in e830dc69c2 for `collapsedSectionsFor` only). Several call sites already work around it: they rebuild `groupBy` from its primitive fields (`use-data-view-sections.ts:449`, `tree/web/components/tree-view.tsx:457`) or re-memo `filter` alone (`row-order.tsx:101`), and leave comments that say "stateFor mints a fresh object".

There is a second, upstream source of churn. view-core's config reconcile (`view-core/web/internal/use-views-config.ts` ~L199) swaps in a fully re-normalized row array whenever the external config JSON changes. As a result, an edit to view A also gives view B a new raw `view` object.

**Goal:** a getter returns the *same* object for a view until that view's own inputs change. The guarantee must be structural: adding a getter that mints per call should fail `tsc`.

## Design

### 1. `ViewGetter<T>`: a branded, cached per-id getter (new file `data-view/web/internal/view-getter.ts`)

```ts
declare const stable: unique symbol;
/** A per-view getter whose result keeps its identity until that view's inputs change. */
export type ViewGetter<T> = ((id: string) => T) & { readonly [stable]: true };

/** The ONLY way to mint a ViewGetter: `inputsFor(id)` names the raw, already-stable
 *  slots the value derives from (compared by identity, element-wise); `derive` runs
 *  only when one of them changed for that id. */
export function useViewGetter<I extends readonly unknown[], T>(
  inputsFor: (id: string) => I,
  derive: (...inputs: I) => T,
): ViewGetter<T>
```

- The cache is `Map<id, { inputs, value }>`, held in a small class instance created once per model (`useState(() => new ViewGetterCache())`). Lookups and writes go through methods, which keeps the memo invisible to the React Compiler, in the same way as the existing `collapsedSetOf` WeakMap. If the compiler lint objects anyway, fall back to a module-level `WeakMap` keyed on a per-model token object.
- The returned function is a `useCallback` over `[inputsFor, derive]`. Its identity may change, but the values it returns stay put. That is the contract consumers rely on.
- `derive` is pure. Storing the cache is idempotent, so a concurrent or discarded render is harmless.

### 2. Type-level guarantee on `ReadyViewModel` (rung 2)

- Retype the getters: `stateFor: ViewGetter<ViewState>`, `sectionFor: ViewGetter<SectionPresentation>`, `collapsedSectionsFor: ViewGetter<ReadonlySet<string>>`.
- Add an assertion next to the interface. It fails `tsc` if any top-level key is a function that returns a non-`void` value and is not a `ViewGetter`:
  ```ts
  type UnstableGetters<M> = { [K in keyof M]: M[K] extends (...a: never[]) => infer R
    ? R extends void ? never : M[K] extends ViewGetter<unknown> ? never : K : never }[keyof M];
  // A new `fooFor: (id) => Foo` must be a ViewGetter (minted by useViewGetter).
  const _gettersAreStable: [UnstableGetters<ReadyViewModel>] extends [never] ? true : never = true;
  ```
  Setters return `void`, so they pass. `actions` is an object, so it is out of scope (see Follow-ups).

### 3. Feed the getters stable raw inputs

- **`use-view-ephemeral.ts`:** replace `localFor` (which mints) with `localFor(id): LocalViewState` (returns the stored object or `EMPTY_LOCAL`) and `queryFor(id): string`. Both return values that are already stable, so nothing is minted.
- **`use-data-view-model.ts`:**
  - `stateFor = useViewGetter(id => [core.viewFor(id), local.expanded, query], (view, expanded, query) => ({ sort: readSortRules(view), ... }))`
  - `sectionFor` uses inputs `[core.viewFor(id), local.collapsed]`.
  - `collapsedSectionsFor` uses input `[local.collapsedSections]` with `derive = keys => new Set(keys)`. This replaces the ad-hoc `collapsedSetOf` WeakMap, so all three getters share one mechanism.
  - Drop the `sortFor` / `filterFor` intermediates; `derive` reads the raw view directly.
- **view-core reconcile (`use-views-config.ts`):** apply structural sharing per row. A row whose JSON is unchanged keeps its previous object, matched by `id`, so an edit to one view leaves the other views' raw values (and therefore their cached getter results) untouched. Write it as one `shareRows(prev, incoming)` helper with a unit test.

### 4. Remove the workarounds

Now that `state.groupBy` and `state` are stable, simplify the call sites that defended against minting and delete their "mints a fresh" comments:

- `use-data-view-sections.ts:449`: depend on `state.groupBy` directly.
- `tree/web/components/tree-view.tsx:457`
- `row-order.tsx:101`: keep the filter-only projection only if it is still needed for its own reason; otherwise fix the comment.
- `data-view-body.tsx:410`: comment only.

Keep `usePlaceholderHeights`' content comparison from e830dc69c2. It is a correct defence in its own right.

### 5. Test fakes

The five `web/__tests__/*.test.tsx` fakes write `stateFor: () => state`, which no longer type-checks. Add `fakeViewGetter(fn)` to `data-view/web/testing/` (or a relative test-only helper if no other plugin needs it), and use it in those fakes.

## Critical files

- `plugins/primitives/plugins/data-view/web/internal/view-getter.ts` (new)
- `plugins/primitives/plugins/data-view/web/internal/use-data-view-model.ts`
- `plugins/primitives/plugins/data-view/web/internal/use-view-ephemeral.ts`
- `plugins/primitives/plugins/data-view/plugins/view-core/web/internal/use-views-config.ts` (reconcile structural sharing)
- Workaround sites: `use-data-view-sections.ts`, `row-order.tsx`, `data-view-body.tsx`, `plugins/tree/web/components/tree-view.tsx`
- Test fakes under `data-view/web/__tests__/`

## Verification

- New `view-getter.test.ts`: the same id returns the same object across calls and across new getter identities, a changed input re-derives, and other ids are untouched.
- New `__tests__/use-data-view-model.test.tsx` (`renderHook`):
  - `stateFor(a)`, `sectionFor(a)` and `collapsedSectionsFor(a)` keep their identity across a rerender.
  - They keep it across `setQuery(b, …)`, `setSort(b, …)` and `setSectionCollapsed(b, …)`.
  - They change after the matching write to `a`.
  - They keep it across an external config echo that changes only view `b`.
  - A legacy string `groupBy` stays identity-stable.
- `./singularity test plugins/primitives/plugins/data-view`
- `./singularity check type-check`: confirm that adding a dummy plain `fooFor: (id) => ({})` to `ReadyViewModel` fails (done locally, not committed).
- `./singularity build`, then open the History sidebar and a grouped task list and confirm there are no #301 / render-loop reports (`reports/render-loop`), with a screenshot via `e2e-harness/e2e/screenshot.ts`.

## Follow-ups (out of scope)

- `actions.variantsFor` (view-core) builds a new `Map` per call. Its one consumer memoizes it, and it lives in a different layer (view-core). File a task if it should get the same treatment.
