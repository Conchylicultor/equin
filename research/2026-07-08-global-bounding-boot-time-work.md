# Bounding boot-time (`onReady`) work — a structural answer

**Category:** global (framework infra) · **Date:** 2026-07-08 · **Status:** Implemented (Phases 0–2, less deferrals below)

## Implementation status (2026-07-09)

Landed on branch `claude-web/att-1783532137-09fc` (built + all `./equin check` green + deployed; **not** committed/pushed):

- **Phase 0** ✓ — log-channels rotation + bounded tail-read (`persist.ts`, 64MB cap / 3 rotated / 8MB tail-read; 6 tests); `debug/boot-budget` monitor (files a deduped report+task when a boot-hook/warmup span exceeds its per-phase budget; verified no false fire at boot).
- **Phase 1** ✓ — `infra/warmup` (`defineWarmup`+`drainWarmups`, wired after `onAllReady`; macrotask `yieldServer`; 6 tests); `infra/corpus-index` (fingerprint-keyed incremental file index; 13 tests with cost) with **stats/cost migrated onto it** as the dogfood; `infra/retention` (`defineRetention`+`markFirehose`+`retention:firehose-bounded` check; 14 tests). Additive: `PhaseId` gained `warmup`/`drainWarmups`; `ReportSource` gained `server-boot-budget-monitor`; `search_documents.metadata` typed via `.$type<>()`.
- **Phase 2** ✓ (3 of 4) — push-reconcile → `host` warmup (kills every-worktree `git log` walk); reports backfill → `worktree` warmup **+** `_reports` 7-day retention (`where: isNull(taskId)` protects investigated reports); content-search backfill → `worktree` warmup **+** per-page content-fingerprint skip (no schema change; via new engine `getSourceDocMetadata`).

**Runtime-verified:** boot profile shows `drainWarmups` running *after* `onAllReady`; worktree-scoped warmups ran (42ms/2ms), host-scoped ones correctly *skipped* on the non-main backend (the N×-redundancy kill); cost endpoint serves correct data warm (0.25s).

**Deferred / follow-ups:**
1. `entity_versions` retention (Phase 2 item 5) — **not done**: a destructive TTL deletes users' page-version history, a product policy decision (keep-N-per-entity vs generous TTL vs cascade-only). Needs an owner call.
2. ~~Firehose check is runtime-registry-based; `./equin check` is a static process that doesn't load server registrations, so the check can't yet catch a *future* unbounded table that forgets retention. Making it statically load-complete is follow-up (the primitive + the real `_reports` bound are done).~~ **Resolved — and this item was a category error.** Making the check load-complete could never achieve its own stated goal: a table nobody *declared* is invisible to any declaration-reading check, static or runtime. Worse, the check was non-deterministic (it shares a process with `plugins-doc-in-sync`, which barrel-imports every server barrel) and its only representable failure — a bare `markFirehose` with no bound — had zero call sites. The check is **deleted**; growth-bound declaration is now a closed union whose two constructors are true by construction, and the one unverifiable claim (an FK really cascades) throws at consumer module eval, which docgen's barrel-import turns into a build-time *and* push-time gate. Catching the *undeclared* firehose is an empirical question (`pg_stat_user_tables` growth monitor), tracked separately. See [`2026-07-09-global-firehose-retention-enforcement.md`](./2026-07-09-global-firehose-retention-enforcement.md).
3. Phase 3 lints (`no-heavy-onready`, `no-adhoc-corpus-scan`) — not built (sequenced last, once exemption anchors exist).
4. Caveat: a worktree's first cost-pane request is cold (~seconds) until main has warmed the shared host index; self-heals; main is protected by its background warmup. Inherent to the host-scoped design.
5. Pre-existing, unrelated bug noticed: trace `spans` server Zod enum rejects the `cascade` origin kind emitted by `resource-runtime` (`runtime.ts:609`) → a `server-caught` crash. Drift worth fixing separately.

---


## Context

Plugins launch arbitrarily heavy warm-up work from the server `onReady` hook, and
**nothing structurally distinguishes cheap registration from a multi-GB scan.** Every
backend boot re-pays all of it: main after each `./equin build`, *plus* every
worktree agent backend on launch. The failure mode is invisible until a dataset crosses
a size threshold — then it silently degrades every boot.

