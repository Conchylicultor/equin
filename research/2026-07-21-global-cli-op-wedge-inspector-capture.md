# CLI op wedge — inspector-capture session: tooling proven, wedge not re-fired (negative capture)

Companion to
[`2026-07-21-global-cli-op-wedge-checks-death-spiral.md`](../../att-1784636081-nwcl/research/2026-07-21-global-cli-op-wedge-checks-death-spiral.md)
(lives in worktree `att-1784636081-nwcl`; its "checks arm" localization stands, its
paging/GC death-spiral mechanism was refuted by live measurement the same day).
This session's goal was the one gap every prior doc names: **a symbolicated JS
stack / CPU profile of a WEDGED (not completed) process.**

**Outcome: NOT captured.** The wedge did not re-fire in ~2.5 h of induced load
(details below) — but the session (a) proved out, end-to-end on the real
workload, the only tooling that *can* capture it, (b) established four
methodology facts that constrain how any future capture must work, and (c)
took fresh live-specimen readings that sharpen the mechanism picture. A fresh
field wedge burned on the box during the whole session (pid 90778 — see below),
underscoring that the bug is alive; it simply never landed in an inspectable
lane.

## The capture kit (validated, ready to reuse)

Preserved in `~/.singularity/wedge-repro/2026-07-21-inspector-session/`
(scripts + profiles + samples + run ledgers):

- `inspector-client.ts` — Bun/JSC Inspector protocol client (plain WebSocket,
  JSON-RPC). `profile <secs>` mode: `ScriptProfiler.startTracking
  {includeSamples:true}` → wait → `stopTracking`, payload arrives on the
  `ScriptProfiler.trackingComplete` event as `samples.stackTraces[]`, each trace
  leaf-first `stackFrames[{name,url,line}]` — **fully symbolicated**. Prints
  self/total rankings.
- `repro-loop.ts` — N concurrent `check --scope tree --no-cache` lanes under
  `--inspect=localhost:1660N/wedge` (grant-bypassed), auto-restart, wedge
  auto-flag (wall budget + sustained 30 s CPU delta), status ledger.
- `build-loop.ts` — same shape but a REAL `./equin build` (no grant
  bypass → real cpu-slot flock admission; in-process frontend arm;
  `SINGULARITY_CHECK_NO_CACHE=1`), parameterized per worktree.
- `capture-wedge.sh <pid> <ws>` — one-shot forensics: `ps`/`ps -M`, 5 s CPU
  delta, native `sample` + fingerprint grep, `check-progress.jsonl` tail, two
  10 s inspector profiles.

Verified mid-run on the real workload: a live `check --scope tree` at full burn
yielded **1838 samples with function names + file:line** (see "healthy profile"
below). This is the piece every earlier session lacked.

## Methodology facts (each verified this session, bun 1.3.13)

1. **There is no attach-after-launch.** `kill -USR1 <bun pid>` does not open an
   inspector — it **terminates the process** (default SIGUSR1 disposition;
   verified on a dummy). Never send it to a live specimen. Consequence: a field
   wedge (not launched with `--inspect`) is permanently uncapturable at the JS
   level; only a wedge born in an `--inspect` lane can be profiled.
2. **Inspector commands are dispatched on the JS thread.** Against a
   never-yielding `while(true)` hot loop, the WebSocket connects but every
   command (`Runtime.evaluate`, `ScriptProfiler.startTracking`,
   `Debugger.enable`) times out unanswered. Against a hot loop that yields to
   the event loop (200 ms slices + `setTimeout 0`), profiling works perfectly at
   98 % CPU.
3. **The real wedge IS the yielding kind — so it IS capturable.** Live specimen
   90778 emitted its 30 s progress-log heartbeats **punctually for hours** while
   burning ~1 core (and prior specimens showed heavy `kevent64` churn — the
   main thread passes through the event loop constantly). A future wedge in an
   `--inspect` lane will answer the profiler. This is the load-bearing reason
   the kit works at all.
4. **`Debugger.pause` is a dead end** (bun 1.3.13): `Debugger.enable` +
   `Debugger.pause` never deliver a `Debugger.paused` event even against
   yielding hot code. Sampling profiles are the only stack-capture mode.
   (`--cpu-prof` flushing only on clean exit was already established by the
   prior session; unchanged.)

Operational traps for whoever loops this next:

- **The check-result cache neuters naive looping.** It is host-global and
  content-keyed (`~/.singularity/check-cache/`): after one passing run of a
  given tree, every subsequent identical run completes in ~4 s doing no heavy
  work. My first 20 min of "looping" (runs 2–99) were cache-hit no-ops. Use
  `check --no-cache` / `SINGULARITY_CHECK_NO_CACHE=1`.
- A scratch worktree made with raw `git worktree add` has no DB fork; its build
  aborts at "Waiting for DB fork" until `./equin db fork` is run there.

## What was run (all times 2026-07-21 UTC)

| window | load shape | outcome |
|---|---|---|
| 14:46–15:12 | 3 × `check --scope tree` lanes, grant-bypassed, **cached** (my mistake) | run 1 healthy 275 s; runs 2–99 4 s no-ops — no pressure |
| 15:13–16:03 | 3 × `check --scope tree --no-cache` lanes, grant-bypassed | ~4 full cycles/lane, all healthy ~300 s, host load 18–32 |
| 16:03–17:05 | **3 × real `./equin build` in parallel** (this worktree + 2 scratch worktrees), real slot admission, no cache | ~10 completed builds, 660–991 s each, ALL exit 0; zero wedge flags |

