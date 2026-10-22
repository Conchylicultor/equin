# sink-safety

Two repo-wide ESLint rules that keep the durable-sink invariant enforceable:
**every durable sink is declared, enumerable, and growth-bounded.** They fence the
two low-level mechanisms a new perf/observability sink is hand-rolled from, so the
sanctioned doors — `captureTrace()` (evidence), `recordReport()` (alert),
`defineLogSink()` / `defineFileSink()` (declared durable stores) — are the only
ones left open.

## Why

`research/2026-07-08-global-unified-slow-event-tracing.md` collapsed seven
fragmented perf artifacts into `captureTrace` + `recordReport`, but only by
convention. Two of the deleted artifacts (`flight-recorder.jsonl`,
`stall-profiles.jsonl`) were persisted **log channels**; a third
(`slow-op-markers.jsonl`) still is. The `persist: true` flag that spawned them is
now gone (`defineLogSink` replaces it — see
[`log-channels`](../../../../../../../primitives/plugins/log-channels/CLAUDE.md)), so
the remaining ad-hoc doors are **raw filesystem appends** and a **second
runtime-profiler subscriber**. Both are lexically precise, so both are guardable
without semantic heuristics — the `no-direct-parcel-watcher` allowlist shape.

See `research/2026-07-10-global-durable-sink-guardrail-v2.md` for the full design
(and why the earlier `persist: true` lint rule was replaced by deleting the flag).

## The rules

### `no-adhoc-file-sink`

Bans append-mode filesystem writers — the way to accumulate bytes on disk without
a bound:

- `appendFile` / `appendFileSync` / `createWriteStream` imported from `fs` /
  `node:fs` / `fs/promises` / `node:fs/promises` (named, aliased, or via member
  access on a namespace/default import), and re-exports of them;
- `Bun.file(x).writer()`;
- an append smuggled through a whole-file writer: `writeFile(Sync)` / `Bun.write`
  carrying `{ flag: "a…" }`.

**Whole-file writes are NOT touched** — `writeFileSync` / `Bun.write` are codegen,
config, and build artifacts, used everywhere; only *append* is a sink shape.
Type-only imports are allowed. `require("fs")` / `await import("fs")` are out of
scope, matching the repo's existing `no-adhoc-import-scan` convention.

*Owner (`file-sink/exempt/index.ts`):* `plugins/infra/plugins/file-sink/` — the
sanctioned chokepoint, the implementation of bounded/rotated/declared append.
*Exceptions (`exempt/index.ts` of `reports` and `debug/paging-probe`):* two production sites where routing through
`defineFileSink` is structurally impossible —
`plugins/reports/plugins/engine/server/internal/buffer.ts` (the crash buffer appends inside an
`uncaughtException` handler on a dying event loop, with drain-then-unlink queue
semantics no channel offers) and
`plugins/debug/plugins/paging-probe/server/internal/probe/entry.ts` (spawned as its
own child process under a load-bearing lean-closure constraint — importing
`defineFileSink` would pull the whole plugin graph into the probe's heap and
destroy the phys_footprint measurement it exists to take; its output is bounded the
other way, config-gated OFF by default and run only for controlled investigations)
— and `**/*.test.ts(x)` (a test that appends to a fixture is scaffolding, not a
durable production sink).

### `no-adhoc-profiler-seam`

Bans importing the runtime-profiler observation seams —
`onSlowSpan` / `captureFlightWindow` / `readGateGauges` — from
`@plugins/infra/plugins/runtime-profiler/core` outside their owners. A second
`onSlowSpan` subscriber is precisely how flight-recorder's near-identical twin
installer grew alongside slow-ops. To add a perf signal, contribute a
`defineTraceEventClass` — the engine calls your `captureAtTrip` at the same
coherent instant and the signal lands in every trace and the Gantt automatically.

Keys on **named specifiers, not the module**: `getRuntimeProfile` (the sanctioned
pull API `op-rate` polls) and `registerGateGauge` (the gauge producer side, ~5
legit callers) live in the same barrel and stay valid.

*Owners (each declares it in its own `exempt/index.ts`):* `plugins/debug/plugins/slow-ops/`,
`.../trace/plugins/spans/`, `.../trace/plugins/gates/`,
`plugins/debug/plugins/stall-monitor/`, and
`plugins/debug/plugins/profiling/plugins/runtime/`. slow-ops installs the one
`onSlowSpan` subscriber; the trace spans/gates classes read the flight window /
gauges at the trip instant; stall-monitor reads the flight window at the SAME trip
instant to test span coverage of a freeze (evidence-at-trip, the same category as
trace/spans); profiling/runtime serves the live flight window on demand to the
Debug → Profiling Gantt pane (the pull-read UI for the flight window —
`getRuntimeProfile` has a different shape, aggregates/slowest with no in-flight
set, so it cannot supply it). The profiler's own internals import the seams by
relative path (`./recorder`), never the `@plugins/...` source the rule keys on, so
they need no entry. *Tests are out of scope* — a test importing
`readGateGauges` / `onSlowSpan` to assert profiler behavior is testing the
profiler, not starting a perf sink.

## What this deliberately cannot catch

A new `defineEntity` perf **table** with a `defineJob` sampler. `defineEntity` and
`defineJob` are universal APIs; "is this table perf data?" is semantic, not
syntactic — and most tables (pages, tasks, mail) grow unbounded by design, so a
"report every unbounded table" monitor would be pure noise. The table hole is
closed structurally instead by the **firehose opt-in** model in
`research/2026-07-09-global-firehose-retention-enforcement.md` (a table declares
itself a firehose; a check fails if a declared firehose has no bound) — the
retention-side complement to these lint rules. `getGrowthBounds()` now merges file
sinks (`file:<id>`) alongside table bounds so that work can silence on both.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: sink-safety lint rules: no-adhoc-file-sink, no-adhoc-profiler-seam
- Exemptions:
  - Exempted by:
    - `debug/paging-probe` (0 debt)
    - `debug/profiling/runtime` (0 debt)
    - `debug/slow-ops` (0 debt)
    - `debug/stall-monitor` (0 debt)
    - `debug/stuck-spans` (0 debt)
    - `debug/trace/gates` (0 debt)
    - `debug/trace/spans` (0 debt)
    - `infra/file-sink` (0 debt)
    - `reports/engine` (0 debt)

<!-- AUTOGENERATED:END -->
