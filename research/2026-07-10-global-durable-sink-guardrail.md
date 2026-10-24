# Durable-sink guardrail: making a new perf sink impossible to hand-roll

**Date:** 2026-07-10 · **Category:** global (framework/tooling, debug, primitives)

## Context

`research/2026-07-08-global-unified-slow-event-tracing.md` collapsed seven fragmented
perf artifacts into two sanctioned paths:

- **evidence** → `captureTrace()` / `defineTraceEventClass()` (`@plugins/debug/plugins/trace/plugins/engine/server`)
- **alert** → `recordReport()` / `ReportKind` (`@plugins/reports/server`)

It deleted `flight-recorder.jsonl` and re-homed `stall-profiles.jsonl` — two durable
JSONL files that nothing ever read — and cut `onSlowSpan` from two subscribers to one.

**But it did all of that by convention.** Nothing structurally stops the next agent from
re-creating the exact same fragmentation: declare a persisted log channel, add a second
`onSlowSpan` subscriber, append lines to a file. That is how flight-recorder, the stall
profiler, and `slow-op-markers.jsonl` each accumulated in the first place — one reasonable
local decision at a time.

The three mechanisms are **lexically precise APIs**, so this is guardable with
allowlist-style ESLint rules — the `no-direct-parcel-watcher` shape — with no semantic
heuristics.

### Which mechanism actually caused the fragmentation (git-verified)

This matters, because it determines which rule is load-bearing. Both dead-end files were
written through **persisted log channels**, not raw filesystem appends:

```
$ git show b5fd5afdf^:plugins/debug/plugins/flight-recorder/server/internal/persist.ts
const channel = Log.channel("flight-recorder", { persist: true });
…
export function persistSnapshot(snapshot: object): void {
  rotateIfNeeded();
  channel.publish(JSON.stringify(snapshot));
}

$ git show b5fd5afdf^:plugins/debug/plugins/health-monitor/server/internal/stall-profiler.ts
channel = Log.channel("stall-profiles", { persist: true });
```

So `Log.channel(id, { persist: true })` is the **primary** vector (2 of the 3 historical
offenders, plus the surviving `slow-op-markers.jsonl`), not a secondary one.

There is also a sharp tell that separates a *log* from a *store*. Of the 14 persisted
channels alive today, exactly three publish a serialized record rather than a human line:

```
$ rg -U --multiline-dotall -c 'publish\(\s*JSON\.stringify' plugins/ -g '*.ts'
plugins/debug/plugins/health-monitor/server/internal/host-sampler.ts:1     # health-host.jsonl
plugins/debug/plugins/health-monitor/server/internal/process-sampler.ts:1  # health.jsonl
plugins/debug/plugins/slow-ops/server/internal/record-slow-op.ts:1         # slow-op-markers.jsonl
```

Those three are precisely the known perf sinks, and both deleted offenders had the same
shape. The other eleven (`db`, `migrations`, `change-feed`, `derived-views`,
`live-state-snapshot`, `release`, `notifications`, `worktree-cleanup`, …) publish text.

This is *evidence that the guard aims correctly*, not a rule: `channel.publish(JSON.stringify(x))`
is one `const line = JSON.stringify(x)` away from being evaded. The rule therefore fires on
the **declaration** (`persist: true`), which cannot be restructured away, and the
`JSON.stringify` split is what justifies the allowlist entries below.

## Goal

After this change, the only ways to make bytes durable in this repo are:

| Door | Reviewed? |
|---|---|
| `captureTrace()` — perf evidence | no — this is the intended path |
| `recordReport()` — perf alert | no — this is the intended path |
| `Log.channel(id, { persist: true })` / `Log.emit()` — operational log | **yes** — allowlist edit |
| append-mode filesystem write | **yes** — allowlist edit |
| a raw `onSlowSpan` / flight-window subscription | **yes** — owner-only |

## Non-goals (stated honestly)

No ESLint rule can catch a new **perf table**: `defineEntity("gc_pauses", …)` plus a
`defineJob` that INSERTs samples on a tick. `defineEntity` and `defineJob` are universal
APIs, and "is this table perf data?" is semantic, not syntactic. A field-name heuristic
(`durationMs`, `sampledAt`) would be unsound. Today's `slow_ops` and `boot_traces` are
exactly this shape, and both were deliberate.

The right complement is a **check**, not a lint rule, and it is out of scope here — see
*Adjacent findings*.

---

## Design

