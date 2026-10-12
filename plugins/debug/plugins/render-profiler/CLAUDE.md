# render-profiler

On-demand React **fiber-commit profiler**. The always-on DOM render-loop
detector (`plugins/reports/plugins/render-loop`) flags THAT and roughly WHERE a
subtree thrashes; this profiler names the **initiating component** and the
**offending hook** driving the loop.

OFF by default — a session walks the committed fiber tree on every commit, so
it's gated behind an explicit Start. A passive commit *bridge* is always present
(installed in `framework/web-core/web/index.html`, before React loads); its
always-on cost is one empty-`Set` check per commit.

## How it works

- The bridge installs/augments `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` with a
  `__commitSubscribers` Set. The profiler subscribes only while a session runs.
- On each commit it reads `root.current`, walks the tree, and finds **initiators**:
  the topmost component fiber that actually rendered this commit along each path
  (a rendered fiber whose ancestors did NOT render re-rendered on its own state /
  context / external store — not propagation).
- **`PerformedWork` alone is NOT "rendered this commit".** React sets the flag
  when a render fn runs but does NOT clear it on a fiber whose subtree *bails out*
  (no work-in-progress is built), so a fiber that mounted once and only ever
  bails after keeps the flag set *forever*. A flag-only test therefore reported
  every stable subtree — the whole `Core.Root` controller set (mount once, return
  null) and every idle component — as re-rendering on **every** commit triggered
  by **any** unrelated component (the tell: `commitCount === totalCommits`). The
  fix (`fiberRenderedThisCommit`) gates on **object identity across commits**:
  React double-buffers fibers, so a genuine render swaps `current` ↔ `alternate`
  and the committed fiber is a *new object*, whereas a bailed/skipped fiber is the
  *same object* (with its stale flag). The walk threads `prevSeen` (last commit's
  component fibers) ⇄ `currentSeen`; a fiber still in `prevSeen` did not render.
  The first observed commit only seeds the baseline (no history), so attribution
  is accurate from the second commit on.
- For each initiator it diffs the hook `memoizedState` linked list (and
  `dependencies` contexts) against the fiber's `alternate` to name the changed
  hook(s) — `useSyncExternalStore` (the live-state / `useQuery` culprit),
  `useState/useReducer`, or `context`.
- Aggregated by signature (ancestor path + name + changed-hook descriptor) →
  `component X, hook #N (kind), ~N.N commits/s`.
- **Mount vs update.** Each initiator is split into `mountCount` / `updateCount`.
  A mount is a fiber that was *freshly placed* this commit (`isFreshlyPlaced`:
  `alternate === null` AND React's `Placement` flag set); anything else is an
  in-place update — so a cheap re-render is told apart from a destroy-and-rebuild.
- **`alternate === null` alone is NOT a mount.** A fiber mounts once via
  `mountChildFibers` (alternate null) and, if it then only ever **bails out**
  (never re-renders — the common case for an idle `Core.Root` controller or any
  stable subtree under a re-rendering ancestor), React never builds it a
  work-in-progress alternate, so it keeps `alternate === null` *forever* while its
  DOM node and effects are untouched. The authoritative discriminator is the
  `Placement` flag, which the commit sets only when a fiber is actually
  inserted/moved in the host tree. Gating mount/remount on `isFreshlyPlaced` (both
  conditions) is what stops the profiler from reporting every stable idle subtree
  as a phantom remount on each re-render.
- **Remount attribution.** The same DFS gives every fiber a purely **index-based**
  `positionKey` (`parent + "/i:" + fiber.index` — React's authoritative per-parent
  slot), recording the occupant's `key` alongside it. A *freshly-placed* fiber
  (`isFreshlyPlaced`) at a slot the *previous* commit also occupied is a candidate
  remount; it is suppressed as a benign reorder only when the prev occupant was
  keyed AND that key still appears among the new fiber's current siblings (it
  moved, wasn't destroyed) — an on-demand `fiber.return.child` scan, no extra map.
  Otherwise it's a real remount, with cause `element-type` (the element type
  flipped, e.g. `Fragment→div`) or `key-change` (same type, identity churn — the
  classic `key={uuid()}` bug). This catches both causes with zero false positives:
  a keyed list prepend `[A,B]→[X,A,B]` reports zero remounts (A's key is still a
  current sibling), a key change `[Foo(v1)]→[Foo(v2)]` is caught (v1 is gone), and
  a stable bailed-out subtree reports nothing (not placed). Aggregated by position
  into a ranked `top remounts + cause` report (`remountTruncated` flags the 20k
  position-map cap).
