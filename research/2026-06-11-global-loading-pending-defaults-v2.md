# Loading-state structural fix — v2 (merged design)

Supersedes `2026-06-11-global-loading-pending-defaults.md` (this worktree) by merging it
with `2026-06-11-global-loading-primitive-unification.md` (worktree att-1781184574-hpe2).
v2 takes the unification plan's UX layer (single `Loading` primitive, CSS-only delay,
shadcn-skeleton deletion, `ignores`-glob allowlist precedent, extra lint rules) and this
worktree's data-layer correctness details (named-record combinator compatible with
optimistic results, select-slice gate restriction, the two-resource Push & Exit gate, the
select carve-out in the lint rule).

## Context

A recurring bug class ships a **confidently-wrong "resolved" state while data loads**:

1. **Queue shows "Unranked"** — `queue-view.tsx` reads three independently-arriving
   resources (conversations, queue-ranks via `useOptimisticResource`, tasks). In the
   window where conversations settled but ranks haven't, every waiting conversation
   buckets into "Unranked".
2. **"Push & Exit" shows destructive "Drop & Exit"** — `push-and-exit-button.tsx:108`
   collapses pending pushes to `[]`, AND `useHasActiveSiblingInWorktree` collapses
   pending to `false` (`use-conversations.ts:87`) — both un-settled inputs fall through
   to the most destructive mode. Same in `drop-and-exit-button.tsx:20`.
3. **Sonata shows "No songs yet — add one to get started."** — `song-library.tsx:100`
   passes `pending ? [] : data` into `DataView`; `gallery-view.tsx:101` renders
   `emptyState` whenever `rows.length === 0`. DataView has no loading concept.

**Root cause.** `useResource` already returns a correct discriminated union
(`{pending: true} | {pending: false; data: T}` — `use-resource.ts:108`), but ~84 call
sites across ~46 files opt out with `result.pending ? <fallback> : result.data`,
collapsing loading/empty/full back into two states at the exact line where the
distinction still exists. Two sub-classes:

- **Loading-vs-empty conflation** (Sonata, Push & Exit): one resource's pending coerced
  to a fallback value at the read site.
- **Cross-resource incoherence** (queue, and the second half of Push & Exit): a view
  reads ≥2 resources settling at different times; each is individually handled but the
  composite renders mid-flight. Per-resource checks cannot fix this — it needs a
  combined gate.

Separately, the loading-affordance surface is fragmented: `Placeholder` (67 sites,
overloaded across ~25 loading / ~15 empty / ~12 error), `Spinner` (13 inline sites),
dead shadcn `Skeleton` (only `sidebar.tsx`), ~15 ad-hoc `<Text>Loading…</Text>` clones.

**How modern apps handle this, mapped here:** Suspense's shape (un-ready data is
unreachable; an ancestor owns the fallback) — copied non-throwing since this repo
deliberately removed Suspense; Next/Remix route-level loading — already exists here as
`PaneResolveGuard`, no new mechanism needed; Linear-style sync-engine — closest model:
WS pushes settle <100ms, so the right UX is usually *no transient UI at all* (delayed
skeleton), and empty states require **confirmed-empty**.

**Decisions (user-confirmed):** lint-enforced gates (framework auto-masking rejected: it
hides wrong renders, breaks on late-mounting resources, wrong granularity for toolbars).
Scope guard: this PR introduces primitives + combinators + lint rules + allowlist and
fixes the **3 reference sites only**; the remaining ~90 sites drain via follow-up tasks.

---

## Design

### 1. `Loading` primitive — `plugins/primitives/plugins/loading/` (new)

Mirrors `placeholder`'s plugin structure exactly (`web/index.ts` barrel +
`web/internal/loading.tsx`; no registry edit — `./equin build` regenerates
`web.generated.ts`). **The single entry point for the LOADING state.** An orchestrator
composing existing leaves — nothing re-implemented:

