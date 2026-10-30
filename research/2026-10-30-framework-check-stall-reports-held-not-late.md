# Check-thread-stall reports: report time the thread was *held*, not time it was *late*

Task: task-1793316442-kq3p9a (under the slow-op notification audit, task-1793313534-w54p8d).

## Context

The check runner's thread watch (`checks/core/thread-watch.ts`) calls a 50 ms tick that fires ≥ 1 s late a **stall**.
`checks/core/stall-report.ts` files a `check-thread-stall` report for every stall of ≥ 2 s (one row per top owner)
and for every run whose stalls add up to ≥ 20 s (the `total` row). The flood: ~3000 occurrences in 2 days
(investigate 976, cli/release 573, change-feed 467, total 254).

A late tick has two causes, and the watch does not tell them apart:

1. **Held**: code on the thread did not yield. It ran JS, or it sat in a synchronous syscall (`readFileSync`, `spawnSync`). This is the bug class the report exists for.
2. **Starved**: the thread was runnable, but the OS did not schedule it. A build's check pass runs darwinbg-demoted (`build/cli/run.ts` ~1253, background lane), so on a busy host it gets E-cores and little time. No code is at fault, and any code that happens to be on the stack is "blamed".

Audit evidence (2026-10-29, 31 runs, 478 stalls) says most reports are (2):

- process CPU ÷ `lateMs` has a median of ≈ 0.2, even for stalls classified `cpu`;
- 31 reports are `(no samples)`, with ~0.1 s CPU;
- the watcher itself (`tick @ thread-watch.ts`) is a top owner 57 times, at a ratio of 0.02;
- build passes stall 11.6×/run, standalone checks 2.5×/run, main builds 0.

The watch's only CPU signal is `process.cpuUsage()`. It is process-wide, so other threads (tsc workers) inflate it, and it is never used to decide anything. It is only printed.

The original motive, a check's wall-clock timeout firing against a healthy service, is already handled where it bit. `DIRECT_CONNECT_TIMEOUT_MS` is now 60 s (`database/migrations/check/internal/direct-db.ts`), and the CLAUDE.md rule says to size timeouts above the longest stall. Reports never addressed it. That is a non-goal here.

**Outcome:** a report means "code on this repo held the check thread for ≥ 2 s of its own time". Starvation is still measured and shown in the progress log, the transcript and the console, but it never files.

## Design

### 1. A main-thread CPU clock — new `packages/thread-cpu-clock` (core)

Same shape and FFI pattern as `packages/sleep-clock` (lazy `dlopen("libSystem.B.dylib")`, `clock_gettime_nsec_np`):

```ts
export type ThreadCpuReading = { supported: true; ms: number } | { supported: false };
export function readThreadCpu(): ThreadCpuReading; // CLOCK_THREAD_CPUTIME_ID (16) of the CALLING thread
```

- darwin: `clock_gettime_nsec_np(16)`. Linux: `clock_gettime(3, &timespec)` through libc.so.6. Elsewhere: `{ supported: false }`, never 0 (failure is a type).
- Read from the tick, so on the main thread. This is the per-thread clock that the `StallCpu` doc comment says Bun lacks; FFI gives it for ~1 µs.
- Its own package, not part of the checks code: health-monitor's own block detector has the same late-timer ambiguity and can adopt it later (follow-up task, not here).

### 2. The watch measures *held* time per stall (`thread-watch.ts`)

`stepWatch` takes one more pure input, the absolute thread-CPU reading, next to `cpuUsage`. It stays clock-free, and `WatchState` keeps `lastThreadCpuMs`. Each `ThreadStall` gains:

```ts
held: StallHeld;
type StallHeld =
  | { measured: true; threadCpuMs: number; blockedMs: number; heldMs: number; starvedMs: number }
  | { measured: false };   // no thread clock on this platform
```