- **Fibers rendered.** Each component fiber that re-rendered this commit is
  charged to the nearest initiator above it (`InitiatorStat.fibersRendered`), so
  a cheap commit (one hook, 3 fibers) is told apart from one that re-renders a
  whole list (one hook, 12 000 fibers). The report ranks initiators by it too
  ("by fibers rendered") — the count ranking alone hides the expensive ones.
- **Commit log.** `ProfilerReport.commits` keeps one `CommitSample` per commit
  (`atMs`, fibers rendered, per-initiator split), capped at 2 000
  (`commitLogTruncated`); `formatProfilerReport(r, { commits: true })` prints it.

## Use it

- **Debug → Render Profiler** pane: Start, interact with / idle on the suspect
  screen, read the ranked initiators (with mount/update split) and the
  **Remounts** section below them; auto-stops after 30s.
- **Headless** (agents):
  `./singularity run plugins/debug/plugins/render-profiler/e2e/render-profile.ts --url http://<wt>.localhost:9000/<route> --seconds 8`
- **Imperative**: `window.__reactRenderProfiler.start({maxDurationMs})` / `.stop()`
  / `.getReport()` / `.isRunning()`.
- On stop, the ranked report is dumped to the `render-profiler` JSONL log channel
  (`cat logs/render-profiler.jsonl`).

React-internals coupling (fiber `flags` / `memoizedState` / `dependencies` /
`alternate`, `PerformedWork` + WorkTag constants) is centralized in
`web/internal/react-types.ts` with defensive access; stable across React 18–19.

<!-- AUTOGEN:PLUGIN-REFERENCE -->

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: On-demand React fiber-commit profiler: when started, attributes each commit to its initiating component and the offending hook (incl. useSyncExternalStore), surfaced as the Debug → Render Profiler pane and the window.__reactRenderProfiler API.
- Web:
  - Slots: `renderProfilerPane.Actions`
  - Slot contributors: `renderProfilerPane.Actions` ← `primitives.pane`
  - Contributes:
    - `Pane.Register` "render-profiler"
    - `DebugApp.Sidebar` "Render Profiler"
    - `Core.Root` → `ProfilerInstaller`
  - Uses:
    - `apps/debug/shell.DebugApp`
    - `primitives/css/badge.Badge`
    - `primitives/css/badge.BadgeVariant`
    - `primitives/css/cluster.Cluster`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/spacing.Inset`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.Button`
    - `primitives/css/ui-kit.ControlSizeProvider`
    - `primitives/log-channels.clientLog`
    - `primitives/pane.defineRoute`
    - `primitives/pane.Pane`
    - `primitives/pane.PaneChrome`
    - `ui/icons.Icon`
  - Exports (values): `renderProfilerPane`
- Core:
  - Exports (types):
    - `CommitSample`
    - `FormatProfilerReportOptions`
    - `HookChange`
    - `HookKind`
    - `InitiatorStat`
    - `ProfilerReport`
    - `ProfilerStartOptions`
    - `RemountCause`
    - `RemountStat`
  - Exports (values):
    - `formatProfilerReport`
    - `RENDER_PROFILER_CHANNEL`
    - `RENDER_PROFILER_GLOBAL`

<!-- AUTOGENERATED:END -->