One new lint plugin: `plugins/framework/plugins/tooling/plugins/lint/plugins/sink-safety/`,
holding three rules. It goes in `framework/tooling/lint/plugins/` rather than under
`log-channels/` or `runtime-profiler/` because the invariant is cross-cutting — its
legitimate writers span `log-channels`, `reports`, `debug/profiling`, and `bin/` — and
because rule files cannot import `@plugins/*` (jiti does not resolve the alias), so
co-locating with a "primitive owner" buys no coupling at all, only a split CLAUDE.md.
This mirrors `watcher-safety` (guards `infra/file-watcher`) and `git-grep-safety`
(guards `checks/grep-code`). Multi-rule lint plugins are already normal
(`marker-scan-safety`, `promise-safety`).

All three rules are **purely syntactic** — import sources, identifiers, member
expressions — so they need no type information and run cheaply under both the IDE's
`projectService` parser and the `type-check` worker's pre-built program.

### Rule 1 — `no-adhoc-persisted-channel`

**Bans:** `Log.channel(<id>, { persist: true })` and `Log.emit(...)`, outside an
`ignores` allowlist.

**Why `Log.emit` too:** it is documented as the *client-ingress* path and persists
unconditionally (`log-channels/server/internal/log.ts:12` —
`getOrCreateChannel(channelId, { persist: true })`). Nothing stops server code from
calling it, which would sidestep a `persist:`-only rule entirely. Four server call sites
exist today, all in `apps/mail/plugins/sync/`.

**AST.** Anchor on the callee, never on a bare `{ persist: true }` property — two test
files (`stats/plugins/cost/…/usage-index.test.ts`,
`infra/plugins/corpus-index/…/corpus-index.test.ts`) carry unrelated `persist` options and
would false-positive.

- `CallExpression` whose callee is `MemberExpression` `Log`.`emit` → report.
- `CallExpression` whose callee is `MemberExpression` `Log`.`channel` **and** whose second
  argument is an `ObjectExpression` bearing a property named `persist` (Identifier or
  string-Literal key) with value `Literal true` → report on that property.
  `persist` is a literal `true` at every call site in the repo; a computed value is
  reported too (conservatively) since it cannot be proven false.
- Non-persisted `Log.channel(id)` (6 sites) is never touched.

**Message** carries the decision procedure — this is the rule's real payload:

> A persisted log channel writes durable JSONL to disk. If this is perf **evidence**, use
> `captureTrace()` / `defineTraceEventClass()` (a `ring: { max }` class gives a continuous
> sampler a Gantt lane for free). If it is a perf **alert**, use `recordReport()` with a
> `ReportKind`. If it is genuinely a human-readable operational log, add this file to
> `sink-safety`'s `no-adhoc-persisted-channel` allowlist with a one-line reason. Publishing
> `JSON.stringify(record)` into a channel means you are building a store, not a log —
> that is the shape that produced `flight-recorder.jsonl` and `stall-profiles.jsonl`.

**Allowlist** (`ignores`, one comment per entry). Eleven text-line operational logs:

```
plugins/database/server/internal/client.ts                                  # "db"
plugins/database/plugins/migrations/server/internal/runner.ts               # "migrations"
plugins/database/plugins/change-feed/server/internal/triggers.ts            # "change-feed"
plugins/database/plugins/change-feed/server/internal/listener.ts            # "change-feed"
plugins/database/plugins/derived-tables/server/internal/rebuild.ts          # "derived-tables"
plugins/database/plugins/derived-views/server/internal/rebuild.ts           # "derived-views"
plugins/database/plugins/live-state-snapshot/server/internal/boot-init.ts   # "live-state-snapshot"
plugins/database/plugins/live-state-snapshot/server/internal/catch-up.ts    # "live-state-snapshot"
plugins/release/server/internal/release-log.ts                              # "release"
plugins/shell/plugins/notifications/server/internal/reconcile-read-set.ts   # "notifications"
plugins/debug/plugins/worktree-cleanup/server/internal/reap-job.ts          # "worktree-cleanup"
plugins/apps/plugins/mail/plugins/sync/server/internal/*.ts                 # Log.emit, sync progress
```

…plus the three **known perf sinks the research doc kept deliberately**, each annotated as
tolerated debt rather than blessed design:

```
plugins/debug/plugins/health-monitor/server/internal/process-sampler.ts  # health.jsonl — read from disk when a backend is wedged
plugins/debug/plugins/health-monitor/server/internal/host-sampler.ts     # health-host.jsonl — same
plugins/debug/plugins/slow-ops/server/internal/record-slow-op.ts         # slow-op-markers.jsonl — uncapped granularity the rate-limited traces cannot give
```