The parent incident (`stats/cost` re-parsing the whole 2.3 GB `~/.claude/projects` tree on
every boot, no `isMain` guard → 3–10 s event-loop freeze, 3.4 GB RSS spike) was fixed as
*one instance* (commit `13b946519`). This plan generalizes that fix into a repo-wide
invariant so the **whole class** becomes structurally impossible.

There is no repo-wide answer today for four questions. This plan gives one for each:

- **(a) May boot work be eager at all?** — No heavy work runs eagerly in `onReady`. Heavy
  warm-up is a *declared* category (`defineWarmup`) that the framework *defers past
  serving-ready and throttles*.
- **(b) How do warm-ups over file corpora stay incremental?** — `defineCorpusIndex`: a
  fingerprint-keyed incremental file index (the `stats/cost` template, generalized).
- **(c) How is boot-window work throttled so it can't compete with first requests?** — the
  warmup executor drains under a concurrency gate + `withHeavyReadSlot` + a *macrotask*
  server yield, after the server is already serving.
- **(d) How do unbounded-growth datasets get bounded?** — a log-channel substrate rotation
  fix (bounds all channels at once) + `defineRetention` for growing DB tables + a
  declared-firehose `./equin check`.

Enforcement is **led by a runtime boot-budget monitor** (a heavy boot hook self-reports +
files a task the moment it trips a wall-time/event-loop-block budget), with **narrow static
lints as backstops**. Static "is this heavy?" detection is undecidable in general — the
monitor catches cost regardless of code shape; lints only ban the few unambiguous shapes.

## The audit (what exists, what deviates)

**Boot lifecycle** (`plugins/framework/plugins/server-core/bin/index.ts`): `register`
(sync) → `onReadyBlocking` (hard barrier, migrations/registry only) → `markServerReady()`
→ `onReady` (graph-driven, **runs concurrent with request serving on the single event-loop
thread**) → `onAllReady` (full barrier; only `jobs` uses it). **No throttle, timeout,
priority, or concurrency cap is applied to the `onReady` phases.** Each hook is already
wrapped in `profilerStart(hook:id)` and phase boundaries in `recordMemoryCheckpoint` — the
instrumentation the monitor needs already exists.

**Reference template that works** (`plugins/stats/plugins/cost/server/internal/usage-index.ts`):
host-global on-disk index keyed per-file by `(mtime,size)`; only re-parses changed files;
bounded concurrency (`createSemaphore(6)`) + `withHeavyReadSlot` per parse + yield between
files; atomic temp+rename persist, **main-only writes** (`isMain()`); push freshness via a
main-only `@parcel/watcher`; heavy pricing decoupled into a throttled off-loop subprocess.
Second incremental exemplar: `derived-views` fingerprints compiled DDL (sha256) and skips
rebuild when unchanged.

**Deviating instances the design must fix:**

| # | Instance | Shape |
|---|----------|-------|
| 1 | `tasks/server/internal/push-watcher.ts` `runInitialReconcile` | full `git log` walk of **all** main history, every worktree, every boot, no `isMain` gate |
| 2 | `reports/server/internal/backfill-noise.ts` | full unbounded `_reports` select + row-by-row updates, every worktree, every boot, no `isMain`; `_reports` has **no retention** |
| 3 | `apps/.../pages/.../content-search/server/internal/backfill-job.ts` | full `_blocks` scan + sequential reindex, enqueued from `onReady` every boot, not incremental, no `isMain` |
| 4 | `primitives/.../log-channels/server/internal/persist.ts` | `appendFileSync` with **no rotation ever** (`live-state.jsonl` = 4.2 GB); read path `readFileSync(wholeFile)` then `.slice(-tail)` |
| 5 | `entity_versions` (history engine) | **no retention job** |

Everything else (worktree-cleanup reap, attachments orphan-sweep, `trace-cleanup`,
live-state-snapshot catch-up, cron scheduling — `backfillPeriod:0` already prevents a cron
catch-up flood) is already bounded/gated correctly.

## Design

### Boundary placement (load-bearing)

The warmup executor uses `withHeavyReadSlot`/`isMain()` (both `infra`) and a server yield.
`infra` depends on `framework/server-core`, never the reverse — so the executor **cannot**
live in `server-core/core` (would invert the dependency, trip boundary checks). Following
the exact `defineJob`/`jobRegistry` precedent:

