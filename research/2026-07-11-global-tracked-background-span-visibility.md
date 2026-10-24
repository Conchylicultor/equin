# Making detached / background main-thread work visible to the runtime profiler

Date: 2026-07-11
Category: global (runtime-profiler + warmup + file-watcher + debug/stall-monitor + tooling/lint)

## Context — why this change

The runtime profiler (`plugins/infra/plugins/runtime-profiler/core/recorder.ts`) attributes
slowness only through spans of a **closed** kind set:
`SPAN_KINDS = http | db | loader | sub | push | flush | job | cascade`. There are only four
`recordEntrySpan` call sites in the whole repo (http, loader/origin/flush, job).

Everything a plugin fires-and-forgets on the main thread — a `void doThing()` in `onReady`, a
warmup body, a file-watcher callback, a `setInterval` poller — runs with **no ambient span**.
Its cost never appears under its own name; it only inflates the `selfMs` of whatever innocent
span happens to be open at the time (or, at boot, vanishes entirely). So `get_runtime_profile`,
`slow_ops`, `byParent`, and the flight recorder can only ever name **victims** for this class of
work, never the culprit. Nothing structurally prevents a plugin from creating this blind spot.

The canonical instance was `stats/cost`'s `prewarmBundle()`, which blocked main for a cumulative
~380s across boots with multi-GB allocations and never appeared in the profiler under its own
name — root-caused only via the separate JSC stall-profiler stacks. (That specific site is
already fixed by migration to `defineWarmup`; this plan addresses the structural class so the
next one can't stay invisible.)

**Intended outcome.** (1) Detached/background work becomes a first-class span, visible in
`get_runtime_profile` / `slow_ops` / the flight recorder under its own name. (2) The two biggest
recurring sources (warmups, file-watchers) get spans *for free* by instrumenting the shared
substrate. (3) A lint guard makes new untracked detachment a build error. (4) For the residual
class that no wrapper can catch — synchronous CPU blocks, forgotten work — the existing stall
report is upgraded to positively **name it as profiler-invisible** instead of leaving it implicit.

Out of scope (explicitly deferred): long-lived out-of-process workers (the `zero-cache` sidecar,
`worker_threads`) — they can't be in-process-spanned and need separate process-level
instrumentation; the host/per-backend samplers (`sentinel`, `health-monitor`) already cover the
process level.

---

## Layer 1 — Core: a `bg` span kind + `runTracked(label, fn)`

All in `plugins/infra/plugins/runtime-profiler/`.

`recordEntrySpan(kind, label, fn)` (`core/recorder.ts:1331`) is **already** the generic wrapper —
full wait/child/self decomposition, flight-ring entry, `onSlowSpan` notification, `byParent`
attribution. A new kind only needs a name + a lane.

**`core/recorder.ts`:**
- `SPAN_KINDS` (line 83) — append `"bg"`. `SpanKind`, `KINDS` (`= SPAN_KINDS`), and every downstream
  mirror derived from it update automatically (MCP filter, endpoint `z.enum(SPAN_KINDS)`, the
  spans flight-window `z.enum(SPAN_KINDS)`, op-rate `KINDS`).
- `ORIGIN_CLASS` (line 1251, `Record<SpanKind, OriginClass>` — tsc-exhaustive) — add `bg: "background"`.
  Doc: *"a `runTracked` root — declared detached work we want attributed; background because nobody
  is blocked on its millisecond, which also routes its DB work through the background lane for free."*
- `aggregates` (line 612, `Record<SpanKind, …>`) — add `bg: new Map()`. (tsc-forced.)
- `slowest` (line 627, `Record<SpanKind, …>`) — add `bg: []`. (tsc-forced.)
- Add the helper (place next to `runInBackgroundLane`, line 553):
  ```ts
  export function runTracked<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
    return recordEntrySpan("bg", label, fn);
  }
  ```
  Because a `bg` **root** maps to the background lane, `runTracked` gives DB-lane classification for
  free — no separate `runInBackgroundLane` wrap. Document it as the third member of the detached-work
  triad: `runTracked` = *detached work I want attributed*; `runInBackgroundLane` = *lane only, no span*
  (observability-internal); `runWithoutProfiling` = *suppress recording* (observability-internal).
- Add `export function profilerNowMs(): number { return now(); }` — reads the installed profiler
  clock, needed by Layer 4 to compute a flight-window lookback on the same clock domain.

**`core/index.ts`** (barrel) — add `runTracked` and `profilerNowMs` to the value re-export block.

**Seam (optional symmetry).** `plugins/framework/plugins/server-core/core/profiler-hooks.ts` +
`plugins/infra/plugins/runtime-profiler/server/internal/install.ts`: add `runTracked` to the
`ProfilerHooks` interface and `setProfilerHooks({…})` injector, mirroring `recordEntrySpan`, with a
`Promise.resolve(fn())` no-op fallback. This keeps the lint allow-list source-agnostic and lets a
future `server-core/core` detached recompute route through one name. **All substrate/migration sites
below import `@plugins/infra/plugins/runtime-profiler/core` directly** — only `server-core/core` is
barred from importing runtime-profiler (the documented cycle), and none of these sites are it.

**tsc-forced web touch:** `plugins/debug/plugins/trace/plugins/spans/web/components/spans-lane.tsx:31`
— `KIND_CONFIG: Record<SpanKind, …>` needs a `bg:` entry (label `"BG"`, an unused `bg-categorical-*`
color for bar+dot). This is the only hand-written per-kind map outside the recorder; everything else
is derived.

---

## Layer 2 — Substrate instrumentation (spans for free)

**2a. Warmup executor** — `plugins/infra/plugins/warmup/server/internal/executor.ts:52-59`. Today
`w.run()` is wrapped only in `profilerStart` (the coarse **boot**-Gantt bar), so a warmup's internal
DB/file work has no ambient `EntryContext`. Wrap the real run:
```ts
await runTracked(`warmup:${w.name}`, () => deps.withSlot(() => w.run()));
```
Keep the surrounding `profilerStart`/`end()` — boot Gantt bar and runtime `bg` aggregate are
complementary. This is the exact structural fix for the historical `prewarmBundle` class.

**2b. File-watcher dispatch** — `plugins/infra/plugins/file-watcher/server/internal/create-file-watcher.ts`.
Three main-thread dispatch points invoke consumer callbacks unspanned: `flush()`→`onChange` (line 94),
the debounce-0 `onChange` (line 140), and the reconcile timer→`onReconcile`/`onChange([])` (lines 156-162).
- Add optional `name?: string` to `FileWatcherOptions` (default `basename(dirs[0])`).
- Wrap each dispatch: `void runTracked(\`watch:${name}\`, () => onChange(events))` (reconcile →
  `watch:${name}:reconcile`).
- **Documented limitation:** `onChange` is `void`-returning, so only its *synchronous* body is charged
  to the `bg` span — which is exactly the main-thread-blocking portion. Any `void`-detached async the
  callback spawns internally is the consumer's own `runTracked` responsibility (and the Layer-3 lint
  rule enforces that at the consumer).