```tsx
<Loading />                               // variant="text" (default) → <Placeholder>Loading…</Placeholder>
<Loading variant="spinner" label="…" />  // → <Spinner/> (+ label), small/inline areas
<Loading variant="rows" count={6} />     // skeleton list rows (Row height via control-size)
<Loading variant="cards" count={8} />    // skeleton card grid (gallery)
<Loading variant="block" className="…"/> // single shimmer block (the atom)
```

Props: `{ variant?; label?; count?; className? }`. `text` delegates to `Placeholder`,
`spinner` to `Spinner`; skeleton variants build on one atomic shimmer
`<div className="animate-pulse rounded-md bg-muted">` (live themeable token).

**Subsumes shadcn `Skeleton`**: delete
`plugins/framework/plugins/web-core/web/components/ui/skeleton.tsx`; repoint
`sidebar.tsx` (`:20`, `:614`) to `<Loading variant="block">`.

**Delay-before-show — pure CSS, no JS timers.** Mounts at `opacity: 0`; a keyframe fades
in after a 120ms delay; if data settles first the node unmounts before ever painting →
zero flash on warm WS reads. Plugin-local `web/internal/loading.css` (theme rule:
keyframes live in the consuming plugin; precedents `diff-view.css`, `reorder/styles.css`):

```css
@keyframes loading-fade-in { to { opacity: 1; } }
.loading-delayed {
  opacity: 0;
  animation: loading-fade-in 150ms ease-out 120ms forwards;
}
@media (prefers-reduced-motion: reduce) {
  .loading-delayed { animation-duration: 0ms; } /* still delayed, no fade */
}
```

(No JS `minVisibleMs`: an early unmount mid-fade is a soft sub-150ms fade-out of a
partially-faded-in element, not a hard blink. Accepted simplification.)

### 2. live-state combinators — `plugins/primitives/plugins/live-state/web/resource-utils.tsx` (new, re-exported from `web/index.ts`)

All three accept a structural **`Gateable<T>`** input — anything shaped
`{ pending: true; … } | { pending: false; data: T; … }` **or**
`{ pending: boolean; data: T }`. This is load-bearing: the queue gates on
`useOptimisticResource`'s result (`{ data, pending, dispatch, inFlight }` —
`use-optimistic-resource.ts:116`), which is NOT a `ResourceResult` union.

**Gate restriction (type-level + documented):** inputs must be **non-select** results.
The select-slice variant can flip `pending` without a re-render when the selected slice
is byte-identical across the initialData→real boundary (`use-resource.ts:139-143`) — a
gate fed a select result can wedge pending forever. Rule: *gate on whole-resource
results; `select` is for point reads.*

```ts
// a. combineResources — named record, all-or-nothing. Pure function (no hook state).
function combineResources<T extends Record<string, Gateable<unknown>>>(inputs: T):
  | { pending: true; error: Error | null }
  | { pending: false; data: { [K in keyof T]: DataOf<T[K]> }; error: Error | null };
// pending until EVERY input settled once; error = first non-null.

// b. matchResource — exhaustive handler form.
function matchResource<T, R>(result: Gateable<T>, handlers: {
  pending?: () => R;                 // default <Loading/>
  error?: (err: Error) => R;         // default <Placeholder tone="error">
  ready: (data: T) => R;
}): R;
```

```tsx
// c. <ResourceView> — the component sugar consumers reach for.
<ResourceView resource={songs} fallback={<Loading variant="cards" count={8} />}>
  {(data) => <SongGrid songs={data} />}
</ResourceView>
```

`fallback` defaults to `<Loading/>`, `errorFallback` to `<Placeholder tone="error">`.
There is no way to reach `children` without settled `data` and no way to skip the
pending branch — this kills the `pending ? fallback : data` idiom by making the correct
thing the ergonomic thing. Named record beats positional tuples at ≥3 resources
(`const { conv, ranks, tasks } = all.data`).