That annotation is the point: the tolerated set becomes *visible and finite* instead of
being indistinguishable from the ordinary.

### Rule 2 — `no-adhoc-file-sink`

**Bans:** append-mode filesystem writers. Whole-file `writeFileSync` / `Bun.write` are
used everywhere (codegen, config, build artifacts) and are **not** touched — append-mode
is the line, because "accumulating records" is the sink shape.

Banned names `B = { appendFile, appendFileSync, createWriteStream }` from
`M = { fs, node:fs, fs/promises, node:fs/promises }`.

**AST.** Anchor on the *import binding*, as `no-direct-parcel-watcher` does — never a bare
member name, or `myLogger.appendFile()` false-positives.

- `ImportDeclaration` with `source ∈ M`, `importKind !== "type"`:
  - `ImportSpecifier` with `imported.name ∈ B` → report on the specifier. Reporting at the
    import means aliasing (`appendFileSync as af`) is covered for free.
  - `ImportNamespaceSpecifier` / `ImportDefaultSpecifier` → record local name in a per-file
    set; report later on member access.
- `ExportNamedDeclaration` with `source ∈ M` and a specifier in `B` → report (closes
  re-export laundering). `export * from "fs"` is out of scope.
- `MemberExpression` on a tracked local where `property.name ∈ B`, or computed with a
  string literal in `B` → report. Covers `fs.appendFileSync()` and `fs["appendFileSync"]()`.
- `CallExpression` `Bun.file(x).writer()` → report (a global; no import to anchor).
- `CallExpression` to `writeFile` / `writeFileSync` / `Bun.write` whose options object has
  `flag` / `flags` matching `/^a/` → report. Zero hits today; this is the one way to
  smuggle an append through the sanctioned whole-file API, and it costs ~15 lines.

**Deliberately not covered:** `const { appendFileSync } = require("fs")` and
`await import("fs")`. This matches the repo's existing convention — `no-adhoc-import-scan`
rules dynamic import/require out of scope for the same rarity reason. A wrapper module that
re-exports a renamed helper still has its *own* flagged `appendFileSync` import at the
definition site, so the primitive cannot be laundered without one file failing lint.

**Not covered, on purpose:** `openSync(path, "a")`. Its single repo use
(`infra/plugins/worktree/server/internal/worktree-op.ts:276`) is a **lock file**, not a
sink. Flagging it manufactures a guaranteed false positive against a non-sink.

**Chokepoint** (in-rule path constant, like `FILE_WATCHER_DIR`):
`plugins/primitives/plugins/log-channels/server/internal/persist.ts` — the one sanctioned
`appendFileSync`.

**Allowlist** (`ignores`):

```
plugins/reports/server/internal/buffer.ts    # pre-boot crash buffer; no server, no channel
**/bin/**/*.{ts,tsx}                          # CLI writers (build-log-writer-global, push-profiler); no backend running
plugins/debug/plugins/profiling/plugins/push/server/internal/read-contention.ts   # orphan-finalize stamp into the CLI-owned file
plugins/debug/plugins/profiling/plugins/push/server/internal/read-build-log.ts    # same
```

### Rule 3 — `no-adhoc-profiler-seam`

**Bans:** importing `onSlowSpan`, `captureFlightWindow`, or `readGateGauges` from
`@plugins/infra/plugins/runtime-profiler/core` outside their owners.

Named "seam", not "subscriber": two of the three are synchronous *pull* reads, not
subscriptions.

The module also exports `getRuntimeProfile` (the sanctioned pull API `op-rate` polls) and
`registerGateGauge` (the *producer* side, ~5 legitimate callers). So the rule must ban
**named specifiers**, never the module.

**AST.**
- Owner short-circuit on filename (in-rule constants):
  `plugins/debug/plugins/slow-ops/`, `plugins/debug/plugins/trace/plugins/spans/`,
  `plugins/debug/plugins/trace/plugins/gates/`.
- `ImportDeclaration` with `source === "@plugins/infra/plugins/runtime-profiler/core"`,
  `importKind !== "type"`, any `ImportSpecifier` in the banned set → report on the specifier.
  Sibling `getRuntimeProfile` / `registerGateGauge` specifiers on the same statement are ignored.
- `ImportNamespaceSpecifier` of that source → track local, report banned member access.

The profiler's own internals import these by relative path (`./recorder`), so they never
match the guarded source and need no allowlist. Only cross-plugin seam imports are caught.
No `ignores` needed.

