# Durable sinks: declared, enumerable, bounded

**Date:** 2026-07-10 · **Category:** global (infra, primitives, debug, framework/tooling)
**Supersedes:** [`2026-07-10-global-durable-sink-guardrail.md`](./2026-07-10-global-durable-sink-guardrail.md)

## Context

`research/2026-07-08-global-unified-slow-event-tracing.md` collapsed seven fragmented perf
artifacts into two sanctioned paths — `captureTrace()` (evidence) and `recordReport()`
(alert) — but only by convention. Nothing stops the next agent from re-fragmenting.

**v1 proposed three allowlist lint rules. It was the wrong shape.** Auditing its own
allowlist killed it:

- Of the 14 `Log.channel(id, { persist: true })` declarations, **11 are ordinary text
  operational logs** (`db`, `migrations`, `change-feed`, `derived-views`,
  `live-state-snapshot`, `release`, `notifications`, `worktree-cleanup`) — the primitive's
  documented, intended use. A rule needing 11 exemptions to catch 3 offenders is a tax, not
  a guard; the next agent appends to the allowlist without reading it.
- The `**/bin/**` exemption would have **blessed two undiscovered offenders**:
  `build-log.jsonl` and `push-contention.jsonl`, both `appendFileSync(f, JSON.stringify(rec))`,
  both read back by the Debug → Profiling Gantt, both with **no size cap and no TTL**.

Root cause: v1 asked a **semantic** question — *"is this data perf-related?"* — of a
**lexical** tool. That question has no syntactic answer, so every such rule grows an
exception list.

### The question that does have an answer

> **Every durable sink is declared, enumerable, and growth-bounded.**

Not "no new perf sinks" (unenforceable, and sometimes a new sink is correct). This is
mechanical and checkable, and the repo **already implements it for DB tables**:
`plugins/infra/plugins/retention/` owns a `GrowthBound` registry that is *true by
construction* — `defineRetention` records the bound inside the returned factory's
`register()`, so a policy that is defined-but-never-mounted records nothing; and
`markCascadeBounded` verifies the FK really cascades or throws at boot.

That plugin's own CLAUDE.md names the missing piece:

> `getGrowthBounds()` … Its only consumer is the deferred undeclared-growth monitor (a
> separate follow-up task), which uses it as a *silencing* set.

So this plan does not invent a registry. It **extends the existing one from tables to
files**, replaces the `persist: true` boolean with a declaration that records its own
bound, and finally builds the monitor retention was written for.

### What that dissolves

The `persist: true` lint rule **disappears entirely** — the flag stops existing, so the
footgun cannot be written, so there is nothing to police and no allowlist. That is the
CLAUDE.md rule ("the right response to a footgun is to remove the footgun") applied
literally. The two surviving lint rules fence raw filesystem appends and the profiler seam,
and their allowlists shrink to **owners only** (the chokepoint plus one provable exception).

### Current state (verified)

| Sink | Bound today |
|---|---|
| 14 persisted log channels | 128 MB × 3 rotations, implicit in `persist.ts` — undeclared |
| `_reports`, `entity_versions` | `defineRetention` ✓ |
| `traces` | hand-rolled `debug.trace-cleanup` — `defineRetention` open-coded |
| `boot_traces` | hand-rolled `debug.boot-trace-cleanup` — `defineRetention` open-coded |
| `slow_ops` | **none** |
| `~/.singularity/build-log.jsonl` | **none** |
| `~/.singularity/push-contention.jsonl` | **none** |
| `~/.singularity/reports/<wt>.jsonl` | drain + `unlinkSync` on flush — self-bounding |

Three of the four "adjacent findings" parked at the bottom of v1 are fixed *by the same
change* — good evidence the invariant is the right one.

---

## Design

### 1. `plugins/infra/plugins/file-sink/` — new leaf plugin

The bounded-append primitive, extracted from `log-channels/server/internal/persist.ts`
(`rotateChannel` + `appendEntryToDir`, which already implement 128 MB × 3-rotation
size-gating with an in-memory byte counter). Node-only: `node:fs` + `node:path`, **no
`db`, no `jobs`** — so the CLI process can import it.