**2c. Migration set** — convert these context-less fire-and-forgets to `runTracked` in the same change:

| # | Site | Change |
|---|------|--------|
| 1 | `plugins/conversations/server/internal/poller.ts:293` (`startPoller`) | initial + interval tick → `void runTracked("conversations:poller", () => tick().catch(logTickError))` |
| 2 | `plugins/conversations/server/internal/turn-emitter.ts:23` (`startTurnEmitter`) | `void tick()` → `void runTracked("conversations:turn-emitter", () => tick())` |
| 3 | `plugins/infra/plugins/jobs/server/index.ts:79` | `void reconcileDeadJobs()` → `void runTracked("jobs:reconcile-dead", () => reconcileDeadJobs())` |
| 4 | `plugins/auth/central/internal/refresh-loop.ts:13` | interval body → `void runTracked("auth:refresh", () => tick())` |
| 5 | `plugins/database/plugins/change-feed/server/internal/listener.ts:168` (liveness) | `void runTracked("change-feed:reconnect", () => connect())` — low value; author judgment |

Additional `setInterval` sites the lint rule will surface — triage each (migrate vs disable-with-reason)
in the same change: `jobs/.../stuck-lock-sweeper.ts`, `.../lock-heartbeat.ts`, `.../dead-job-gc.ts`
(queue maintenance → `runTracked("jobs:…")` where it does real work; pure keep-alive heartbeat → judgment);
`infra/plugins/contention/server/internal/snapshot.ts` (feeds monitoring → disable-with-reason).