- `defineWarmup` + the drain executor live in a **new `plugins/infra/plugins/warmup/`**.
  `defineWarmup` returns a `Registration` (type imported from `server-core/core`, exactly as
  `infra/jobs` does) that side-effects into a module-level registry at `register()` time;
  mounted via `register: [warmupToken]` — no new mounting mechanism.
- `server-core/bin/index.ts` calls `drainWarmups()` (imported from `@plugins/infra/plugins/warmup/server`)
  **after `onAllReady`** (~line 370). `bin/index.ts` is the composition entry (not `core/`) and
  already imports `infra/paths` + `spawn-priority`, so this creates no core-level cycle.

Warmup-to-warmup ordering is intentionally **not** modeled — warmups run after the
`onAllReady` barrier, so all migrations/`onReady` state is settled; any cross-warmup data
dependency must go through the consumer's own lazy on-demand refresh, never boot ordering.

### Primitive 1 — `defineWarmup` (a + c) · `plugins/infra/plugins/warmup/server/`

```ts
interface WarmupSpec {
  name: string;                 // stable id → profiler span + budget-report dedup key
  scope: "host" | "worktree";   // host ⇒ runs ONLY on main (isMain gate, kills N× redundancy)
  run: () => Promise<void>;
  budgetMs?: number;            // per-warmup wall-time budget (default from config)
}
export function defineWarmup(spec: WarmupSpec): Registration;
export async function drainWarmups(): Promise<void>; // called by bin/index.ts after onAllReady
```

Executor semantics (baked in, not per-consumer): skip `host` warmups when `!isMain()`; each
`run` wrapped in `withHeavyReadSlot`, under `createSemaphore(WARMUP_CONCURRENCY)`, with a
`yieldServer()` between warmups; `profilerStart("warmup:"+name)`; try/catch **never fatal**
(a warmup is an optimization — a throw records to the boot-budget accumulator and moves on).

**Declarative, not imperative.** Reject a `deferBootWork(fn)` called from inside `onReady`:
it stays lint-invisible (looks like raw onReady work) and can't carry `scope` as a static
property the executor reads. The declarative contribution is what makes "heavy boot work" a
structurally distinct, enforceable category.

**New `yieldServer()`** (fixes a real gap): today's `await Promise.resolve()` in
`usage-index.ts:270` is microtask-only — it does **not** admit request IO/timers. Add a
macrotask yield, `scheduler.yield?.() ?? new Promise(r => setImmediate(r))`, as a server twin
of the browser `yieldToMain` (home: `primitives/perfs/plugins/scheduler/server/` for symmetry,
or a small `infra/warmup` export). Without it the throttle is cosmetic under a busy loop.

### Primitive 2 — `defineCorpusIndex` (b, **file corpora only**) · `plugins/infra/plugins/corpus-index/server/`

Direct generalization of `usage-index.ts`, preserving its injectable-deps testability.

```ts
interface CorpusIndexSpec<TPartial> {
  name: string;
  roots: string[] | (() => string[]);
  match: (path: string) => boolean;           // e.g. p => p.endsWith(".jsonl")
  parse: (path: string) => Promise<TPartial>; // per-file, side-effect-free
  indexPath: string;                           // host-global dir or worktreeDataDir
  scope: "host" | "worktree";                  // host ⇒ persist only when isMain()
  version: number;                             // bump on TPartial shape change ⇒ full rebuild
  concurrency?: number;
}
interface CorpusIndex<TPartial> {
  ensureFresh(): Promise<void>;      // lazy (mtime,size) stat-diff — THE correctness fallback, call on every read
  entries(): Map<string, TPartial>;  // rollup stays in the consumer
  startWatcher(): Promise<void>;     // main-only push freshness
  warmup(): Registration;            // convenience: defineWarmup wrapping ensureFresh + startWatcher
}
export function defineCorpusIndex<T>(spec: CorpusIndexSpec<T>): CorpusIndex<T>;
```

Baked in from the template: `(mtime,size)` fingerprint keying, atomic temp+rename persist,
drop-vanished entries, bounded concurrency + `withHeavyReadSlot` + `yieldServer()`, ENOENT
tolerance, version-mismatch → rebuild, `persist = isMain()` for host scope. **`ensureFresh()`
on every read is mandatory** — it is what makes warmup deferral safe (a cold first request
just pays the incremental stat-diff). Out of scope: the pricing subprocess / token-dollar
decoupling stay in `stats/cost`. **`stats/cost` migrates onto this as the proving dogfood.**