**Message:** a second `onSlowSpan` subscriber is how `flight-recorder`'s near-identical
twin installer came to exist. To add a perf signal to every trace, contribute a
`defineTraceEventClass` — the engine calls your `captureAtTrip` at the same coherent
instant, and it lands in the Gantt automatically.

---

## Files

**New** — `plugins/framework/plugins/tooling/plugins/lint/plugins/sink-safety/`:

- `package.json` — mirror `watcher-safety/package.json`
- `CLAUDE.md` — prose (the three vectors, the git evidence, the allowlist rationale) + autogen block
- `lint/index.ts` — `export default { name: "sink-safety", rules: {…}, ignores: {…} }`
- `lint/no-adhoc-persisted-channel.ts` + `.test.ts`
- `lint/no-adhoc-file-sink.ts` + `.test.ts`
- `lint/no-adhoc-profiler-seam.ts` + `.test.ts`

**Regenerated by `./equin build`** (never hand-edited):
`plugins/framework/plugins/tooling/plugins/lint/core/lint.generated.ts`, `docs/plugins-*.md`.

**Reused, not rebuilt:**
`plugins/framework/plugins/tooling/plugins/lint/plugins/watcher-safety/lint/no-direct-parcel-watcher.ts`
(import-anchored rule + in-rule owner constant template),
`plugins/framework/plugins/tooling/plugins/lint/plugins/git-grep-safety/lint/no-adhoc-git-grep.test.ts`
(`RuleTester` + `@typescript-eslint/parser` harness),
`plugins/primitives/plugins/log-channels/lint/index.ts` (the `{ name, rules, ignores }` shape),
`plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts` (how `ignores` is consumed).

No new dependency — `eslint`, `@typescript-eslint/utils`, `@typescript-eslint/parser` are
already used by sibling lint plugins.

## Verification

1. `bun test plugins/framework/plugins/tooling/plugins/lint/plugins/sink-safety` — each rule
   has `RuleTester` valid/invalid cases covering, at minimum: alias imports, namespace +
   member access, computed member, re-export, the `{flag:"a"}` smuggle, `Log.channel(id)`
   without options (valid), the two unrelated `{ persist: true }` test-file shapes (valid),
   and a `getRuntimeProfile` / `registerGateGauge` import (valid).
2. `./equin build` — regenerates `lint.generated.ts` and the plugin docs.
3. `./equin check` — the decisive step. `type-check` runs ESLint repo-wide at `error`,
   so **a green run proves the allowlists are complete and no pre-existing code violates the
   three rules.** `plugins-registry-in-sync`, `plugins-have-claudemd`, and
   `plugins-doc-in-sync` also react to the new plugin.
4. Negative check — confirm the guard actually bites. In a scratch file, write
   `Log.channel("x", { persist: true })`, `import { appendFileSync } from "node:fs"`, and
   `import { onSlowSpan } from "@plugins/infra/plugins/runtime-profiler/core"`; run
   `bunx eslint <file>` and expect three errors. Delete the file.

## Adjacent findings (out of scope — to be filed as tasks)

Surfaced while mapping the durable sinks; none are fixed by a lexical guard:

- **`slow_ops` has no TTL and no registered growth bound.** Its only implicit bound is
  dedup-key cardinality. `plugins/infra/plugins/retention/` exists precisely for this.
- **`boot_traces` hand-rolls its 30-day TTL** (`boot-profile/server/internal/cleanup-job.ts`:
  own `defineJob` + raw `db.delete`), bypassing `defineRetention` — so it never registers a
  growth bound and is invisible to `getGrowthBounds()`.
- **`push-contention.jsonl` and `build-log.jsonl` have no bound of any kind** — neither
  size-rotated nor TTL-swept — and grow forever under both the CLI writer and the
  server-side orphan-finalize appends.
- **The structural complement to this plan is a check, not a lint rule:**
  *every `defineEntity` table must resolve to a growth bound* — a `defineRetention` TTL, an
  FK-cascade `markCascadeBounded`, or an explicit `unbounded("<reason>")` waiver. That needs
  cross-file registry data ESLint cannot see, and it closes the perf-table hole the three
  rules above structurally cannot. Relates to
  `research/2026-07-09-global-firehose-retention-enforcement.md`.
- **`Log.emit()` is a footgun**: exported, callable from server code, and silently persists.
  Rule 1 fences it, but the real fix is to make the client-ingress path unreachable from
  server plugins (or to rename it so the persistence is legible).
