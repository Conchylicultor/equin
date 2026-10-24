# Render Profiler — mount/update + remount attribution

## Context

The in-house React fiber-commit profiler (`plugins/debug/plugins/render-profiler`,
headless `e2e/render-profile.mjs`) reports which components **re-render** and why
(offending hook/context), but cannot distinguish a cheap in-place update from a
**destroy-and-rebuild (remount)**. Diagnosing a recent DOM-churn bug therefore
needed ~13 hand-rolled `MutationObserver` probes instead of one profiler run.

We want the profiler to attribute **mount vs update** per component, and to
produce a ranked **"top remounting components + likely cause"** report — naming
the structural cause (element-type flip `Fragment→div`, or React `key` change)
so a run prints e.g. `SlotRender item: element-type flip Fragment→div` instead of
requiring a manual DOM diff. Surfaced in both the **Debug → Render Profiler** pane
and the headless `e2e/render-profile.mjs`.

**Decision (confirmed with user):** *Extend* the in-house profiler — do **not**
integrate React Scan / bippy. The whole pipeline (commit bridge, fiber walk,
hook-classify, signature aggregation, self-exclusion, pane, JSONL dump, e2e
script) already exists and is plugin-integrated; remount detection folds into the
single existing DFS for ~tens of lines and zero new dependencies. (bippy could
later *replace* the hand-rolled `react-types.ts` to de-risk React-version drift —
tracked as a separate, optional refactor, not part of this work.) **Scope:** full
remount + likely-cause attribution.

React's primitives make this cheap and are the right tool here — `fiber.alternate
=== null` is the canonical "this fiber mounted this commit" signal, and React's
own `fiber.index` + `fiber.key` give a correct reconciliation-position identity.
We deliberately do **not** use React's `<Profiler onRender phase>` (the codebase
uses zero `<Profiler>`; the commit-bridge walk gives per-fiber granularity a
Profiler boundary's coarse `phase` cannot).

## Design

### Position identity (the crux)

A **remount** = a fiber at a *stable reconciliation position* whose `alternate`
is `null` (freshly mounted) where that position was occupied last commit. The
position key MUST mirror React's own reconciliation:

```
positionKey = parentPositionKey + "/" + (fiber.key != null ? "k:" + fiber.key : "i:" + fiber.index)
```

- **Keyed children → key segment.** Critical: index-based keys would flag a
  list *prepend* (`[A,B]`→`[X,A,B]`) as a false "remount" of every shifted row.
  Using the key, X gets a brand-new key-slot (genuine mount, skipped) and A/B
  keep their slots (reused, `alternate !== null`, not mounts). No false storm.
- **Unkeyed children → `fiber.index` segment.** This correctly catches the
  canonical remount: `cond ? <A/> : <B/>` toggles A→B at the same unkeyed slot.
- `fiber.index` is React's authoritative per-parent slot index — read it, don't
  hand-count siblings.

### Detection (folded into the existing single DFS)

Key insight that bounds cost and scope: **a fiber can only be destroyed/rebuilt
if its parent re-rendered** → a remount always lives *inside a rendered subtree*.
The DFS already tracks `ancestorRendered`. So:

- Compute `positionKey` for **every** fiber on the path (children build on it).
- **Record** `currentPositions.set(positionKey, {name, key})` only when inside a
  rendered subtree (`childAncestorRendered`/`ancestorRendered` true) **and** the
  fiber tag is a component, `HostComponent` (5), or `Fragment` (7) — skip
  `HostText` and other leaf noise. This keeps the map tiny (nodes under something
  that rendered this commit, not the whole tree).
- A fiber with `alternate === null` whose `positionKey` **exists in the previous
  commit's snapshot** ⇒ **remount**:
  - `prev.name !== name` ⇒ cause `"element-type"`, detail `prev.name→name`.
  - else `prev.key !== key` ⇒ cause `"key-change"`.
  - positionKey absent in prev ⇒ genuine new mount (list growth / first render) —
    **not** a remount, skip.
- Cap the position map at `POSITION_MAP_CAP = 20_000` entries; on overflow stop
  inserting and set `remountTruncated` on the report.

### Mount vs update

For each **initiator** (unchanged "topmost rendered" logic), set
`isMount = fiber.alternate === null`. Aggregate `mountCount` / `updateCount` per
existing signature (`commitCount === mountCount + updateCount`); count *commits*,
parallel to existing `commitCount` semantics (a list mounting = +1 mount, not
+instanceCount).

### Aggregation & data model

- **Mount/update** folds into `InitiatorStat` (same identity).
- **Remounts** are a *separate* aggregation keyed by `positionKey` (different
  identity: a position with a from→to type, not a single component). Do not
  pollute the initiator signature space.
- `prevPositions` and the remount map are module-level in `session.ts`, cleared
  on `startSession`. **`prevPositions = currentPositions` must be swapped every
  commit inside `onCommit`** (NOT on the 250ms throttled flush) or the diff goes
  stale and reports phantom remounts. First commit after Start has empty prev →
  zero remounts (desirable, no start-up spam).

### Why no `onCommitFiberUnmount` (v1)

The snapshot diff already excludes pure unmounts (no current fiber at that
position) and names the cause from `prev.name→name`. Wiring the bridge's no-op
`onCommitFiberUnmount` would add a second subscriber + buffering/correlation for
marginal gain. The `RemountCause` enum keeps an `"unknown"` slot to revisit if
position-diff causes ever prove ambiguous.

## Files to modify

- `plugins/debug/plugins/render-profiler/web/internal/react-types.ts` — add
  `index: number` to the `Fiber` interface (`key` is already present); add tag
  constants `Fragment = 7` (and `HostComponent = 5` if not already), optionally
  `HostText = 6` for the skip filter.
- `plugins/debug/plugins/render-profiler/web/internal/fiber-walk.ts` — add a
  `Fragment` case to `getComponentName` (a fragment's `type` is
  `Symbol(react.fragment)` and currently falls through to `Unknown#7`); extend
  `StackEntry` with `parentPositionKey`; broaden `collectInitiators` →
  `collectCommit(root, prevPositions)` returning
  `{ initiators: Array<{fiber, ancestorPath, isMount}>, currentPositions: Map, remounts: Array<{positionKey, ancestorPath, fromType, toType, cause}> }`.
