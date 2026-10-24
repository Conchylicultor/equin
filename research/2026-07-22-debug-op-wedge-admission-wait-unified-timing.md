# Op-wedge watchdog: measure wedge-time from the unified op-log, not the coarse marker

## Context

The op-wedge watchdog (`debug/op-wedge-watchdog`) files a `cli-op-wedge` report **and reaps
the process** for any `./equin {build,check,push}` whose op marker is `phase: "running"`
and older than the budget (default 15 min). It measures "wedge time" as `now − startedAt` off
the **ephemeral op marker** (`infra/worktree`, `worktree-op.ts`).

That marker's `phase` flips to `"running"` at **build-lock grant** and then **never changes
again** — even while the build subsequently sits, for unbounded time, in the **duress-valve /
host-CPU-grant admission wait** (`cli/bin/commands/build.ts` `acquireAndRunHeavySection` →
`admission-valve.ts` + `withHostGrant`). Under fleet load this admission wait alone exceeds the
15-minute budget, so a **perfectly healthy build merely queued for a host CPU grant is reported
as wedged and reaped.**

Observed 2026-07-22: a build sat 15+ min in "wait for host CPU grant" (marker `phase: running`,
~0 CPU) and was minutes from a false reap. The 2026-07-21 "cpu idle, N live children"
`cli-op-wedge` reports for builds are almost certainly this same false-positive shape. The sweep
*already* excludes `waiting-for-lock` pushes as victims-not-wedges (`read-fleet.ts:38`);
admission-wait is the **same category** but is invisible to the marker's coarse two-state phase.

### Why the two systems disagree (the user's question: "are both using the same unified system?")

**No — they are two separate on-disk recordings that share only vocabulary.**

- **Op marker** (`worktree-op.ts`): one file per `(worktree, op)`, overwritten, coarse phase
  `waiting-for-lock → running`. Read by the watchdog. It has **no concept** of the duress-valve
  or host-grant waits that happen *after* the phase freezes at `running`.
- **Op-log** (`debug/profiling/op-log`, `~/.singularity/op-log.jsonl`): the **one durable
  record** for every host-contending op, carrying a `waits: OpWait[]` list with kinds
  `build-lock | push-mutex | duress-valve | host-grant`, folded to a read-model `OpRecord`
  (derived `waitMs = sum(waits)`, `outcome: "waiting" | "running" | terminal`) by
  `readOpRecords()`. It was **built specifically** to kill "a build parked in host-grant
  rendering as a motionless running bar" (its own `CLAUDE.md`). The watchdog just never
  consults it.

### The fix, at the right altitude

The marker and the op-log are **not redundant** — they own different things, and neither can be
deleted:

| | Op marker (ephemeral) | Op-log (durable) |
|---|---|---|
| **pid** to sample/reap | ✅ owns it | ❌ not carried |
| `--inspect` URL for the JS probe | ✅ owns it | ❌ not carried |
| liveness (`isPidAlive`, flock-derived push phase) | ✅ | ❌ (keys on opSlug) |
| **wait / timing accounting** | ✅ *lossy & wrong* | ✅ **authoritative** |

The watchdog needs the marker for the **pid + inspect URL** (it cannot sample or reap a process
without them) — that is the marker's correct role: *live-process identity*. The only thing
currently duplicated **and wrong** is the timing source. So we **unify the timing source**: the
op-log becomes the sole authority for "how long has this op genuinely been working," and the
marker stops being a timing source. This is a **single uniform formula, not a legacy branch**:

```
anchor      = record?.requestedAt ?? marker.startedAt   // op-log clock if present
blockedMs   = record?.waitMs ?? 0                       // ALL recorded host-resource waits
genuineWork = nowMs − Date.parse(anchor) − blockedMs
trip iff  phase === "running"  &&  genuineWork ≥ budgetMs
```

