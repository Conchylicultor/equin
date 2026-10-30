# Boot monitor judges time-to-ready, not the warm-up drain

## Context

`boot server-boot took 11008ms (threshold 10000ms)` has 144 occurrences and is
still firing on main (2026-10-30), while main's `boot.jsonl` shows it serving
0.4–2.4 s after process start. `debug/boot-monitor` trips on the profiler's
`totalDurationMs` — the end of the LAST span — and it only judges once the
`settled` span exists, i.e. after `runSettledPhase` drained every warm-up. So
the report measures how long the background warm-ups took, not how long the
backend took to become ready. Warm-ups are already judged on their own
(slow-ops against declared budgets: task-1793316430-dqjpnh,
task-1793316427-xlxoqr), so the boot report double-counts them and never names
a real boot regression.

Outcome: the boot report trips on **time to ready** — process start →
`markServerReady()` (the `onReadyBlocking` barrier done; the flag
`/api/health/ready` reports and the gateway hot-swaps on).

## Design

1. **The profiler records the ready instant** (`server-core/core/profiler.ts`).
   `markServerReady()` (`core/readiness.ts`) is the one place readiness is
   declared, so it stamps the profiler (`recordReadyInstant()`), and
   `getProfilingData()` returns `timeToReadyMs: number | null` — ms from
   process start (`performance.timeOrigin`, the clock `boot.jsonl` and the
   gateway measure on), `null` until ready (and forever in `exec` / browser
   hosts, which never mark ready). Derived from the flag, not from the
   `onReadyBlocking` span's end, so the metric cannot drift from what the
   gateway waits on, and it includes module evaluation before the profiler's
   own clock starts.

2. **The monitor trips on it** (`boot-monitor/server/internal/monitor-job.ts`).
   - Completeness guard: judge once `timeToReadyMs !== null` (readiness is
     final the moment it is set) — no longer wait for `settled`, so a long or
     frozen drain neither delays nor inflates the verdict.
   - Trip metric, `durationMs` / `ownMs`: `timeToReadyMs`.
   - New fingerprint: operation `server-ready` (trace label too), so the
     drain-measuring `server-boot` row stops accruing instead of mixing two
     meanings under one count.
   - The section still carries the full span list recorded so far (evidence).

3. **Config** (`boot-monitor/core/config.ts`): `totalBootBudgetMs` →
   `readyBudgetMs` (default stays 10 000 ms; main is ~2 s). No user layer
   overrides the old key (only generated `.origin.jsonc` files exist).

4. **Section + lane** (`trace/boot/core/section.ts`, `web/components/boot-lane.tsx`):
   add optional `timeToReadyMs` (optional: traces persisted before it still
   parse); the lane shows a `ready <n>` badge beside `boot <n>`.

5. Docs: boot-monitor and trace/boot `CLAUDE.md` prose (trip metric, guard).

## Verification

- `./equin build`, then Debug → Boot Profile / `query_db` on `slow_ops`: no new
  `server-boot` rows from this worktree; a `server-ready` row only when the
  budget is lowered below the observed time-to-ready (temporarily set
  `readyBudgetMs` low in Settings → Config, wait a minute tick after a restart,
  check the row's `duration_ms` matches `readyAt − processStartedAt` in
  `boot.jsonl`, then restore).
- `./equin check`.