**Exclusions — must STAY untracked** (they measure the system; spanning them re-feeds the profiler):
- `plugins/debug/plugins/sentinel/server/internal/sampler.ts:205` — its callback already contains
  `runInBackgroundLane(() => runWithoutProfiling(...))`, so it **auto-passes** the lint rule. No change.
- `plugins/debug/plugins/health-monitor/server/internal/process-sampler.ts:178` and
  `.../host-sampler.ts` — pass a bare `setInterval(tick, …)` reference → flagged; add
  `// eslint-disable-next-line detached-work-safety/no-untracked-detached-work -- observability sampler:
  drains the JSC stall profiler; must stay profiler-invisible or it re-feeds the profiler it measures`.

---

## Layer 3 — Structural lint guard (Answer A)

Shipped as **error, full migration now**. New contributed plugin
`plugins/framework/plugins/tooling/plugins/lint/plugins/detached-work-safety/`, mirroring
`.../watcher-safety/` (its `lint/index.ts`, rule module, `package.json`, `CLAUDE.md`):
- `lint/index.ts` → `export default { name: "detached-work-safety", rules: { "no-untracked-detached-work": rule } }`
- `lint/no-untracked-detached-work.ts` → the rule (via `ESLintUtils.RuleCreator`, same shape as
  `no-direct-parcel-watcher` / `no-raw-resize-observer`).

The root `eslint.config.ts` auto-discovers every `lint/index.ts` and enables it as `error` repo-wide —
no root edit.

**Scope (filename guard, mirroring watcher-safety):** normalize `context.filename`; no-op unless the path
contains `/server/` or `/central/`. Skip `.test.ts` / `.spec.ts`, and `/web/`, `/core/`, `/shared/`,
`/bin/` (client/isomorphic/separate-process — a different concern).

**Allowed-escape whitelist** (unwrap to the outermost `CallExpression`, read callee `Identifier` name or
member `.property` name): `runTracked`, `runWithoutProfiling`, `runInBackgroundLane`, `recordEntrySpan`,
`captureTrace`, `recordReport` (both self-wrap internally), `enqueue` (durable jobs — the worker opens a
`job` span per run). `notify` is **tunable** — include only if it doesn't prove noisy.

**Trigger 1 — `void <Call>`:** `UnaryExpression[operator="void"]` with `argument.type === "CallExpression"`.
Flag unless the resolved callee name ∈ whitelist. **Only direct calls** (`void foo()`, `void obj.foo()`,
`void (async()=>{})()`) — deliberately **not** `void someIdentifier` (a bare promise variable that may be
awaited/stored elsewhere). This is the primary false-positive cut. Catches migration sites 2–5.

**Trigger 2 — raw `setInterval`:** `CallExpression` whose callee is `setInterval` (also `globalThis.`/
member forms). Flag **unless** the first arg is an inline function whose body *syntactically contains* a
whitelisted wrapper call. Rationale: a bare-reference callback can't be inspected → flagged (forces an
inline wrap or an auditable disable); an inline callback that wired a wrapper in is trusted. Catches
migration site 1 (whose body uses `.catch()` with no `void`, so Trigger 1 misses it), auto-passes the
sentinel sampler, forces the one health-sampler disable.

**Deliberately NOT `setTimeout`** — too common (debounce / backoff / one-shot), rarely the
invisible-long-work class, and the substrate wraps already cover the file-watcher timers. Document this
precision choice in `meta.docs` + `CLAUDE.md`.

**Message (one per trigger):** *"Detached main-thread work must be routed through `runTracked(label, fn)`
(`@plugins/infra/plugins/runtime-profiler/core`) so its cost is attributed to a span instead of silently
inflating an unrelated span's selfMs (or vanishing at boot). Explicit escapes: `runWithoutProfiling` /
`runInBackgroundLane` (observability-internal), or a job `enqueue`. A sanctioned system-measuring sampler
should carry an eslint-disable with a reason."*