DB-backed backfills are **not** corpus indexes — no `defineIncrementalBackfill` (that would
over-abstract three dissimilar backfills). They use `defineWarmup` + `dedup:"singleton"` job
+ a per-row content fingerprint skip (the `derived-views` sha256 pattern).

### Primitive 3 — Retention (d)

**3(i) log-channels substrate fix** (highest value, no new API) —
`primitives/.../log-channels/server/internal/persist.ts`, bounds *all* channels at once:
- **Write** (`appendEntry`): `statSync`; if size > cap (≈64 MB) rotate `<ch>.jsonl` →
  `.1` → `.2` (cap N, unlink oldest). Keep the append synchronous (mid-build-restart durability).
- **Read** (`readChannelEntries`): replace `readFileSync(whole)` with a bounded tail read
  (open + read last `min(size, CAP)` bytes, drop first partial line, `-tail`). Today a 4.2 GB
  read is fully materialized on every tail request.

**3(ii) `defineRetention`** thin wrapper · `plugins/infra/plugins/retention/server/` — wraps
`defineJob` (precedents: `attachments.orphan-sweep`, `debug.trace-cleanup`):

```ts
interface RetentionSpec {
  table: PgTable; column?: string /* "createdAt" */; ttlDays: number;
  cron?: string /* "0 4 * * *" */; perWorktree?: boolean; where?: SQL; firehose?: boolean;
}
export function defineRetention(spec: RetentionSpec): JobFactory; // DELETE WHERE column < now()-ttl [AND where]
```

`_reports` and `entity_versions` are per-worktree DBs → `perWorktree: true`.

**3(iii) firehose check** · `plugins/infra/plugins/retention/check/` — automatic
unbounded-growth classification is undecidable and would false-positive on every lookup
table, so **invert to a declared set**: a table opts in as firehose (`firehose:true` /
`markFirehose(table)`); the check fails only when a *registered firehose* table has neither a
`defineRetention` naming it nor an FK `onDelete:"cascade"` to an owner. Initial set:
`_reports`, `entity_versions`, change-feed/log rows.

### Enforcement / visibility — boot-budget monitor (lead) · `plugins/debug/plugins/boot-budget/`

Sibling of `debug/boot-profile`, structured exactly like `debug/read-set-shrink/monitor-job.ts`:
a `defineJob({ schedule:{cron:"* * * * *", perWorktree:true}, dedup:"singleton" })` that reads
the post-boot profile (`getProfilingData()`) once and files a **deduped `recordReport` +
investigation task** when any boot hook OR warmup span exceeds its budget. Thresholds in
Settings→Config via `config_v2` (matching `op-rate`). This makes a heavy boot hook **loud
immediately**, not invisible-until-threshold.

Caveat: "blocks the loop" ≠ "long span" (a long span may be awaiting IO). Sample event-loop
delay during boot (`perf_hooks.monitorEventLoopDelay` if Bun-compatible, else a `setInterval`
drift sampler from `boot-start`, read at `after-onAllReady`) and attribute via the authoritative
phase-boundary memory checkpoints.

**Narrow lints (backstops)** under `tooling/plugins/lint/plugins/` — ban only unambiguous
shapes, ship *after* the primitives stabilize (so exemption anchors exist, mirroring how
`no-adhoc-import-scan` postdated its primitive):
- `no-heavy-onready` — `readdirSync`/`readFileSync` or unbounded `db.select().from(x)` (no
  `.where`/`.limit`) inside `onReady`/`onReadyBlocking`. Fix = `defineWarmup`.
- `no-adhoc-corpus-scan` — a `readdir`+`readFile`/`Bun.file().text()` loop in `*/server/**`
  outside `defineCorpusIndex`.

## Instance migrations

1. **push-reconcile** → `defineWarmup({ name:"tasks.push-reconcile", scope:"host", run: runInitialReconcile })` — `host` gate kills the every-worktree `git log` walk; steady state already flows through the `git.refAdvanced` trigger + DB-dedup.
2. **backfill-noise** → `defineWarmup({ scope:"worktree" })` (defers the `_reports` scan off serving-critical `onReady`) **+** `defineRetention({ table:_reports, ttlDays:7, perWorktree:true })`.
3. **content-search backfill** → enqueue from a `defineWarmup` **+** make `reindexPageSearch` skip-if-unchanged via a per-block content fingerprint.
4. **log-channels** → substrate fix 3(i). No plugin migration.
5. **entity_versions** → `defineRetention` + register in the firehose set.

