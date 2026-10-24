# Read-set self-heal: replace-not-union on FULL recompute

Date: 2026-07-07
Scope: global (runtime-profiler read-set capture; live-state L2 persisted materialization)
Follows: `research/2026-07-07-global-read-set-notifications-attribution-noise.md`

## Problem

The loader→table read-set index (`runtime-profiler/core/recorder.ts` `readSetIndex`)
is **append-only**: live capture (`recordEntrySpan`'s loader flush), boot seeding
(`seedReadSetIndex` from `live_state_snapshot.tables_read`), and every recompute
UNION in; nothing evicts short of `resetRuntimeProfile`. Combined with per-resource
persistence into `tables_read` and boot-time re-seeding, **any one-time
mis-attribution becomes permanent across restarts** — seeded on boot → union-preserved
through every recompute → re-persisted.

The prior doc fixed the source of the specific leak (Fix B: the SQL extractor now
matches only `FROM`/`JOIN`, never write targets) and evicted the notifications edge
with an owner-asserted reconcile (Fix C: `reconcileReadSetTable`). But Fix C only
covers a table whose owner KNOWS it has a single reader. The general weakness
remained: a dependency a **code change** removes (a loader that stops reading a
table) is carried forever, over-recomputing that resource whenever the dead table
changes and raising a false "silent FULL recompute" flag in the Debug → Read-set pane.

## Evaluated fix: replace-not-union on FULL recompute

Persist a resource's read-set as the tables read by its **most recent FULL loader
run** (REPLACE), not the accumulated union, so a dropped dependency is shed. The
persist SQL already does a column-level replace (`SET tables_read = EXCLUDED`); the
only change is the VALUE fed in — the per-run capture instead of the union.

The task flagged three things to get right: (a) plumb the per-run `ctx.tables` out
of the recorder (vs the union); (b) confirm a FULL recompute really reads every
dependency table for current data (conditional-per-key queries are the risk);
(c) keep catch-up's over-approximation safety.

## Safety analysis

### The invariant a replace must not break

Catch-up (`live-state-snapshot/catch-up.ts`) and live routing (`applyDbChange`)
both invert the read-set (`table → resource`). For those to never MISS a recompute,
a resource's read-set must be a **superset** of its true dependency set
(over-approximation). Union guarantees this by never shedding; a replace preserves
it **iff the run being persisted read every true dependency**. A run that read a
strict subset (a data-dependent conditional query that didn't fire) would
under-approximate → a later change to the shed table wouldn't recompute the
resource → stale.

### (b) Do persisted resources have data-dependent conditional queries?

**No.** All 17 `bootCritical` resources were enumerated and their loaders inspected
(15 are DB-backed; `release.previews` and `build.frontendHash` are
`defineExternalResource`, excluded from persistence). Every FULL-recompute path
(`ctx === undefined`) reads a **fixed, deterministic table set**. The only
conditionals branch on scoped-vs-full (`ids ? … : …`); the FULL branch always
touches the complete table list. `queryResource`-compiled resources are
single-`from` declarative compiles with no conditional logic at all. So a FULL
recompute's observed table set is structurally identical every time — the
authoritative complete set. Replace never under-approximates for today's resources.

This is an **empirical property of the current resource set**, and it is the safety
basis for the persisted replace. See "Residual & follow-up".

### Self-heal net even if (b) were ever violated

Two independent facts bound the blast radius of a hypothetical future
conditional-query persisted resource:

- **Sub-ack always re-loads.** `handleSub` runs the loader fresh on every subscribe
  unless a `revalidate` ETag matches. **No bootCritical resource declares
  `revalidate`.** So a stale persisted snapshot is corrected the instant a client
  subscribes — the persisted value is a first-paint accelerator, not the live truth.
- **Live routing stays over-approximating (see the two-layer split below).** The
  in-memory `readSetIndex` that `applyDbChange` inverts is NOT touched by the
  replace — it stays union — so a live change to a conditionally-read table always
  reaches its resource, regardless of what the last FULL run happened to read.

The one un-self-healed corner would be a conditional-query resource that is
`bootCritical` (hydrated) but whose UI is never mounted that session (never
subscribed): its first-paint value could be briefly stale for a conditional
dependency that changed during downtime AND was inactive at the last persist. No
such resource exists today (none are conditional). Filed as a follow-up.

### (c) Over-approximation safety preserved — the two-layer split

The read-set lives in two places with different safety needs, so the fix touches
only one:

| Layer | Consumer | Safety need | Fix |
|---|---|---|---|
| In-memory `readSetIndex` (union) | `applyDbChange` — **live** change-feed routing for ALL resources | must never UNDER-deliver (a missed live change = durable staleness) | **unchanged — stays append-only union (over-approximation)** |
| Persisted `tables_read` (seed) | catch-up + boot re-seed — first-paint freshness for persisted resources | a stale edge only wastes a recompute; a missed edge self-heals on subscribe | **replaced with the per-run FULL capture** |

Replacing only the durable seed is what makes the corruption self-heal (the seed no
longer re-imports a dead edge every boot) while keeping live routing strictly
over-approximating. The in-memory `_debug` view and live routing shed the dead edge
on the **next boot** (re-seed from the now-clean `tables_read`), which is frequent
in this build-restart dev loop; the durable corruption is gone the moment the
resource next FULL-recomputes.

We deliberately do NOT also replace the in-memory index: that would drop a
conditionally-read table from live routing (durable live staleness for that class),
and keeping it union costs only a wasteful recompute on a dead edge until the next
boot re-seed. This is the conservative, future-proof choice.

## Implementation

- **(a) per-run capture** — `recorder.ts` records `lastLoaderReadSet[label]` (the
  exact `ctx.tables` of the run, REPLACE) alongside the append-only `readSetIndex`
  union, in `recordEntrySpan`'s loader flush (same `tables.size > 0` gate, so a
  no-table run never replaces a real set with empty). Exposed as
  `getLastLoaderReadSet(key)`. Read synchronously right after the awaited loader —
  every persisted resource is param-less (single pk), so no concurrent same-key run
  can clobber the capture in between (verified: all 17 bootCritical resources are
  param-less).
- **Wiring** — `getLastLoaderReadSet` flows through the same seam as
  `getReadSetIndex`: recorder core → `runtime-profiler/server/install.ts`
  (`setProfilerHooks`) → `server-core/core/profiler-hooks.ts` (`ProfilerHooks`) →
  `server-core/core/resources.ts` injects `lastReadSet: (key) => getLastLoaderReadSet(key)`
  into `createResourceRuntime`.
- **Persist** — the runtime's three FULL-persist sites (`drainEntry` legacy path,
  `drainMembershipFull`, `drainMembershipScoped`) call a single
  `persistReadSet(key) = opts.lastReadSet?.(key) ?? opts.readSet?.(key) ?? []`.
  Per-run when available; falls back to the union on central (no `lastReadSet`
  injected) or a scoped-membership cycle that ran no loader (a pure DELETE keeps the
  prior run's stable capture). A scoped run reads the same `FROM`/`JOIN` tables as a
  FULL run (only the `WHERE` differs), so using the per-run capture on the
  membership paths is correct for the fixed-read-set resources.

## Relationship to the prior fixes

Complementary. Fix B stops new write-target leaks at the source; Fix C evicts a
known single-reader table's historical edge immediately (owner knowledge). This
fix is the **general, automatic** self-heal for the remaining class — dead
dependencies from code changes — with no per-table owner assertion: the durable
seed converges to the current read-set on the resource's next FULL recompute.

## Residual & follow-up

- The persisted replace's safety rests on "no persisted resource issues a
  data-dependent conditional query" — true today, but nothing ENFORCES it. A future
  conditional-query bootCritical resource would get the bounded staleness described
  above. Follow-up filed to add a `./equin check` (or a runtime assertion that
  a persisted resource's successive FULL read-sets are stable) so the invariant is
  structural rather than assumed.
- The in-memory `_debug` false-flag for a dead edge clears on the next boot (re-seed
  from clean `tables_read`), not immediately. Acceptable given build-restart cadence;
  an owner-asserted `reconcileReadSetTable` (Fix C) remains the tool for immediate
  eviction of a known-spurious edge.