The 3-parallel-builds arm was run because the user reported the field trigger
as "fires almost instantly as soon as 2–3 agents build in parallel", and
because the safe repro's `SINGULARITY_HOST_GRANT` bypass skips the cpu-slot
flock machinery — which every wedged field specimen is seen *holding*, and
whose flock-wait children depend on exactly the completion types (child exit)
the wedge starves. Removing the bypass removed that confound.

## Why it (probably) didn't fire

The wedge tracks **fleet pressure, not the op's own work**. During the morning
incident window the box ran load 18–32 with many agents active, and field
wedges fired repeatedly; by the time the faithful 3-build arm ran (16:00–17:05)
ambient agent traffic had drained and load fell to ~5–7 between my own builds.
Every one of ~10 builds that would have wedged under the morning's contention
completed. The negative result is therefore about the *pressure*, not the
command: the harness ran the exact field workload, inspectably. (A second
possibility — `--inspect` itself perturbing timing enough to suppress the bug —
cannot be excluded, but nothing supports it: the lanes' durations and profiles
matched uninstrumented runs.)

## Fresh live-specimen readings (pid 90778, all-day field wedge)

`check --scope tree` spawned by a push (worktree `att-1784630317-o0fi`), wedged
from ~14:05: **155+ CPU-minutes at 87–98 % CPU** and still burning at session
end. Readings consistent with, and sharpening, the established picture:

- Straggler = **`orphaned-db-tables`** pending for hours; all other checks
  ended. Its run() awaits, in order: `Bun.spawn(git rev-parse)` → `pool.connect()`
  → `pool.query` → `pool.end()` — child-exit and pg-socket completions, i.e.
  precisely the starved completion types. 30 s heartbeats punctual throughout.
- Main thread alone burns (ps -M: 26 min utime + 12 min stime running; all ~40
  other threads ~0) — heavy kernel component fits the kevent64-churn signature.
- **RSS 44 MB resident** while burning — conclusively NOT a resident-set/paging
  problem (matches the refutation of the death-spiral doc's mechanism).
- Native `sample` fingerprint chain matches the canonical one
  (`…→0x8ecf40→0x43a040→0x1a2cc0→0x28591a8→0x25e9648→0x31716b8`) — same bug.
  Capture: `wedge-90778.sample.txt` in the session artifact dir.

## Healthy-run profile (for contrast, and worth having regardless)

10 s mid-run sampling profile of a full-burn healthy `check --scope tree`
(1838 samples; `smoke-profile.json`):

- Self time: **`readFileSync` 83.1 %**, `maskSource` 6.9 % + its `blank` 1.0 %
  (`plugin-meta/plugins/parse-utils/core/mask-source.ts`), `join` 2.2 %,
  `stringSplitFast` 1.4 %.
- On-stack: `run` of the **plugin-boundaries** check 99.2 %
  (`…/checks/plugins/plugin-boundaries/check/index.ts:29`), inside it
  `safeRead` 78.3 % and the re-export-provenance walk
  (`collectForeignReexports`/`originFromSpec`/`resolveRelativeFile`,
  `reexport-provenance.ts`) ~17–20 %.

So the healthy pass's CPU is dominated by one check re-reading the corpus file
by file. That is a cost finding, not the wedge — the wedge's straggler holds no
files and no children; its burn is elsewhere (event-loop/kernel churn while a
continuation never arrives).

## State of the mechanism question

Unchanged from the morning's refutation, now with more confidence: the wedge is
a **live-lock of the main thread servicing the event loop** (timers fire
punctually, kevent churn, ~1 core, tiny resident set) **while some completion
types — child exit, socket — are never delivered**, leaving one straggler check
pending forever. Not GC, not paging, not a JS-visible infinite loop in check
code. The named-function answer still requires catching a wedge in an
`--inspect` lane; when that happens the profile will show whether the burn is
JS (frames will name it) or below JS (samples will pin the churn site).

## Recommendation for the next attempt

Run the capture kit **during a live incident window** (fleet busy, load ≥ ~2×
cores, ideally while a field wedge is already burning elsewhere), not on a
quiet evening: 2–3 `build-loop.ts` lanes across scratch worktrees (with their
DB forks pre-created) + optionally 2 no-cache check lanes for extra pressure.
Alternatively, make `--inspect` cheap to have always-on for CLI ops (bun only
pays when a client connects) — then the *next field wedge* is capturable the
minute the watchdog flags it, with no reproduction needed at all. That is the
structural fix for capturability and removes the pressure-timing lottery.

## Cleanup ledger

Repro processes all killed; scratch git worktrees `wedge-repro-{1,2}` +
branches + `~/.singularity/worktrees/wedge-repro-*` removed. **Leftover: the
two Postgres forks `wedge-repro-1` / `wedge-repro-2`** (no CLI drop path
exists; deliberately not hand-DROPped on the shared cluster) — reap via Debug →
Worktree Cleanup, which exists for exactly this.