```ts
export interface FileSinkSpec { id: string; description: string; path: string;
                                maxBytes?: number; keep?: number }
export interface FileSink { id: string; path: string; bound: RotateBound;
                            append(line: string): void }
export function defineFileSink(spec: FileSinkSpec): FileSink;   // registers; dup id throws
export function getFileSinks(): ReadonlyMap<string, FileSink>;  // the true set
```

Bound is **true by construction**: `append()` *is* the rotation, so a registered sink is a
rotated sink. Also exports `openDynamicSink(dir, name)` for the one genuinely open-ended
family (browser-supplied `clientLog` channel ids), which shares the same rotation and is
declared once as a family.

### 2. `plugins/infra/plugins/retention/` — generalize the registry

`GrowthBound` gains a third constructor; keys gain a sink kind. Existing `ttl`/`cascade`
semantics and the mounted-⇒-recorded discipline are untouched.

```ts
export type GrowthBound =
  | { kind: "ttl"; ttlDays: number }
  | { kind: "cascade"; owner: string }
  | { kind: "rotate"; maxBytes: number; keep: number };   // NEW — files
```

`getGrowthBounds()` returns `Map<SinkKey, GrowthBound>` where `SinkKey` is
`` `table:${name}` `` or `` `file:${id}` ``, merging the DB bounds it already holds with
`getFileSinks()`. Edge direction: `retention → file-sink` (file-sink stays leaf; the CLI
imports only file-sink). `declareGrowthBound`'s declared-exactly-once throw is preserved.

### 3. `plugins/primitives/plugins/log-channels/` — kill the `persist` flag

```ts
// BEFORE                                        // AFTER
Log.channel("db", { persist: true })             defineLogSink({ id: "db", description: "…" })
Log.channel("build")                             Log.channel("build")        // ephemeral, unchanged
Log.emit(id, line)                               (route-internal; see below)
```

- `defineLogSink({ id, description })` → `LogChannel`, backed by a `defineFileSink` under
  the per-worktree logs dir. Registers the channel *and* its rotate bound in one act.
- The `persist?: boolean` option is **deleted** from `Log.channel`. `getOrCreateChannel`'s
  one-way `persist` upgrade goes with it.
- **`Log.emit` becomes internal** to the `/api/logs` ingress route. It is a genuine wart
  today: exported, callable from server code, and silently persists — a bypass of any
  `persist`-shaped rule. Its four server callers (`apps/mail/plugins/sync/…`) migrate to a
  real `defineLogSink({ id: "mail-sync" })`. Browser-supplied channel ids keep working via
  `openDynamicSink`, declared once as the `client-log` family bound.
- `persist.ts` keeps the read path (`readTail`, `readChannelEntries`, `listChannels`); its
  rotation/append half moves to `file-sink`.

**14 declaration sites migrate mechanically.** The three that are *actually* perf sinks
(`health.jsonl`, `health-host.jsonl`, `slow-op-markers.jsonl`) keep working, but now appear
in `getFileSinks()` as what they are — visible, not indistinguishable from `db.jsonl`.

### 4. Bound the two unbounded CLI files

`build-log.jsonl` and `push-contention.jsonl` are written by `framework/cli/bin/` (a
short-lived process with no server and no DB, so `captureTrace()` is genuinely unreachable)
and appended to by `debug/profiling/push/server/internal/read-{contention,build-log}.ts`,
which today **re-declare the path constants**.

Define both sinks once in `plugins/framework/plugins/cli/core/sinks.ts` via
`defineFileSink`. The CLI writer and the server reader/finalizer import the same object.
One definition, two consumers, path duplication gone, bound true by construction.

### 5. Retire the two open-coded TTL jobs; bound `slow_ops`

- `debug/plugins/trace/plugins/engine/server/internal/cleanup-job.ts` → `defineRetention({ table: _traces, ttlDays: 7, cron: "0 3 * * *", perWorktree: true })`. Delete the hand-rolled job.
- `debug/plugins/boot-profile/server/internal/cleanup-job.ts` → same, `ttlDays: 30`. Delete.
- `slow_ops` → `defineRetention({ table: _slowOps, column: "lastSeenAt", ttlDays: 30, perWorktree: true })`.
  (Confirm the timestamp column name against `slowOpFields` during implementation.)

Job ids change `debug.*-cleanup` → `retention.<table>`. No DDL migration — job rows are
re-registered on boot.

