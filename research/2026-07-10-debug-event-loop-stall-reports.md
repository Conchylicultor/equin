# Event-loop stalls → the reports alert funnel

## Context

The main-backend health sampler already **detects** event-loop stalls and
**stack-attributes** them, but the result reaches no one's attention. On every
tick, `health-monitor/server/internal/process-sampler.ts` measures
`eventLoopMaxMs`; on a stall (`> 3 s`) it drains the bun:jsc sampling profiler,
`aggregateTraces()` builds a `StallSection` (`topLeaves` / `topStacks`
histograms), and it fires `captureTrace({ kind: "stall", critical: true, … })`.
That lands in the **trace evidence store** (Debug → Slow Events) — but there is
**no report kind, no bell notification, no investigation-task path**.

Consequence observed Jul 7: the stall stacks named the culprit verbatim (a
ccusage transcript-parse burning 52–77 % of samples, repeatedly, over days),
while the `reports` table filled with **thousands of *victim* slow-op reports**
(flushNotifies 40 s, page-loads, delivers) that could never name the cause. The
signal existed in full; only a manual JSONL/trace read found it.

`trace/CLAUDE.md` draws the load-bearing line this change respects:

> `reports` is the **alert funnel** — dedupe, the bell, tasks-on-demand.
> `trace` is the **evidence store** — the full snapshot of one incident.
> A report **links** to its trace via a `traceId` in the report `data`.

