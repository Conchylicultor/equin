# Vitest suite audit + a shared pane-surface test fixture

## Context

`bun run test:dom plugins/primitives/plugins/pane` fails: 6 tests across 2 files
(`deep-link-load-gap.test.tsx`, `sticky-resolve-guard.test.tsx`), every one with
the same throw:

```
usePaneStore(): no <PaneSurfaceProvider> in the tree.
```

That throw is deliberate and load-bearing. `d689683f0` (2026-07-19, *"global
chrome navigates cross-app instead of writing to an orphaned store"*) changed
`PaneStoreContext` from `createContext<PaneStore>(defaultStore)` to
`createContext<PaneStore | null>(null)`, precisely so a component rendered
outside every surface fails loudly instead of silently navigating an orphaned
`defaultStore`. The tests are what is stale — both were written **before** that
commit and neither was re-run after it.

The timeline is the whole story:

| date | commit | effect |
|---|---|---|
| ≤ 07-08 | `fc2f3c598` | adds `deep-link-load-gap.test.tsx` — renders `<Probe>` under `PluginProvider` only, leaning on the ambient `defaultStore` context default |
| 07-18 | `1a179edfe` | adds `sticky-resolve-guard.test.tsx` — renders `PaneResolveGuard` bare, no providers at all |
| 07-19 | `d689683f0` | context default → `null`; **both suites break, silently** |
| 07-23 | `ee7a51f74` | adds `deep-link-settle-then-register.test.tsx` — correctly threads `PaneStoreContext.Provider`, because it was written after the change. Its author never re-ran the siblings |
| 07-28 | `1e50a2448` | hoists `PaneMatchContext` into `PaneSurfaceProvider`; `usePaneMatch` and the pane-object route hooks now throw outside a surface too — a second contract move the hand-rolled setups don't track |

Confirmed independently: stashing `1e50a2448` reproduces the identical 6
failures, so this is pre-existing, not a regression from the Pages-tree work.

Two things follow, and this plan does both:

1. **The setups are stale because each suite hand-assembles the provider set.**
   Four pane suites, four different setups; the primitive's provider set has
   moved twice in nine days. Fixing the two files in place just resets the clock.
   The fix is one fixture that mounts the *real* `PaneSurfaceProvider`, so the
   tests track the primitive by construction.
2. **Nothing runs any of it.** No CI, no git hook, no `./equin check`
   invokes vitest — `bun run test:dom` is manual. 39 suites across 36 plugins
   have therefore been unenforced for as long as they've existed, and the pane
   ones are just the two someone happened to run. The full suite gets audited and
   fixed here, and the outcome reported.

Automation (a `dom-tests` check) was considered and **explicitly declined** —
tests stay manual. That makes the audit report the deliverable that matters: it
is the only record of what was rotting and what still guards each regression.

## Scope

- Repair the pane suites via a shared surface fixture.
- Audit **every** vitest suite (`bun run test:dom`, no path filter), fix all
  stale ones.
- Report: what was stale, what contract change broke it, and — for each — whether
  the regression it was written to catch is guarded anywhere else.

Out of scope: any check/CI wiring; new test cases beyond restoring existing ones.

## Step 1 — Get the runner working in this worktree

This worktree has **no `node_modules`** (`bun run test:dom` currently dies at
`Failed to resolve import "clsx"`, well before any test executes — do not mistake
that for a test failure). Run `bun install` from the worktree root first; nothing
below can be verified until that resolves.

## Step 2 — The shared fixture

New file, not collected by vitest (the `include` glob is
`plugins/**/web/__tests__/**/*.test.{ts,tsx}`, and this is not a `.test.` file):

`plugins/primitives/plugins/pane/web/__tests__/surface-fixture.tsx`

```tsx
/** A pane surface exactly as production mounts one: PluginProvider + the real
 *  PaneSurfaceProvider. Suites mount this instead of hand-picking contexts, so a
 *  context hoisted into the surface (PaneMatchContext, 1e50a2448) can never leave
 *  a suite mounting a partial tree. */
export function TestSurface({ store, plugins = [], basePath = "/app", children }): ReactNode {
  return (
    <PluginProvider plugins={plugins}>
      <PaneSurfaceProvider store={store} basePath={basePath}>{children}</PaneSurfaceProvider>
    </PluginProvider>
  );
}

/** A store bound as the live store, mirroring deep-link-settle-then-register. */
export function createTestSurfaceStore(opts: { live?: boolean } = {}): PaneStore {
  const store = createPaneStore({ live: opts.live ?? true });
  setLiveStore(store);
  return store;
}
```

It is a **component**, not a `render()` wrapper, because
`deep-link-settle-then-register` re-renders the same tree with a grown plugin
list (`view.rerender(...)`) to model a deferred plugin arriving — a render-only
helper can't express that.

Load-bearing details, each verified against `pane.ts`:

- **`PluginProvider` is mandatory**, even with `plugins={[]}`.
  `PaneSurfaceProvider` → `SurfaceMatchProvider` → `usePaneRoute` →
  `useSyncPaneRegistry` → `PaneSlots.Register.useContributions()`, which throws
  `"useContributions must be used within PluginProvider"`
  (`framework/plugins/web-sdk/core/slots.ts:30`).
- **`live: true` is required for any URL-derived assertion.**
  `handleLocationChange` early-returns on `if (!store.live)`
  (`pane.ts:762`) — a background store never reads `window.location`, so a
  `live: false` store makes every deep-link case resolve empty. Suites that only
  drive the guard (sticky) should pass `live: false` and stay off the URL
  entirely.
- **`PaneSurfaceProvider` is cheap in jsdom**: pure context providers plus one
  `usePaneRoute`. No tabs, live-state, network, or DB.
  (`pane.ts:1038-1109`.)
- A second `usePaneRoute` in a probe under the surface is harmless —
  `setBasePath` and the registry sync are idempotent.

## Step 3 — Repair the two failing suites

**`deep-link-load-gap.test.tsx`** — the file is inconsistent with itself: its
`resolveAt()` helper (line 104) and the `pending → resolved` case render with no
store context, while the `stale-paneId` case (line 243) already wraps in
`PaneStoreContext.Provider`. Route *every* render through `TestSurface`; create
the store per-test in `beforeEach` (replacing `setLiveStore(defaultStore)`, which
leaks route state across cases) and keep `resetDeferredLoadStateForTests()`. The
`beforeAll` registry seed and the `window.location` / `window.history` stubs stay
as they are — they are correct and the store still reads them.

The three store-level cases in the `tri-state route store` describe already pass
(they drive a `PaneStore` directly, no render); leave them, except the
`stale-paneId` one, which moves onto `TestSurface` for uniformity.

**`sticky-resolve-guard.test.tsx`** — currently renders `PaneResolveGuard` bare.
It throws only on the `pending` / not-found branches, where `FallbackChrome`
calls `paneObject.useClose()` / `.usePromote()` → `usePaneStore()`
(`pane.ts:1499-1522`) — which is exactly why test 1 (stays `found`) passes and
tests 2 and 3 fail. Wrap each render in `TestSurface` with a
`createTestSurfaceStore({ live: false })` and `plugins={[]}`. With an empty route
the instance id is `undefined`, so `useClose`/`usePromote` return `null` and no
promote/close buttons render — assertions (`pane-body`, `Not Found`, `Loading…`)
are unchanged.

## Step 4 — Migrate the sibling pane suites

`deep-link-settle-then-register.test.tsx` passes today but hand-rolls the same
setup; move it onto `TestSurface` so there is one seam to update next time the
provider set moves. `pane-isolation.test.tsx` and `history-sink.test.tsx` operate
on `PaneStore` objects and never mount pane components — leave them alone; the
fixture would add nothing.

## Step 5 — Repo-wide audit

Run the whole suite and work the list:

```bash
bun run test:dom            # all 39 files, no path filter
```

For each failing suite: identify the contract change that stale-dated it
(`git log -S` on the symbol in the error, as done for `PaneStoreContext` above),
then fix the *setup*, not the assertion — a suite that has to weaken what it
asserts to go green is reporting a real behavior change and must be flagged
instead. If a failure turns out to be a genuine product regression, stop and
report it rather than editing the test.

Note before starting: the failure count is unknown until the run — it may be a
handful of files or most of them. If it balloons, report the inventory and agree
on scope before grinding through it.

## Step 6 — Report (the deliverable the user asked for)

Two tables, in the final message:

1. **What was stale** — suite, the commit that broke it, how long it had been
   silently failing.
2. **Is the regression still guarded?** — for each repaired suite, what else
   covers the behavior. Known so far:
   - *cold deep-link must not flash the index pane* — also covered by
     `plugins/primitives/plugins/pane/e2e/deep-link-restore.ts` (manual, needs a
     deployed worktree + a page id), and partly by the passing store-level
     tri-state cases. The unit suite's unique value is that it runs in seconds
     with no deploy.
   - *sticky resolve guard* (a transient `pending` flip must not unmount a
     resolved pane) — **no other coverage found**: no e2e script, no other suite.
     Design rationale in `research/2026-07-18-primitives-pane-resolve-sticky-found.md`.
   - the rest, filled in from the audit.

Also add a short **Testing** section to
`plugins/primitives/plugins/pane/CLAUDE.md`: mount a pane surface in a test with
`TestSurface`, never by hand-picking contexts, and note the `live: true`
requirement for URL-derived cases. Durable how-it-works knowledge belongs there,
not in a memory file.

## Verification

```bash
bun install                                              # worktree has none
bun run test:dom plugins/primitives/plugins/pane         # 5 files, all green
bun run test:dom                                         # whole repo green
./equin check type-check                           # fixture is typed TS
./equin build                                      # deploy
```

Then confirm nothing regressed at runtime: open
`http://att-1785245162-ieml.localhost:9000/pages` cold on a deep link
(`/pages/page/<id>`) and check it renders the page, not the welcome pane — the
behavior `deep-link-load-gap` exists to protect. No production code changes in
this task, so this is a sanity pass, not a proof obligation.

## Risks

- **The audit is open-ended.** 37 suites beyond pane have never been enforced;
  the fix cost is unknown until step 5 runs. Mitigation: report the inventory
  early rather than silently expanding the change.
- **A "fix" that hides a real regression.** Any suite needing a *weakened
  assertion* to pass is a product bug, not a stale test — flag, don't edit.
- **Still no automation.** By decision, these suites remain manual and can rot
  again. The `CLAUDE.md` note and the single fixture reduce the blast radius (one
  seam, not four) but do not close it.