`waitMs` already includes the currently-open wait, clocked to the fold's `now` (`op-log`
`foldOpRecords`), so a build **parked** in host-grant has `genuineWork ≈ 0` and cannot trip.
A build that queued 14 min then genuinely ran 2 min has `genuineWork ≈ 2 min` and cannot trip.
A build **actually burning CPU** for 16 min with no waits has `genuineWork ≈ 16 min` and trips —
exactly as intended. Subtracting **all** wait kinds (not just admission) also strengthens the
existing culprit-vs-victim split: a push holding the mutex has near-zero `waitMs` (culprit,
trips), while pushes queued behind it are pure `push-mutex` wait (victims, don't trip) — the
same conclusion the flock-derived phase reaches, now backed by timing too.

**No legacy fallback, no missed wedges.** When no op-log record correlates (a pre-op-log CLI, or
a *parked* op whose `requested` head was clipped by the op-log's 8 MB bounded tail read),
`blockedMs = 0` falls out of the same formula and the marker supplies the anchor it already
carries — so we degrade to `now − startedAt` and **still catch** the wedge. The only residual is
a rare false-positive if a parked op's head is clipped — the identical blind spot every op-log
reader already has, and strictly better than today where every admission-queued build
false-trips.

## Changes

### 1. `read-fleet.ts` — subtract recorded wait time (the core fix)

`plugins/debug/plugins/op-wedge-watchdog/server/internal/read-fleet.ts`

- Import `readOpRecords` from `@plugins/debug/plugins/profiling/plugins/op-log/server` and the
  `OpRecord` type from `.../op-log/core`. (Legal barrel imports; no cycle — op-log imports
  nothing from op-wedge-watchdog.)
- Read `readOpRecords()` **once** per sweep (bounded 8 MB tail; cheap; main-only per-minute).
- Build a lookup of **in-flight** records (`outcome === "running" || outcome === "waiting"`)
  keyed by `(opSlug, kind)`, keeping the latest `requestedAt` if two collide.
- Change `WedgedOp` to also carry the accounting used for the report (see change 3):
  add `blockedMs: number` and `genuineWorkMs: number`.
- Replace the trip test:
  ```ts
  const rec = inflightByKey.get(`${info.slug}:${info.op}`);
  const anchorMs = Date.parse(rec?.requestedAt ?? info.startedAt);
  if (Number.isNaN(anchorMs)) continue;
  const blockedMs = rec?.waitMs ?? 0;
  const genuineWorkMs = nowMs - anchorMs - blockedMs;
  if (genuineWorkMs < budgetMs) continue;
  wedged.push({ info, wedgedMs: nowMs - Date.parse(info.startedAt), blockedMs, genuineWorkMs });
  ```
  Keep `wedgedMs` = raw `now − startedAt` (wall age, still shown in the report), and add the
  new `genuineWorkMs`/`blockedMs` as the **decision** quantities.
- Keep the existing `if (info.phase !== "running") continue;` first gate — it is the cheap
  early-out and the load-bearing **flock-derived push-victim** guard; with the op-log subtraction
  it becomes belt-and-suspenders, not the sole guard. Rewrite the header comment block: the
  op-log is now the wedge-time authority; document why the marker stays (pid/inspect/liveness)
  and why `blockedMs = 0` on a missing record is the correct uniform fallback (not a legacy
  branch), erring toward still-catching.

### 2. `monitor-job.ts` — thread the new accounting through

`plugins/debug/plugins/op-wedge-watchdog/server/internal/monitor-job.ts`

- Destructure `genuineWorkMs` and `blockedMs` from `readWedgedOps`.
- Add them to the `OpWedgePayload` (`data`, ~line 119).
- Extend the one-line report `message`/`detail` to make the accounting legible, e.g.
  `wedged 960s (work 60s, blocked 900s host-grant)` — surface `genuineWorkMs` and `blockedMs`
  so a reader immediately sees why it tripped. (User asked to surface the breakdown.)

### 3. `core/kinds.ts` — extend the payload schema

`plugins/debug/plugins/op-wedge-watchdog/core/kinds.ts`

- Add two optional fields to `OpWedgePayloadSchema` (optional so pre-existing rows still parse):
  ```ts
  // Genuine non-blocked work time (nowMs − anchor − blockedMs) — the quantity the
  // trip decision now uses. `wedgedMs` stays the raw wall age for context.
  genuineWorkMs: z.number().optional(),
  // Total recorded host-resource wait (build-lock/push-mutex/duress-valve/host-grant)
  // subtracted from wall age, from the unified op-log. 0 when no op-log record correlated.
  blockedMs: z.number().optional(),
  ```
- Update the `wedgedMs` comment to note it is now the raw wall age, not the trip quantity.

### 4. `web/components/op-wedge-summary.tsx` — show the breakdown

`plugins/debug/plugins/op-wedge-watchdog/web/components/op-wedge-summary.tsx`

- Render `genuineWorkMs` / `blockedMs` when present (e.g. a `work 60s · blocked 900s` chip),
  so the Debug → Reports one-liner reflects the new accounting. Fall back gracefully when the
  fields are absent (older rows).

### 5. Tests

- New `server/internal/read-fleet.test.ts`: with a stubbed op-log record showing a large
  `host-grant`/`duress-valve` wait, an over-wall-budget-but-under-work-budget running op does
  **not** trip; a genuinely-working over-budget op **does**; a missing op-log record degrades to
  `now − startedAt`. (Mirror the discipline in the existing `capture.test.ts` / `reap.test.ts`.)
  If `readOpRecords` / `resolveActiveWorktreeOps` are awkward to stub directly, factor the pure
  decision into a small helper (`classifyOp(marker, record, now, budget)`) and unit-test that —
  keeping the fs-touching sweep a thin wrapper.
- Run `bun test plugins/debug/plugins/op-wedge-watchdog`.

### 6. Docs

- Update the plugin `CLAUDE.md` "Detection" section: wedge-time is now genuine non-blocked work
  time from the **unified op-log**, not `now − startedAt`; the marker supplies process identity
  (pid/inspect/liveness) only. State the `blockedMs = 0` uniform fallback and why it does not
  miss wedges. `./equin build` regenerates the autogen reference block.

## Out of scope (deliberately)

- **No marker format / CLI change.** We do *not* add an `admission-wait` phase to the marker or
  touch `build.ts`/`check.ts`/`push.ts`. That would duplicate the op-log's `waits[]` into the
  ephemeral marker, still not fix the *past*-wait double-count, and violate op-log's "one durable
  record" invariant. Routing the watchdog through the existing op-log is the aligned, minimal fix.

## Verification (end-to-end)

1. `./equin build` (regenerates docs/registry, restarts server, runs checks).
2. `bun test plugins/debug/plugins/op-wedge-watchdog` — new + existing suites pass.
3. Reproduce the false positive is gone without waiting 15 min: temporarily set the config
   `budgetMs` low (Settings → Config → `op-wedge-watchdog`) on a box under load, or drive it via
   a unit fixture — confirm a build **parked in host-grant** (high `waitMs`, ~0 genuine work) is
   **not** filed/reaped, while a synthetic op with high genuine work still trips.
4. Inspect a filed row (Debug → Reports, or `query_db` on the reports table) — confirm the
   payload carries `genuineWorkMs`/`blockedMs` and the one-liner shows the `work/blocked`
   breakdown.

## Critical files

- `plugins/debug/plugins/op-wedge-watchdog/server/internal/read-fleet.ts` — the fix
- `plugins/debug/plugins/op-wedge-watchdog/server/internal/monitor-job.ts` — thread accounting
- `plugins/debug/plugins/op-wedge-watchdog/core/kinds.ts` — payload schema
- `plugins/debug/plugins/op-wedge-watchdog/web/components/op-wedge-summary.tsx` — surface breakdown
- `plugins/debug/plugins/op-wedge-watchdog/server/internal/read-fleet.test.ts` — new test
- `plugins/debug/plugins/op-wedge-watchdog/CLAUDE.md` — docs
- Reused (not modified): `readOpRecords` (`.../op-log/server`), `OpRecord`/`waitMs`
  (`.../op-log/core`), `resolveActiveWorktreeOps`/`WorktreeOpInfo` (`infra/worktree/server`)