- `threadCpuMs`: the main thread's CPU over the stall window. It is exact, and no worker inflates it.
- `blockedMs = round(lateMs × blocking-io samples / samples)` (0 with no samples). A synchronous syscall wait accrues no CPU, but it does hold the thread. The `blocking-io` leaf kind (`classifyLeaf`) already identifies it. Under darwinbg the disk is throttled too, and that wait is still the sync call's fault, so it counts as held.
- `heldMs = min(lateMs, threadCpuMs + blockedMs)` and `starvedMs = lateMs − heldMs`.
- `ThreadSummary` gains the run totals `heldMs` / `starvedMs` and `longestHeldMs`, beside `stalledMs`. The `kinds`/`cpu` fields stay as they are.
- `selfMs` (the watcher's own cost) is measured in thread-CPU ms instead of `performance.now()`. Today it counts the time the tick was preempted, which is the 4–20 s "self" figure. It falls back to wall time when unsupported, with a `selfClock: "thread-cpu" | "wall"` field so a reader knows which.

The detection threshold (`STALL_MS`, 1 s late) does not change. Lateness is still what a timer inside a check experiences, and `overlapMs` / per-check `stalledMs` keep measuring it.

### 3. Reports file on held time only (`stall-report.ts`, `reports/check-thread-stall/core`)

- `stall` trigger: file iff `held.measured && heldMs ≥ STALL_REPORT_MS` (2 s). The constant keeps its meaning as a target, but it is now compared against held time.
- `total` trigger: file iff Σ `heldMs` ≥ `TOTAL_REPORT_MS` (20 s).
- `held.measured === false` (no thread clock on this platform): keep today's lateMs rule, so no platform goes silent. Label the payload `measured: false` so its message says "late (unmeasured)".
- The `(no samples)` owner can no longer file. With no samples it has no blocked time, and its CPU was ~0.1 s. An owner-less held stall (real CPU, no samples) still files as `(no samples)`. That would be a sampler bug worth seeing.
- Payload schema: add `held` (the union above) to `CheckThreadStallSchema`, and `heldMs`/`starvedMs` to `CheckThreadTotalSchema`. Both are **optional on read** (older outbox entries and rows lack them), and the writer always sets them. The fingerprint is unchanged, so existing rows keep counting.
- Message: `check thread held 2.4 s (of a 9.1 s stall) — check plugin-boundaries (blocking-io)`. The total reads `check run held its thread 23 s over N stalls (61 s late) — mostly …`. The KindView derives it from the payload, so it needs no edit. `server/internal/render.ts` adds a "held vs starved" line next to the CPU line and drops the "near zero CPU means waiting" heuristic, which the new numbers state directly.

### 4. Console / progress log / `--status` / transcript

- `progress-log.ts` `stall` and `thread` records carry `held` / `heldMs` / `starvedMs`. Read back, a missing value is `null`, never 0, the same convention as `stalledMs`.
- `transcript.ts` adds per stall: `held 2.1 s (cpu 1.8 s, sync-io 0.3 s), starved 6.9 s`.
- Console: the `⚠ check thread stalled …` line splits it out (`… 41 s late, 3.2 s held`), so a starved build no longer looks like a code problem.

### What does not change, and why

- **The per-worktree re-report.** Once starvation is filtered out, a worktree that re-reports unchanged code is reporting a real held stall that main still has. The row's count becomes "runs it cost", which is the honest signal. The outbox staleness rule stays as it is.
- **Lane-gating the reports** (e.g. no reports from background builds) is rejected. Held time is lane-independent: a held stall in a background build is still a stall. Only the scheduler share differs, and step 2 measures it.
- **E-core inflation.** Background-lane CPU ms run ~2–3× slower than on P-cores, so a 2 s held stall in a build is ≈ 0.7–1 s of interactive work. That is accepted: it errs toward reporting. Revisit only if a held-only report proves noisy.

## Files

- New: `plugins/packages/plugins/thread-cpu-clock/{core/index.ts,core/internal/thread-cpu-clock.ts,core/internal/thread-cpu-clock.test.ts,package.json,CLAUDE.md}`
- `plugins/framework/plugins/tooling/plugins/checks/core/thread-watch.ts` (+ `thread-watch.test.ts`)
- `plugins/framework/plugins/tooling/plugins/checks/core/stall-report.ts` (+ `stall-report.test.ts`)
- `plugins/framework/plugins/tooling/plugins/checks/core/progress-log.ts`, `transcript.ts` (+ their tests), console line in the runner
- `plugins/reports/plugins/check-thread-stall/core/internal/kind.ts`, `server/internal/render.ts`, `CLAUDE.md`
- `plugins/framework/plugins/tooling/plugins/checks/CLAUDE.md`: the "check thread is shared" section. Add held vs starved, the new filing rule, and the note that `cpu` is process-wide while `held` is the thread's.

## Verification

1. `./equin test plugins/packages/plugins/thread-cpu-clock`: a 200 ms busy loop advances the reading ≥ 150 ms, and `await Bun.sleep(200)` advances it < 20 ms.
2. `./equin test plugins/framework/plugins/tooling/plugins/checks`, with `stepWatch` fed fake readings for these cases:
   - a 3 s late tick with 2.5 s thread CPU should be held, and filed;
   - a 9 s late tick with 0.3 s CPU and `cpu`-kind samples should be starved, and not filed;
   - a 4 s late tick with 0.1 s CPU and 80 % `blocking-io` samples should be held at 3.3 s, and filed;
   - an unmeasured stall should keep the lateMs rule;
   - the total should be filed on Σ held time only.
3. `./equin test plugins/reports/plugins/check-thread-stall`: a legacy payload without `held` should still parse and render.
4. Live: `./equin build` in this worktree, which runs a background-lane check pass. Then read `~/.equin/logs/check-progress/*.jsonl` for this run. Expect `stall` records with `starvedMs` ≫ `heldMs`, no outbox entry for starved stalls, and a held/starved split in the transcript and console line. Then run a standalone `./equin check` and compare it.
5. After merge, on main: `query_db` occurrences of `check-thread-stall` per day, before and after. The expectation is a drop of an order of magnitude, with the rows that remain owned by the known synchronous culprits (investigate re-index, change-feed TS parse, readFileSync loops).