### 6. `sink-safety` lint plugin — two rules, owners only, no allowlist

`plugins/framework/plugins/tooling/plugins/lint/plugins/sink-safety/`. Both rules purely
syntactic (import sources, identifiers, member expressions) — no type info.

**`no-adhoc-file-sink`** — bans value-imports of `appendFile` / `appendFileSync` /
`createWriteStream` from `fs` / `node:fs` / `fs/promises` / `node:fs/promises`; namespace
and default-import member access (`fs.appendFileSync`, `fs["appendFileSync"]`); re-export
laundering (`export { appendFileSync } from "fs"`); `Bun.file(x).writer()`; and
`writeFile(Sync)` / `Bun.write` carrying `{ flag: /^a/ }` (the one way to smuggle an append
through the sanctioned whole-file API). Whole-file writes are **not** touched — they are
codegen, config, and build artifacts. Aliasing is covered for free by reporting at the
import specifier.

*Owners (in-rule path constants, the `FILE_WATCHER_DIR` shape):*
`plugins/infra/plugins/file-sink/` (the chokepoint) and
`plugins/reports/server/internal/buffer.ts` (crash buffer written inside
`uncaughtException` on a dying event loop, with drain-and-unlink queue semantics no channel
offers — structurally impossible to route elsewhere).

*Out of scope, per the repo's existing `no-adhoc-import-scan` convention:*
`require("fs")` and `await import("fs")`. A wrapper that re-exports a renamed helper still
has its own flagged import at the definition site.

*Deliberately not banned:* `openSync(path, "a")` — its single repo use
(`infra/plugins/worktree/server/internal/worktree-op.ts:276`) is a **lock file**, not a
sink. Flagging it manufactures a false positive against a non-sink.

**`no-adhoc-profiler-seam`** — bans importing `onSlowSpan`, `captureFlightWindow`, or
`readGateGauges` from `@plugins/infra/plugins/runtime-profiler/core`. Must ban **named
specifiers, not the module**: `getRuntimeProfile` (the sanctioned pull API `op-rate` polls)
and `registerGateGauge` (the producer side, ~5 legitimate callers) live in the same barrel.
Named "seam", not "subscriber" — two of the three are synchronous pull reads.

*Owners:* `plugins/debug/plugins/slow-ops/`, `.../trace/plugins/spans/`, `.../trace/plugins/gates/`.
The profiler's own internals import by relative path (`./recorder`) and never match the
guarded source, so they need no entry. A second `onSlowSpan` subscriber is precisely how
flight-recorder's near-identical twin installer came to exist.

Neither rule ships an `ignores` block.

### 7. Undeclared-growth monitor — the piece retention was written for

Closes the hole no lint rule can: a new `defineEntity` perf table with a `defineJob`
sampler. `defineEntity` is universal; "is this table perf data?" is semantic. But "does
this table have a bound?" is not.

A per-worktree scheduled job (`defineJob`, `dedup: "singleton"`, nightly, `maxAttempts: 3` —
the `queue-health` / `boot-budget` monitor shape) reads `pg_stat_user_tables` plus
`getFileSinks()`, and files a deduped **`undeclared-growth`** `ReportKind` for any table
past a row/byte floor, or any `.jsonl` under the logs dir, carrying **no** `GrowthBound`.
`getGrowthBounds()` is its silencing set — which is exactly why every entry must be earned.

Ships with a `Reports.KindView` one-liner and a `renderTask` naming the sink and the three
ways to bound it.

---

## Phases

Each lands independently, green on `./equin build` + `./equin check`.

1. **`infra/file-sink`** — extract rotation from `persist.ts`; `defineFileSink` +
   `getFileSinks()` + `openDynamicSink`; move `persist.ts`'s rotation tests across.
2. **`retention` generalization** — `rotate` bound, `SinkKey`, merge `getFileSinks()`.
3. **`defineLogSink`** — delete `persist` flag, internalize `Log.emit`, migrate 14 + 4 sites.
4. **CLI sinks** — `cli/core/sinks.ts`; CLI writers and push-profiling readers share it.
5. **Retention fixes** — `traces`, `boot_traces` onto `defineRetention`; `slow_ops` bounded.
6. **`sink-safety` lint plugin** — two rules + `RuleTester` tests. (Depends on 1 & 4: until
   the raw appends have an owner, the rules would fire on real code.)