Today a stall produces the evidence half but not the alert half. This task adds
the alert half — a new `debug/stall-monitor` plugin that mirrors the report side
of `op-rate`/`boot-budget`/`queue-health` — and moves the `captureTrace` call
into it so one plugin owns both the trace and the report for a stall (exactly how
`op-rate`'s `op-time` kind does both). It also fixes stale "files a task"
documentation across the report-monitor plugins.

**Not in scope (clean follow-up):** suppressing the collateral victim slow-op
reports filed during a freeze window. That needs a `ReportNoiseRule` keyed on a
recent-stall window and directly contradicts slow-ops' documented "cold-start
slowness is UX truth — don't suppress it" stance, so it deserves its own decision.
See "Follow-up" below — file it as a task, don't ride it on this change.

## Design

### New plugin: `plugins/debug/plugins/stall-monitor/`

Modeled byte-for-byte on `debug/read-set-shrink` and `debug/boot-budget`
(config + report kind + web KindView renderer), but **push-fed by a direct
barrel call** from health-monitor instead of a scheduled drain job — the
mirror-image of boot-budget's documented "pull-only, no accumulator" deviation.
The consumer set is closed and singular (trace + report, both inside this one
plugin), so a direct call is correct — not a `defineReportSink`/contribution
fan-out (that primitive is for error-path reporters where a low-level primitive
must not hard-depend on `reports`; not this case). This matches `op-rate` /
`slow-ops`, which call `captureTrace()` and `recordReport()` directly.

**`core/kinds.ts`** — `StallPayloadSchema`:
`{ durationMs, thresholdMs, nSamples, sampleRateHz, culprit, culpritStack,
hotFrame, topLeaves[], topStacks[], traceId? }`. All derived from the existing
`StallSection` — **no change to `StallSection`** (its doc says it is "purely the
stack evidence"; `culprit` is a presentation concern computed here).

**`core/config.ts`** — `defineConfig({ name: "stall-monitor", fields: {
enabled: boolField(true) } })`. Only an `enabled` mute. **The stall threshold
stays in health-monitor** (see below) — it is a property of *what counts as a
stall*, the detector's concern, so it does not belong in the alert plugin's
config.

**`server/internal/culprit.ts`** (pure, unit-tested) — derive the dedup grain
and labels from a `StallSection`:
- **`culpritStack`** = `topStacks[0]?.stack ?? "unknown"` — the collapsed
  name-only call-path signature (innermost→outermost, `←`-joined). **This is the
  fingerprint grain**, not the leaf. Rationale (a real flaw caught in review):
  `topLeaves[0]` on the Jul-7 stall is `JSON.parse [native]` — a generic native
  frame shared by every JSON caller — so leaf-based dedup misattributes and
  collapses unrelated JSON-heavy stalls into one row. The top *stack* names the
  actual caller path (`parseTranscript ← readEntries ← …`), is already line-free
  (names only, robust to edits), and distinguishes callers sharing a native leaf.
- **`hotFrame`** = `topLeaves.find(l => l.key.includes(" @ "))?.key ??
  topLeaves[0]?.key ?? "event-loop stall"` — a human-readable secondary hint (the
  hottest *attributable* JS frame), shown in the summary and used as the task
  title, **not** the fingerprint.
- Must guard the empty case: `aggregateTraces` returns empty arrays when
  `total === 0` (`stall-profiler.ts:136`); never index `[0]` blindly.

**`server/internal/stall-kind.ts`** — `ReportKind({ kind: "event-loop-stall",
schema: StallPayloadSchema, fingerprint: d => \`event-loop-stall:${d.culpritStack}\`,
meta: { tag: "[stall]", notif: "Event-loop stall", variant: "error",
notifCooldownMs: 30 min }, renderTask })`. `variant: "error"` — a frozen backend
is the most severe slow event. `renderTask` builds a markdown description with the
freeze duration, sample count/rate, the culprit stack, the top leaves/stacks
tables, and a deep link to the trace (Debug → Slow Events) when `traceId` is set.

**`server/index.ts`** — exports one function called from health-monitor:

```ts
export function recordEventLoopStall(
  section: StallSection,
  durationMs: number,
  thresholdMs: number,
): void {
  const { culpritStack, hotFrame } = deriveCulprit(section);
  // Evidence first — captureTrace returns the id synchronously (mints before
  // persist), never throws. Stable label so recurring identical freezes dedupe
  // at admission (label is part of the kind:label admission key).
  const trace = captureTrace({
    kind: "stall",
    label: culpritStack,          // stable across ticks of the same freeze
    durationMs,
    thresholdMs,
    critical: true,
    detail: section,
  });
  void recordReport({
    kind: "event-loop-stall",
    source: "server-stall-monitor",
    data: { durationMs, thresholdMs, nSamples: section.nSamples,
      sampleRateHz: section.sampleRateHz, culprit: hotFrame, culpritStack,
      hotFrame, topLeaves: section.topLeaves, topStacks: section.topStacks,
      ...(trace ? { traceId: trace.id } : {}) },
    message: `Event-loop stall ${Math.round(durationMs)}ms — ${hotFrame}`,
  });
}
```

- **Async safety:** `tick()` is a synchronous `void` `setInterval` callback.
  `recordReport` already wraps its own DB/bell writes in
  `runInBackgroundLane(runWithoutProfiling(…))` internally, so the caller must
  **not** double-wrap — a plain `void recordReport(…)` is the exact precedent set
  by `reports/server/index.ts`'s `setErrorReporter` (a sync `(report) => { void
  recordReport(...) }`). Satisfies `no-floating-promises`; no catch, so
  `no-bare-catch` is moot. `captureTrace` returns synchronously; read
  `trace?.id` inline, no await.
- **Stable trace label** (review flaw #5): pass `culpritStack` (not the
  varying-per-tick `topLeaves[0].key`) as `captureTrace`'s `label`, because
  `label` is part of the engine's `kind:label` admission/cooldown key — a varying
  label defeats trace-side dedup during a sustained freeze.

**`web/components/stall-summary.tsx`** — one-line Debug → Reports summary:
`[stall] <hotFrame> — <durationMs>ms` + a **"View trace" `LinkChip`** copied from
`op-rate/web/components/op-time-summary.tsx` (gated on `data.traceId`,
`navigate(traceDetailRoute.link(debugApp, { id }))`, `e.stopPropagation()`).

**`web/index.ts`** — `Reports.KindView({ match: "event-loop-stall", component:
StallSummary })` + `ConfigV2.WebRegister({ descriptor: stallMonitorConfig })`.

**`CLAUDE.md`** — hand-written prose (why it exists, the stack-vs-leaf fingerprint
rationale, the load-bearing literals: config `name` `stall-monitor` + report kind
`event-loop-stall`) followed by the AUTOGEN block (regenerated by build).

### Changes to existing files

- **`plugins/debug/plugins/health-monitor/server/internal/stall-profiler.ts`** —
  `drainAndMaybeDump` **drops** its `captureTrace` call and the
  `@plugins/debug/plugins/trace/plugins/stall/core` import (it keeps that import
  only for the `StallSection` *type* it still builds via `aggregateTraces`).
  Instead, on a stall it calls `recordEventLoopStall(section, eventLoopMaxMs,
  STALL_THRESHOLD_MS)`. The threshold constant stays here (the detector owns
  "what counts as a stall"). Health-monitor keeps the drain + `aggregateTraces`
  exactly as today. `stall-profiler.test.ts` (tests `aggregateTraces`) is
  unaffected.
- **`plugins/reports/core/sources.ts`** — add `"server-stall-monitor"` to
  `SERVER_REPORT_SOURCES`. This is the single canonical place; `tsc`/`type-check`
  enforces every call site (no bespoke check).

### Doc-drift fix (all six sites)

`reports/server/internal/investigate.ts` is now "the ONLY place that turns a
report into a task" (on demand). Several plugins still claim to *file tasks*. The
**source of truth** for a plugin's AUTOGEN `## Plugin reference` block is the
`description:` string in `server/index.ts` / `web/index.ts`; `./equin build`
regenerates the CLAUDE copies + `docs/plugins-*.md`. Prose *above* the AUTOGEN
marker is hand-written and edited directly.

**Source description strings (edit; CLAUDE autogen then regenerates):**
- `plugins/debug/plugins/slow-ops/server/index.ts:21` — "…files one task per
  distinct slow operation." → "…files one deduped **report** per distinct slow
  operation (investigation task filed on demand)."
- `plugins/reports/server/index.ts:25` — "Records server/frontend crashes and
  files deduped tasks." → "Records server/frontend crashes as deduped
  **reports**; investigation tasks are filed on demand."

**Hand-written CLAUDE prose (edit directly):**
- `plugins/debug/plugins/slow-ops/CLAUDE.md:46` — "one deduped **task** per job
  name" → "one deduped **report** per job name (investigation task on demand)".
- `plugins/debug/plugins/boot-budget/CLAUDE.md:13-14,16` — "files a deduped
  `boot-budget` report — which files an investigation task through the existing
  reports→tasks sink —" → "files a deduped `boot-budget` report; an investigation
  task is filed **on demand**", and ":16" "→ deduped **task** via a per-worktree
  scheduled job" → "→ deduped **report**; investigation task on demand".
- `plugins/debug/plugins/op-rate/CLAUDE.md:10,24,61,63` — ":10" "→ deduped
  **task**"→"deduped **report**"; ":24" "each over-called op gets its own **task**"
  →"its own **report**"; ":61/:63" "bound/storm **task** creation" → "**report**
  creation".
- `plugins/debug/plugins/queue-health/CLAUDE.md:7,24-25` — ":7" "→ deduped
  **task**"→"deduped **report**"; ":24-25" "collapses to a single **task** …
  distinct **tasks**" → "single **report** … distinct **reports** (investigation
  task on demand)".

**Also fix (drift this change itself introduces):**
- `plugins/debug/plugins/health-monitor/CLAUDE.md` "Stall stacks → the trace
  store" section attributes the `captureTrace` call to health-monitor; reword —
  health-monitor now **detects + aggregates**, `stall-monitor` **captures the
  trace + files the report**.
- `plugins/debug/plugins/trace/plugins/stall/CLAUDE.md` "the health-monitor
  sampler … fires `captureTrace(...)`" → the sampler detects and hands the section
  to `stall-monitor`, which fires the trigger.

`read-set-shrink` is already clean (no change).

## Critical files

- New: `plugins/debug/plugins/stall-monitor/{package.json, core/{index,config,kinds}.ts,
  server/{index.ts,internal/{culprit,culprit.test,stall-kind}.ts},
  web/{index.ts,components/stall-summary.tsx}, CLAUDE.md}`
- `plugins/debug/plugins/health-monitor/server/internal/stall-profiler.ts` (move captureTrace out)
- `plugins/reports/core/sources.ts` (add source literal)
- Doc-drift edits listed above (7 files)

**Autogenerated — never hand-edit; regenerated by `./equin build`:**
`plugins/framework/plugins/{web-sdk/core/web.generated.ts,
server-core/core/server.generated.ts}`, `docs/plugins-{compact,details}.md`, and
every plugin's `CLAUDE.md` AUTOGEN block + the `config/debug/stall-monitor/…
.origin.jsonc` seed.

## Verification

1. `./equin build` — regenerates registries, docs, the new plugin's config
   origin, and every touched CLAUDE AUTOGEN block. Deploys to
   `http://att-1783694371-ef3w.localhost:9000`.
2. `./equin check` — must pass `plugins-registry-in-sync`,
   `plugins-doc-in-sync`, `plugins-have-claudemd`, `type-check`, and the config
   origin check for the new descriptor.
3. `bun test plugins/debug/plugins/stall-monitor/server/internal/culprit.test.ts`
   — asserts: leaf-with-source picked as `hotFrame`; `culpritStack` = top stack;
   `JSON.parse [native]`-dominant section still yields the *caller* stack as the
   fingerprint; empty-section fallback (`"unknown"` / `"event-loop stall"`, no
   throw).
4. **End-to-end stall injection** (the real proof — the pipeline only fires on a
   genuine >3 s main-thread block): from a throwaway MCP/HTTP hook or a temporary
   debug endpoint, run a synchronous busy-loop (`const end = Date.now()+4000;
   while (Date.now() < end) {}`) on the **main** backend so the next sampler tick
   sees `eventLoopMaxMs > 3000`. Then confirm, via `mcp__singularity__query_db`
   against the `singularity` DB: a `reports` row with `kind =
   'event-loop-stall'`, `data->>'traceId'` set, and a matching `traces` row of
   `triggerKind = 'stall'`. Open **Debug → Reports** to see the `[stall]` row with
   its "View trace" chip, click through to the Slow Events Gantt, and confirm the
   bell fired once (`variant: error`). Re-inject the same stall within 30 min →
   the report `count` increments (no second bell); a stall with a different
   dominant stack → a distinct row.
5. `rg -n "files .*task|deduped task" plugins/debug/plugins/{slow-ops,boot-budget,op-rate,queue-health} plugins/reports` returns no stale "task" claims in the report-monitor descriptions/prose.

## Follow-up (separate task — do not include here)

**Victim-report suppression.** Add a `ReportNoiseRule` (`stall-collateral`) that
marks `server-slow-op` reports filed within a short window (seconds) of a stall as
`noise` — row kept, bell muted — via a module-level `lastStallAt` set by
`recordEventLoopStall` and a `recentStall(ms)` predicate. Must carry a
load-bearing comment justifying the exception to slow-ops' "don't suppress
cold-start slowness" rule (these spans are *mechanically caused* by the freeze)
and a tight window. Does not retract already-filed rows. File via `add_task`.