---

## Layer 4 — Stall detector: an `unspanned` flag (Answer B)

Upgrade the `event-loop-stall` report to positively classify a freeze as **profiler-invisible** when no
tracked span covered it — turning the existing victim-naming into culprit-naming for exactly the
`prewarmBundle` class.

**Approach: coverage test against the co-captured flight window, computed at the trip instant.** The
classification we want is *"was any entry span in flight across the freeze?"* — because that separates the
two real cases: some entry span open ⇒ the CPU burst landed in *that span's* `selfMs` (visible, a victim
we can trace); **no** entry span open ⇒ the cost inflated nothing (or only a leaf `db` span) and is totally
invisible ⇒ **badge it**.

**Soundness despite post-hoc timing.** The JSC sampler is background-thread, so the freeze has ended by
trip time (≤ one health tick later), and the `EntryContext`s live *during* the freeze may have closed — so
reading `openEntries` at tick time is too late. But every entry span that *covered a ≥3 s freeze* is still
durably recoverable at trip time via `captureFlightWindow`: still-running composites are in `.open`; spans
that closed between freeze-end and trip are in `.completed` (the ring's 5 ms floor is far below a ≥3 s
covering span, and the ring cannot wrap during a freeze — completion rate is ~zero while frozen). The only
spans missing are <5 ms already-closed ones, none of which can have *covered* a ≥3 s freeze. The residual
imprecision is a **conservative false-negative only** (an unrelated concurrent request open across the
freeze reads as "covered", so we withhold the badge) — the safe direction, and benign for the primary
target (boot-time freezes have no concurrent requests → correctly badged). This strictly dominates a new
always-on "last entry-span boundary" watermark (same concurrent-request confound, extra primitive) and the
rejected fuzzy frame-matching option.

**Hookpoints:**
1. `runtime-profiler/core/recorder.ts` — `profilerNowMs()` (already added in Layer 1). `captureFlightWindow`
   reads module-level `openEntries`/ring directly (no ALS), so it is safe to call from the debug plugin.
2. `plugins/debug/plugins/health-monitor/server/internal/stall-profiler.ts:179` — pass the already-available
   `windowMs` through: `recordEventLoopStall(section, eventLoopMaxMs, STALL_THRESHOLD_MS, windowMs)`.
3. `plugins/debug/plugins/stall-monitor/server/internal/record-stall.ts` — add a `windowMs` param; at the
   trip instant (synchronous, alongside `captureTrace`):
   ```ts
   const fw = captureFlightWindow({ windowStartMs: profilerNowMs() - windowMs });
   const cov = classifyCoverage(fw, durationMs);  // new pure helper, ./coverage.ts
   ```
   Coverage helper: `unspanned ⇔` no **entry** span (skip `kind === "db"` — a db leaf brackets in time but
   is I/O-waiting, not CPU-covering) has an in-window `[t0, t1 ?? atMs]` span ≥ `durationMs − min(200, 10%)`.
   Return `{ unspanned: false, coveringSpan: {kind,label} }` on the first cover, else `{ unspanned: true }`.
   Add the result to the `recordReport` `data`. Imports `captureFlightWindow`, `profilerNowMs`,
   `FlightWindow`/`FlightSpan` from `@plugins/infra/plugins/runtime-profiler/core` (no cycle — stall-monitor
   sits far above runtime-profiler/core).
4. `plugins/debug/plugins/stall-monitor/core/kinds.ts:33` — add `unspanned: z.boolean().optional()` and
   `coveringSpan: z.object({ kind: z.string(), label: z.string() }).optional()` (optional ⇒ back-compat).
5. `plugins/debug/plugins/stall-monitor/server/internal/stall-kind.ts` `renderDescription` — when
   `unspanned`, lead with a prominent block: *"PROFILER-INVISIBLE CULPRIT — no tracked span covered this
   freeze; `get_runtime_profile` / `slow_ops` / `byParent` cannot see it, so this report is the only surface
   that names it. Wrap the culprit in `runTracked(label, fn)`."* When spanned, note the covering span.