7. **Undeclared-growth monitor** + KindView.
8. **Docs** — `CLAUDE.md` for `file-sink` + `sink-safety`; update `log-channels`,
   `retention`, `.claude/skills/debug/SKILL.md`.

Dependency order: 1 → 2 → 3 → (4, 5 parallel) → 6 → 7 → 8.

## Files

**New:** `plugins/infra/plugins/file-sink/{package.json,CLAUDE.md,core/,server/}`;
`plugins/framework/plugins/cli/core/sinks.ts`;
`plugins/framework/plugins/tooling/plugins/lint/plugins/sink-safety/{package.json,CLAUDE.md,lint/*}`;
the monitor under `plugins/debug/plugins/undeclared-growth/`.

**Modified:** `plugins/infra/plugins/retention/server/internal/growth-bounds.ts`;
`plugins/primitives/plugins/log-channels/server/{index.ts,internal/{log,registry,persist}.ts}`
\+ its 14 declaration sites and `apps/mail/plugins/sync/server/internal/{tick,backfill,attachment-scan}.ts`;
`plugins/framework/plugins/cli/bin/{build-log-writer-global,push-profiler}.ts`;
`plugins/debug/plugins/profiling/plugins/push/server/internal/read-{contention,build-log}.ts`;
`plugins/debug/plugins/slow-ops/server/internal/tables.ts` + barrel;
`plugins/debug/plugins/trace/plugins/engine/server/` and
`plugins/debug/plugins/boot-profile/server/` (delete both `cleanup-job.ts`).

**Regenerated by `./equin build`:** `lint.generated.ts`, `*.generated.ts` registries,
`docs/plugins-*.md`.

**Reused, not rebuilt:** `defineRetention` / `markCascadeBounded` / `declareGrowthBound`
(`infra/retention`); `rotateChannel` + `appendEntryToDir` (`log-channels/persist.ts` — moved,
not rewritten); `defineJob` (`infra/jobs`); `ReportKind` + `recordReport` (`reports`);
`no-direct-parcel-watcher` (rule template); `no-adhoc-git-grep.test.ts` (RuleTester harness).

## Verification

1. `bun test plugins/infra/plugins/file-sink plugins/infra/plugins/retention plugins/framework/plugins/tooling/plugins/lint/plugins/sink-safety`
   — rotation behavior (moved tests must pass unchanged), the declared-exactly-once throw,
   and per-rule `RuleTester` valid/invalid cases: alias import, namespace member, computed
   member, re-export, `{flag:"a"}` smuggle, and a *valid* `getRuntimeProfile` /
   `registerGateGauge` import.
2. `./equin build` — regenerates registries + docs; runs migrations.
3. `./equin check` — decisive. `type-check` runs ESLint repo-wide at `error`, so
   **green proves no code violates the two rules with owners-only exemptions.** Deleting the
   `persist` option means any missed migration site is a `tsc` error, not a silent pass.
4. `mcp__singularity__query_db` — confirm `retention.traces`, `retention.boot_traces`,
   `retention.slow_ops` jobs are scheduled and the two `debug.*-cleanup` jobs are gone.
5. Runtime — `tail ~/.singularity/worktrees/<wt>/logs/db.jsonl` still fills after a build
   (log channels unbroken); `./equin build` still appends to `build-log.jsonl` and the
   Debug → Profiling Gantt still renders it.
6. Monitor — temporarily lower the row floor, run the job from the Debug → Queue pane,
   expect zero `undeclared-growth` reports (every sink bounded by then). Add a throwaway
   unbounded table, re-run, expect exactly one report. Revert.
7. Negative check — in a scratch file write `import { appendFileSync } from "node:fs"` and
   `import { onSlowSpan } from "@plugins/infra/plugins/runtime-profiler/core"`; `bunx eslint`
   must report both. Delete the file.

## Risk

- **Phase 3 is the wide one** (18 call sites). It is mechanical, and `tsc` catches every
  miss because the option is deleted rather than deprecated.
- **`Log.emit` internalization** could break the browser `clientLog` ingress. Phase 3's
  verification step 5 exercises it explicitly.
- **Job-name change** in phase 5 orphans three graphile cron entries. They are re-registered
  on boot; the old rows are inert. Confirm via `query_db` rather than assuming.