### 3. `DataView` loading-awareness — `plugins/primitives/plugins/data-view/`

Additive, non-breaking:

- `core/internal/types.ts`: add `loading?: boolean` + `loadingState?: ReactNode` to
  `DataViewProps<TRow>` (`:90`) and `DataViewRenderProps<TRow>` (`:44`).
- `data-view.tsx` (`:112`): thread both into render props.
- `gallery-view.tsx` (`:101`) and `table-view.tsx` (`:34`): above the existing
  `rows.length === 0` guard, `if (props.loading) return loadingState ?? <Loading
  variant={"cards"|"rows"} />`. `emptyState` therefore renders **only** on
  confirmed-empty (`!loading && rows.length === 0`) — a structural guarantee of the
  primitive for every present and future consumer.

### 4. Lint rules + allowlist

Contributed via `plugins/<name>/lint/index.ts` (auto-discovered, repo-wide `error`).
Allowlists use the idiomatic **`ignores: Record<ruleId, string[]>`** glob field on the
lint barrel (precedent: `plugins/infra/plugins/endpoints/lint/index.ts`, PERMANENT vs
BURNDOWN sections). Known trade-off vs inline disables: file-glob granularity can let
new violations into grandfathered files until the BURNDOWN list drains — accepted to
mirror precedent.

- **`live-state/lint/` → `no-pending-data-collapse`** — flags
  `<id>.pending ? <expr> : <id>.data…` (either branch order; `ConditionalExpression`
  visitor matching a `.pending` test against a same-object `.data` branch) and
  `<id>.data ?? <emptyLiteral>`. **Carve-out:** results of `useResource(…, { select })`
  — the ~27 `q.pending ? null : q.data.find(…)` point lookups (e.g.
  `use-conversations.ts:54,67`) are sanctioned; skip when the binding's init call has an
  options arg with `select`. Favor false negatives — the allowlist must mean "debt", not
  "noise". Message steers to `<ResourceView>` / `matchResource` / `combineResources` /
  early-return on pending.
- **`loading/lint/` → `no-adhoc-loading-text`** — flags JSX text matching
  `/^Loading[.…]/` outside the `Loading`/`Placeholder` primitives. Steers to `<Loading>`.
- **`loading/lint/` → `no-shadcn-skeleton`** — flags imports of the deleted
  `@/components/ui/skeleton` (template: `no-lucide-react`).

Seeding: run each rule across the repo, write current violators as BURNDOWN globs minus
the 3 reference sites (~15 collapse-idiom files, ~15 ad-hoc loading-text files).

### 5. Reference-site fixes (this PR)

- **Sonata** (`song-library.tsx`): drop `songs.pending ? [] : songs.data` (`:100`); pass
  `rows` + `loading={songs.pending}` to `DataView`; keep `emptyState` (`:128`) — now
  only shown post-load.
- **Push & Exit** (`push-and-exit-button.tsx`, `drop-and-exit-button.tsx`,
  `use-conversations.ts`): the mode has **two** un-settled inputs — pushes AND the
  sibling check (which collapses pending → `false` at `use-conversations.ts:87`; if
  pushes settles first, `hasPush=false ∧ hasOther=false` → destructive default again).
  Add gateable variants of `useHasActiveSiblingInWorktree` / `useHasActiveSiblings`
  returning `Gateable<boolean>`; gate the mode on
  `combineResources({ pushes, sibling })`. While pending: render **disabled-neutral**
  ("Exit", non-destructive variant, stable width — no skeleton/reflow in a toolbar).
- **Queue** (`queue-view.tsx`): stop ignoring the optimistic hook's forwarded `pending`;
  gate all bucketing on `combineResources({ conv, ranks, tasks })`; while pending render
  `<Loading variant="rows">`. Grouping (`waitingGroups`/`unranked`/`blockedIds`) only
  ever computes from a mutually-consistent settled snapshot — "Unranked" can only mean
  actually unranked.