- `plugins/debug/plugins/render-profiler/core/types.ts` — extend `InitiatorStat`
  (`mountCount`, `updateCount`); add `RemountCause`, `RemountStat`; extend
  `ProfilerReport` (`remounts: RemountStat[]`, `remountTruncated?: boolean`).
- `plugins/debug/plugins/render-profiler/core/index.ts` — re-export new types.
- `plugins/debug/plugins/render-profiler/web/internal/session.ts` — module-level
  `prevPositions` + `remounts` map; clear on start; in `onCommit` consume the new
  walk output, aggregate mount/update + remounts, swap `prevPositions` every
  commit; extend `emptyReport`/`computeReport` to emit ranked `remounts`.
- `plugins/debug/plugins/render-profiler/web/components/initiator-row.tsx` —
  render the mount/update split (e.g. `3 mounts · 12 updates`).
- `plugins/debug/plugins/render-profiler/web/components/remount-row.tsx` — NEW row
  component for a `RemountStat` (`fromType→toType · cause · ×count · ancestorPath`).
  Must call `registerExcludedComponent` (so the profiler's own remount rows don't
  appear in its own report).
- `plugins/debug/plugins/render-profiler/web/components/render-profiler-pane.tsx` —
  add a "Remounts" section below initiators; show a truncation warning when
  `remountTruncated`.
- `e2e/render-profile.mjs` — print a second `remounts:` block after the initiators
  block (`fromType→toType`, cause, count); the JSONL dump carries the new fields
  for free since it serializes the whole `ProfilerReport`.
- `plugins/debug/plugins/render-profiler/CLAUDE.md` and
  `.claude/skills/debug/SKILL.md` — document the new mount/update + remount
  capability (skill line 21 currently only mentions re-render attribution).

### New type shapes

```ts
export type RemountCause = "element-type" | "key-change" | "unknown";

export interface RemountStat {
  positionKey: string;     // key/index-keyed structural path
  ancestorPath: string[];  // nearest component ancestors, nearest-last (display)
  fromType: string;        // prev occupant name
  toType: string;          // current occupant name
  cause: RemountCause;
  count: number;           // commits in which this position remounted
}

export interface InitiatorStat {
  /* ...existing... */
  mountCount: number;      // occurrences where fiber.alternate === null
  updateCount: number;     // occurrences where fiber.alternate !== null
}

export interface ProfilerReport {
  /* ...existing... */
  remounts: RemountStat[];        // ranked by count desc
  remountTruncated?: boolean;     // position map hit POSITION_MAP_CAP
}
```

## Edge cases (handled / accepted)

- **List reorder + simultaneous insert** — keyed positionKey makes this correct
  (no false remounts). The `alternate === null` gate already neutralizes pure
  reorders.
- **Wrapper add/remove high in the tree** (`cond ? <div>{kids}</div> : kids`)
  shifts descendant index space; the toggled-in subtree is all genuinely new
  (skipped). Net effect: occasional *under*-reporting in a restructured subtree,
  never over-reporting (thanks to the `alternate === null` gate). Documented, not
  fixed.
- **Suspense fallback toggles** legitimately remount content — reported, possibly
  noisy; `ancestorPath` disambiguates. Accept for v1.
- **Portals** — children remain children in the *fiber* tree, so positionKey
  composition is unaffected.

## Verification

1. **Unit test (highest-value, deterministic)** — new
   `web/internal/*.test.ts` (`bun:test`, co-located) feeding fabricated prev/current
   fiber trees (plain objects matching the `Fiber` interface) through two passes:
   - `cond ? <A/> : <B/>` toggle ⇒ exactly one remount `A→B`, cause `element-type`.
   - **Keyed list prepend `[A,B]`→`[X,A,B]` ⇒ ZERO remounts** (pins the
     no-false-positive guarantee — the headline correctness test).
   - `<>{x}</>`→`<div>{x}</div>` ⇒ remount `Fragment→div`.
   - same type, changed `key` at a fixed index ⇒ cause `key-change`.
   Run: `bun test plugins/debug/plugins/render-profiler/web/internal`.
2. **Build & deploy** — `./equin build`, app at
   `http://<worktree>.localhost:9000`.
3. **In-app** — open **Debug → Render Profiler**, Start, drive a deterministic
   remount (e.g. from the console, mount a throwaway component flipping
   `cond ? <A/> : <B/>` each animation frame), Stop, confirm the new **Remounts**
   section lists the flip with the right cause, and initiators show mount/update
   splits.
4. **Headless** — `bun e2e/render-profile.mjs --url http://<worktree>.localhost:9000/<route> --seconds 8`;
   confirm the printed `remounts:` block and that the last
   `{type:"report",...}` line in `logs/render-profiler.jsonl` carries
   `remounts[]` + per-initiator `mountCount`/`updateCount`.
5. **Self-exclusion regression** — confirm the profiler's own Remounts rows never
   appear in its own remount list (new `remount-row.tsx` registered as excluded).