6. **Fingerprint unchanged** (`event-loop-stall:${culpritStack}`): `unspanned` is stable per culprit stack,
   so it never flips between reports of the same stack. A new **field**, not a new kind or fingerprint change.

---

## Verification (end-to-end)

**`bg` spans in `get_runtime_profile`:**
1. `./equin build` (deploys + restarts). Boot runs `drainWarmups`, now `runTracked("warmup:<name>")`.
2. Call `get_runtime_profile` (MCP) with `kind: "bg"` (the filter enum now includes `bg`). Expect `warmup:*`,
   `conversations:poller`, `conversations:turn-emitter`, `jobs:reconcile-dead`, and `watch:*` on file edits.
3. Confirm a warmup's internal `db` spans now show `parent = { kind:"bg", label:"warmup:<name>" }` (byParent),
   not `null` / an innocent parent.

**Synthetic unspanned stall (main backend — sampler always armed):**
1. Temporarily add a context-less sync burst in an `onReady`:
   `void (() => { const t = Date.now(); while (Date.now() - t < 5000) {} })();` with an eslint-disable comment
   (whose presence also proves Trigger 1 fires).
2. The next health tick (`eventLoopMaxMs > 3000`) fires `drainAndMaybeDump` → `recordEventLoopStall`. Debug →
   Reports should show an `event-loop-stall` report with **`unspanned: true`** and the profiler-invisible block,
   linked to its `stall` trace.
3. Control: wrap the same burst in `runTracked("bg:probe", …)`. Re-run → report shows **`unspanned: false`**,
   `coveringSpan: {kind:"bg", label:"bg:probe"}`, and `get_runtime_profile kind:"bg"` shows a `bg:probe`
   aggregate with `selfMs ≈ 5000`. Remove the probe.

**Lint:** run repo lint; confirm the rule flags the pre-migration sites and passes after migration, the sentinel
sampler passes without a disable, and the health sampler carries its documented disable.

---

## Boundary / cycle notes

- **No new cycles.** `warmup`, `file-watcher`, `conversations`, `jobs`, `auth/central`, `database/change-feed`,
  `debug/stall-monitor` all sit above `runtime-profiler/core` (imported only by `infra/endpoints` + injected into
  `server-core`); direct `@plugins/infra/plugins/runtime-profiler/core` imports are downward edges.
- **Seam vs direct import:** only `server-core/core` may not import runtime-profiler; the `runTracked` seam
  addition is optional sugar. Every substrate/migration site imports `core` directly.
- **`bg` exhaustiveness is tsc-enforced** at `ORIGIN_CLASS`, `aggregates`, `slowest` (recorder) and `KIND_CONFIG`
  (`spans-lane.tsx`); all other kind mirrors derive from `SPAN_KINDS`.
- **Aside (separate cleanup, not this task):** `plugins/debug/plugins/health-monitor/CLAUDE.md` currently contains
  unresolved git merge-conflict markers in the "Stall stacks → the trace store" section.

## Critical files
- `plugins/infra/plugins/runtime-profiler/core/recorder.ts` — `SPAN_KINDS`, `ORIGIN_CLASS`, `aggregates`, `slowest`, `runTracked`, `profilerNowMs`
- `plugins/infra/plugins/runtime-profiler/core/index.ts` — barrel
- `plugins/infra/plugins/warmup/server/internal/executor.ts` — 2a
- `plugins/infra/plugins/file-watcher/server/internal/create-file-watcher.ts` — 2b
- `plugins/framework/plugins/tooling/plugins/lint/plugins/detached-work-safety/` — new lint plugin (Layer 3)
- `plugins/debug/plugins/stall-monitor/server/internal/{record-stall.ts,coverage.ts}`, `core/kinds.ts`, `server/internal/stall-kind.ts` — Layer 4
- `plugins/debug/plugins/health-monitor/server/internal/stall-profiler.ts` — pass `windowMs`
- `plugins/debug/plugins/trace/plugins/spans/web/components/spans-lane.tsx` — `KIND_CONFIG` bg entry