### 6. Follow-up tasks (filed via `add_task`, not done here)

1. Drain `no-pending-data-collapse` BURNDOWN → migrate remaining collapse sites to
   `<ResourceView>`/`matchResource`/`combineResources`.
2. Drain `no-adhoc-loading-text` BURNDOWN → migrate ~15 hand-rolled loading texts.
3. Migrate the ~25 `<Placeholder>Loading…</Placeholder>` uses to `<Loading>`
   (Placeholder retained for empty/error only).
4. Adopt `combineResources` in other multi-resource composite views.

---

## Critical files

| File | Change |
|---|---|
| `plugins/primitives/plugins/loading/{package.json,web/index.ts,web/internal/loading.tsx,web/internal/loading.css}` | **new** primitive |
| `plugins/framework/plugins/web-core/web/components/ui/skeleton.tsx` | **delete** |
| `plugins/framework/plugins/web-core/web/components/ui/sidebar.tsx` (`:20`,`:614`) | repoint to `<Loading variant="block">` |
| `plugins/primitives/plugins/live-state/web/resource-utils.tsx` (+ barrel) | **new**: `Gateable`, `combineResources`, `matchResource`, `ResourceView` |
| `plugins/primitives/plugins/live-state/lint/{index.ts,no-pending-data-collapse.ts}` | **new** rule + BURNDOWN allowlist |
| `plugins/primitives/plugins/loading/lint/{index.ts,no-adhoc-loading-text.ts,no-shadcn-skeleton.ts}` | **new** rules |
| `plugins/primitives/plugins/data-view/core/internal/types.ts` (`:44`,`:90`), `data-view.tsx` (`:112`), `gallery/.../gallery-view.tsx` (`:101`), `table/.../table-view.tsx` (`:34`) | loading-awareness |
| `plugins/apps/plugins/sonata/plugins/library/web/components/song-library.tsx` | reference fix |
| `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/components/{push-and-exit-button.tsx,drop-and-exit-button.tsx}` + `plugins/conversations/web/use-conversations.ts` | reference fix (two-resource gate) |
| `plugins/conversations/plugins/conversations-view/plugins/queue/web/components/queue-view.tsx` | reference fix |

**Reuse:** `Placeholder` + `Spinner` (composed, not duplicated); `bg-muted` token;
`no-lucide-react`/`no-reactive-server-io` as lint templates; `endpoints/lint` `ignores`
allowlist precedent; `PaneResolveGuard` stays the pane-level gate (no new mechanism).

## Verification

1. `./equin build` — regenerates `web.generated.ts` + `lint.generated.ts`; all
   checks green (`type-check`, `eslint`, `plugins-doc-in-sync`, boundaries). The 3 fixed
   sites need NO allowlist entries.
2. **Unit tests** (colocated, like `overlay.test.ts`): `combineResources` all-or-nothing
   + error propagation + optimistic-shape input; `matchResource`/`ResourceView` children
   only invoked with settled data.
3. **Lint RuleTester fixtures**: invalid cases per banned pattern; valid cases for the
   `select` carve-out and untainted `.pending` fields.
4. **Flash behavior**: warm WS → Sonata/queue paint with no skeleton flash; cold/throttled
   load → skeleton fades in after ~120ms.
5. **The three bugs** via `bun e2e/screenshot.mjs`: Sonata never shows "No songs yet"
   during load (still shows it when genuinely empty post-load); Push & Exit reads
   disabled "Exit" during load, never "Drop & Exit"; queue never flashes "Unranked".
   For the <100ms race window, temporarily add a dev-only delay before the first WS
   push to observe, then remove.
6. **Lint guard**: throwaway `x.pending ? [] : x.data` + `<Text>Loading…</Text>` in a
   non-allowlisted file → `./equin check eslint` fails (remove before commit).
7. **Perf**: no changes to the select-slice hot path — per-conversation toolbar reads
   byte-for-byte unchanged.