## Phasing

- **Phase 0 — visible + stop the bleed (no new primitives, no DB migrations):** boot-budget
  monitor (reuses existing profiler; ship first so everything after is measurable); log-channels
  substrate fix (stops the 4.2 GB growth today).
- **Phase 1 — boundary-invariant core (primitives, dogfood only):** `infra/warmup`
  (`defineWarmup` + `drainWarmups` wired into `bin/index.ts`) + `yieldServer()`;
  `infra/corpus-index` with `stats/cost` migrated onto it; `infra/retention` (`defineRetention`
  + firehose check).
- **Phase 2 — migrate the five instances** (each now a small localized change against a stable API).
- **Phase 3 — narrow lints** once exemption anchors exist.

After Phases 0–1, "heavy boot work" is a declared, throttled, scope-gated category with a
runtime budget alarm and a retention invariant — **even before any single instance migrates.**

## Risks / edge cases

- **Warmup is an optimization, never a correctness dependency.** Consumers must work cold via
  the corpus-index `ensureFresh()` lazy fallback — a request that *needs* warmed state is a
  misuse, enforced at boot-budget review.
- **Host-scope warmup with no main backend** (box running only worktree backends): the host
  warmup never runs → consumers fall back to lazy in-memory compute with `persist=false`.
  Acceptable (matches `stats/cost` today) — every host consumer must tolerate an absent/stale
  index. Never a worktree writer to a host-global file.
- **Cross-process write races**: single-writer (main) + atomic temp+rename is the invariant;
  `persist = scope==="host" ? isMain() : true`. A future multi-writer host need must go behind
  `createHostSemaphore` (flock).
- **`onReadyBlocking` stays migrations/registry-only** — `no-heavy-onready` covers it too.
- **Drain competes with live requests** (server serves since `markServerReady`, before
  `onReady`) — the heavy-read slot + small semaphore + macrotask yield are load-bearing, not
  decorative; the main-only QoS boost keeps serving above the drain.

## Critical files

- `plugins/framework/plugins/server-core/bin/index.ts` — add `drainWarmups()` after `onAllReady` (~line 370)
- `plugins/stats/plugins/cost/server/internal/usage-index.ts` — corpus-index template to generalize + dogfood
- `plugins/infra/plugins/jobs/server/internal/registry.ts` — the `defineJob`/`Registration` pattern `defineWarmup`/`defineRetention` mirror
- `plugins/primitives/plugins/log-channels/server/internal/persist.ts` — substrate rotation + tail-read
- `plugins/debug/plugins/read-set-shrink/server/internal/monitor-job.ts` — monitor template for boot-budget
- New homes: `plugins/infra/plugins/warmup/`, `plugins/infra/plugins/corpus-index/`, `plugins/infra/plugins/retention/`, `plugins/debug/plugins/boot-budget/`

## Verification

- **Boot-budget monitor:** temporarily add a `defineWarmup` (or leave a heavy `onReady`) that
  blocks the loop; confirm a report + investigation task appears within a minute
  (`query_db` on the reports/tasks tables, Debug → Reports pane). Confirm a cheap boot fires
  nothing.
- **`defineWarmup` deferral + scope:** boot a worktree backend; assert (via the profiler
  Gantt / `boot-profile`) that no `warmup:*host*` span runs on non-main, and that warmup spans
  land **after** `after-onAllReady`. A/B main's `after-onReady` event-loop-delay before vs after.
- **`defineCorpusIndex` incrementality:** after `stats/cost` migration, touch one transcript,
  confirm `ensureFresh()` re-parses exactly one file (log/instrument the parse count); confirm
  a cold Cost-pane request is correct (lazy fallback) and warm requests are <150 ms.
- **log-channels rotation:** drive a channel past the size cap, confirm rotation files appear
  and the tail read returns correct recent lines without materializing the whole file (measure
  RSS/time on a large channel).
- **Retention:** run `defineRetention` job manually, confirm rows past TTL are deleted and the
  firehose `./equin check` fails when a registered firehose table drops its policy.
- Run `./equin build` and `./equin check` after each phase.
