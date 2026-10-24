# Structural fix for "wrong default state while data loads"

## Context

A recurring bug class: components render a plausible-but-wrong concrete state during the
load window of a live-state resource. Known instances:

1. **Queue shows "Unranked"** — `queue-view.tsx` reads three independently-arriving
   resources (`conversations`, `queue-ranks`, `tasks`). In the window where conversations
   have settled but ranks haven't, `rankRows` is `[]`, so every waiting conversation falls
   into the Unranked section.
2. **"Push & Exit" shows the destructive "Drop & Exit"** — `push-and-exit-button.tsx:108`
   does `pushesResult.pending ? [] : pushesResult.data`; `hasPush` is then `false`, and
   `useHasActiveSiblingInWorktree` also collapses pending → `false`
   (`use-conversations.ts:87`), so the mode falls through to the destructive default.
   Same pattern in `drop-and-exit-button.tsx:20`.
3. **Sonata library shows "No songs yet — add one to get started."** —
   `song-library.tsx:100` passes `songs.pending ? [] : songs.data` into `DataView`;
   `gallery-view.tsx:101` renders `emptyState` whenever `rows.length === 0`. DataView has
   no concept of loading, so loading and confirmed-empty are indistinguishable.

**Root cause.** `useResource` already returns a type-safe discriminated union — `.data`
is inaccessible while `pending` — but ~84 call sites across ~46 files defeat it by
hand-writing `pending ? [] : result.data` (defaults: `[]` ×46, `null` ×27, plus `false`,
`0`, `{}`). That single expression manually re-synthesizes the resource's `initialData`,
after which "still loading" and "genuinely empty" are the same value everywhere
downstream. The aspirational comment in `live-state/core/resource.ts` ("consumers no
longer need `?? []` or loading guards") backfired into exactly this pattern.

**How modern apps handle this, mapped here.** (a) React Suspense: un-ready data is
unrepresentable; an ancestor owns the fallback — this repo deliberately removed throwing
Suspense, but we copy its *shape* non-throwing (`<Loaded>`). (b) Next/Remix route-level
`loading.tsx` — the analogue is the existing `PaneResolveGuard` (panes with a `resolve`
hook already get loading chrome for free); no new mechanism needed there. (c) Linear-style
sync-engine: after boot nothing ever "loads" — this app's WS-push model settles <100ms, so
the right UX is mostly *no transient UI at all*, with a **delayed** skeleton only for
genuinely slow loads, and empty states only on **confirmed-empty**.

**Decision (user-confirmed):** lint-enforced gates (not framework auto-masking), scope =
new primitives + fix the 3 named bugs + grandfather the remaining sites behind a
shrink-only allowlist. Framework-level auto-masking (LoadingScope/slot middleware) was
rejected: it hides wrong renders instead of fixing them, breaks on late-mounting
resources, and has the wrong granularity for toolbar buttons.

## Design summary

Make the correct read *easier* than the buggy ternary, then make the buggy ternary a
build error:

| Situation | Sanctioned pattern |
|---|---|
| Component reads 1 resource | `<Loaded result={r} fallback={…}>{(data) => …}</Loaded>` or early `if (r.pending) return …` |
| Component reads ≥2 resources | `const all = useResources({a, b, c}); if (all.pending) return …` (all-or-nothing — fixes stagger) |
| List/grid surface | `DataView loading` prop — `emptyState` requires confirmed-empty |
| What to show while pending | `SkeletonGate` (delay ~180ms, min-visible ~300ms → zero flash on the common <100ms settle) |
| Data-dependent action button | disabled-neutral state while pending; never a default (especially destructive) mode |
| Point lookup that wants `null` | `useResource(res, params, { select })` — stays sanctioned, lint carve-out |

## Phase 1 — live-state additions

Files: `plugins/primitives/plugins/live-state/web/` (+ barrel exports in `web/index.ts`).

### 1a. `useResources` combinator (`web/use-resources.ts`)

```ts
// Pending until EVERY input has settled at least once.
export function useResources<T extends Record<string, Gateable<unknown>>>(
  inputs: T,
): { pending: true; error: Error | null }
 | { pending: false; data: { [K in keyof T]: DataOf<T[K]> }; error: Error | null };
```

- Pure combinator over already-called hook results (no rules-of-hooks issues; despite the
  `use` name it holds no state — named for discoverability next to `useResource`).
- Accepts `ResourceResult<T>` and `UseOptimisticResourceResult<T, V>` shapes (anything
  with `pending: boolean` + `data`); `error` = first non-null error.
- Inputs must be **non-select** results (type-level): the select-slice variant can flip
  `pending` without a re-render (documented caveat in `use-resource.ts:139-143`), which
  would wedge a gate. Document: "gate on whole-resource results; select for point reads."

### 1b. `<Loaded>` gate (`web/components/loaded.tsx`)

```tsx
<Loaded result={songsR} fallback={<LibrarySkeleton />}>
  {(songs) => <DataView rows={songs} … />}
</Loaded>
```

Props: `result: Gateable<T>` (also accepts a `useResources` result), `fallback?: ReactNode`
(default `null`), `children: (data: T) => ReactNode`. Children only ever run with settled
data — the wrong default has nowhere to live. Thin component, no error UI (errors keep
flowing through the resource's `error` field / fail-loudly conventions).

No change to `ResourceDescriptor.initialData` (HTTP fallback and the optimistic overlay
base depend on it). No `gate`/notifyOnChangeProps option for select slices in this pass —
deferred until a real gate-on-slice need appears.

## Phase 2 — UX primitives

### 2a. New `skeleton` primitive plugin (`plugins/primitives/plugins/skeleton/`)

Promote the unused shadcn `Skeleton`
(`plugins/framework/plugins/web-core/web/components/ui/skeleton.tsx`) into a real
primitive plugin (mirror the `spinner`/`placeholder` plugin shape byte-for-byte,
including registry registration — regenerated by `./equin build`).

Exports from `web`:
- `Skeleton` — the `animate-pulse rounded bg-muted` block, `className`-sized.
- `SkeletonGate` — delayed loading gate:

```tsx
<SkeletonGate loading={r.pending} delayMs={180} minVisibleMs={300} skeleton={<ListSkeleton />}>
  {children}
</SkeletonGate>
```

Behavior: render nothing for the first `delayMs` while loading (common path: WS settles
first → content appears with zero transient UI); past the delay show `skeleton`, and once
shown keep it ≥ `minVisibleMs` to avoid blink. One-shot timers (not polling loops).

### 2b. DataView first-class `loading` state

Files: `plugins/primitives/plugins/data-view/` core types + `data-view.tsx`, and each view
child (`plugins/gallery/.../gallery-view.tsx`, `plugins/table/...`).

- Add `loading?: boolean` to `DataViewProps` / view render props, and optional
  `loadingState?: ReactNode` (default: a `SkeletonGate`-wrapped view-shaped skeleton).
- Views render `loadingState` while `loading`; `emptyState` renders **only** when
  `!loading && rows.length === 0` — confirmed-empty becomes a structural guarantee of the
  primitive.

## Phase 3 — fix the three named bugs

### 3a. Queue (`plugins/conversations/plugins/conversations-view/plugins/queue/web/components/queue-view.tsx`)

- Stop ignoring the optimistic hook's `pending` (it is already forwarded,
  `use-optimistic-resource.ts:116`).
- `const all = useResources({ conv, ranks, tasks })`; early-return a lightweight skeleton
  (via `SkeletonGate`) while pending. All grouping (`waitingGroups`, `unranked`,
  `blockedIds`) computes only from a mutually-consistent settled snapshot.

### 3b. Push & Exit / exit menu

Files: `push-and-exit-button.tsx`, `drop-and-exit-button.tsx`
(`plugins/conversations/plugins/conversation-view/plugins/...`), and
`plugins/conversations/web/use-conversations.ts`.

- Make the sibling hooks pending-aware: add gateable variants of
  `useHasActiveSiblingInWorktree` / `useHasActiveSiblings` returning a
  `Gateable<boolean>` shape (keep the boolean versions for non-destructive consumers, or
  migrate the few callers — check count during implementation).
- `useResources({ pushes, siblings })`; while pending render the button
  **disabled-neutral** (label "Exit", non-destructive variant, stable width — no
  skeleton/reflow in a toolbar). Mode is computed only from settled data.

### 3c. Sonata library (`plugins/apps/plugins/sonata/plugins/library/web/components/song-library.tsx`)

- Pass `loading={songs.pending}` to `DataView` (and/or wrap the section in `<Loaded>`),
  with a gallery-shaped `loadingState`. "No songs yet" can only render on confirmed-empty.
- Drop the misleading "no pending flash" comment on `songsResource.initialData`.

## Phase 4 — lint rule + allowlist

### 4a. Rule plugin `plugins/framework/plugins/tooling/plugins/lint/plugins/resource-pending-default/`

Mirror `reactive-server-io` byte-for-byte (`lint/no-pending-default.ts` + `lint/index.ts`
exporting `{ name: "resource-pending-default", rules: {...} }`; auto-enabled repo-wide as
`error` by the existing collected-dir lint discovery).

Banned (only on bindings taint-traced to `useResource` / `useResources` /
`useOptimisticResource`, reusing the `collectBindingInitializers` /
`computeTaintedBindings` template):
1. `<r>.pending ? <emptyLiteral> : <r>.data` (either branch order). Empty literals:
   `[]`, `{}`, `null`, `false`, `0`, `""`, and hoisted `const EMPTY = []`-style constants.
2. `<r>.data ?? <emptyLiteral>` / `<r> ?? <emptyLiteral>`.

Carve-outs (favor false negatives — never fire on legitimate code):
- `useResource(..., { select })` results (sanctioned point lookups that return `null`,
  e.g. `use-conversations.ts:54,67`).
- Anything not taint-traced to a resource hook (random `.pending` fields elsewhere).

Error message names the sanctioned replacements: `<Loaded>`, `useResources`, early-return
on pending, or a `select` point read.

### 4b. Grandfathering + shrink-only check

- One-time codemod inserts
  `// eslint-disable-next-line resource-pending-default/no-pending-default -- TODO(pending-default-migration)`
  at each surviving site (the 3 fixed bugs excluded). New code is enforced immediately.
- New check (`plugins/framework/plugins/tooling/plugins/checks/...` or the lint plugin's
  own `check/index.ts`, id `resource-pending-default:allowlist-shrinks`): counts the
  `TODO(pending-default-migration)` markers and fails if the count exceeds the committed
  baseline (a small checked-in baseline file the migrator decrements). Allowlist can only
  shrink.
- Follow-up migration waves are out of scope; file an `add_task` for them at the end.

## Sequencing

1 (live-state) and 2a (skeleton) are independent → land first. 2b depends on 2a.
3 depends on 1 + 2. 4 lands last (the rule must point at APIs that exist).

## Verification

- **Unit tests** (colocated, like `overlay.test.ts`): `useResources` all-or-nothing +
  error propagation; `<Loaded>` callback only invoked when settled; `SkeletonGate`
  nothing-before-delay and min-visible behavior (fake timers).
- **Lint RuleTester fixtures**: invalid cases for each banned pattern; valid cases for
  the `select` carve-out and untainted `.pending` fields.
- **Repo lint run**: `./equin check type-check` — only grandfathered sites carry
  the TODO disable comment; the three fixed files carry none.
- **Build + live check**: `./equin build`; then scripted Playwright
  (`bun e2e/screenshot.mjs`) on the queue view, a conversation toolbar, and the sonata
  library to confirm settled-state rendering is unchanged. For the pending window itself
  (a <100ms race), temporarily add a dev-only delay before the first WS push to observe
  skeleton/neutral-button behavior, then remove it.
- **Perf regression**: no changes to the select-slice hot path (no `gate` option shipped),
  so the per-conversation toolbar read behavior is byte-for-byte unchanged.

## Critical files

- `plugins/primitives/plugins/live-state/web/use-resource.ts`, `web/index.ts` (+ new
  `web/use-resources.ts`, `web/components/loaded.tsx`)
- `plugins/framework/plugins/web-core/web/components/ui/skeleton.tsx` → new
  `plugins/primitives/plugins/skeleton/`
- `plugins/primitives/plugins/data-view/` (core types, `data-view.tsx`) +
  `plugins/data-view/plugins/gallery/web/components/gallery-view.tsx` + table view
- `plugins/conversations/plugins/conversations-view/plugins/queue/web/components/queue-view.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/components/push-and-exit-button.tsx`,
  `.../drop-and-exit-button.tsx`, `plugins/conversations/web/use-conversations.ts`
- `plugins/apps/plugins/sonata/plugins/library/web/components/song-library.tsx`
- `plugins/framework/plugins/tooling/plugins/lint/plugins/reactive-server-io/lint/no-reactive-server-io.ts`
  (template) → new `.../lint/plugins/resource-pending-default/`
