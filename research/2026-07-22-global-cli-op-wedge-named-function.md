# CLI op wedge — armed specimen captured: the loop is a native microtask storm drained by `processTicksAndRejections`

**Builds on** (mechanism model + methodology; both validated by this capture):
- [`2026-07-21-global-cli-op-wedge-live-specimen-verdict.md`](./2026-07-21-global-cli-op-wedge-live-specimen-verdict.md) — the pre-armed inspector remediation worked exactly as designed: the first field wedge after 12efa0e37 was fully profilable while burning.
- [`2026-07-21-global-cli-op-wedge-inspector-capture.md`](./2026-07-21-global-cli-op-wedge-inspector-capture.md) — capture kit + methodology facts, all reconfirmed.

**Status: the hot JS function is NAMED and its hot call site is pinned to a
bytecode offset.** The burn is bun's builtin `processTicksAndRejections`
(FTL-compiled) spending ~all JS-thread time in its **`drainMicrotasks()` call
(bc#365)** — i.e. the JSC microtask queue is refilled with **native** jobs on
every drain, forever. The *producer* of those native microtask jobs is the one
remaining unknown; candidates are constrained hard below.

## The specimen

`check --scope tree` (nested under `./equin push`, worktree
`att-1784630317-o0fi`), pid 81345, launched pre-armed
(`--inspect=localhost:52657/2ce01c89`, marker + `ps` both carried the URL).
Wedged from ~01:10 CEST 2026-07-22: `pending: ["orphaned-db-tables"]` for 34
minutes, 30 s heartbeats millisecond-punctual throughout, 97–99% CPU, no
children, canonical native fingerprint chain
(`…→0x8e7dd0→0x8ed164→0x8ecf40→0x43a040→0x1a2cc0→0x28591a8→0x25e9648→0x31716b8`)
— same bug as every prior specimen.

Full artifact dir: `~/.singularity/wedge-captures-manual/capture-81345-20260722-012933/`
(runbook capture + all follow-up probes + `FINDINGS.md`).

## Evidence chain (each step measured on the live specimen)

1. **Runbook capture ran first, untouched specimen** — `capture-wedge.sh` per
   the runbook: cpu delta 5.02 s/5 s wall (full burn), native sample matches
   the canonical offset chain, zero children, tiny lsof.
2. **ScriptProfiler saw NOTHING: 0 samples in 2×10 s at 99% CPU.** Not a broken
   kit: a control (busy yielding JS hot loop, same client, same bun 1.3.13)
   yielded 107 symbolicated samples in 5 s. The wedged main thread executes
   ~zero *sampleable* JS.
3. **Zero net allocation.** `bun:jsc` `heapStats()` 10.4 s apart: heapSize
   +2 KB, objectCount +12, RSS +49 KB. The "allocating hot loop" wording in the
   prior model is refuted for this specimen — the loop is steady-state.
4. **JSC's internal sampling profiler (started via `Runtime.evaluate` →
   `bun:jsc.startSamplingProfiler()`) named the function.** 17 traces over the
   accumulation window: 16 × `processTicksAndRejections|FTL` at `bc#365`
   calling an `Unknown Executable` (native) leaf, with **no other JS frame on
   the stack**; 1 × the progress-log heartbeat writer (proving timers fire).
   FTL tier alone proves an enormous invocation count.
5. **bc#365 = the `drainMicrotasks()` call site.** Empirical calibration on the
   same bun 1.3.13 binary (`bc-calibrate.ts` in the artifact dir): a
   `process.nextTick(nativeFn)` storm samples at `bc#119` (the `callback()`
   dispatch); a microtask storm samples at **`bc#365`** with the identical
   `?|Unknown Executable < processTicksAndRejections` trace shape. Source:
   `src/js/builtins/ProcessObjectInternals.ts` — the drain is
   `do { while(queue.shift()) callback(); drainMicrotasks(); } while (!queue.isEmpty())`.
6. **The jobs are enqueued natively, not via JS APIs.** `process.nextTick` and
   `queueMicrotask` were wrapped with counters in the live specimen for 5 s at
   full burn: **0 calls**. (Patches restored after.) Combined with (4)'s
   absence of JS handler frames: the microtask jobs are native promise
   reactions / native jobs, produced by bun's Zig/C++ side.
7. **~1512 uniform native-classed protected objects** (`getProtectedObjects()`
   histogram; constructor name reads as lowercase `object`), count stable
   across seconds. Consistent with a large set of pending native
   promises/callbacks held by the native side.
8. **This specimen DID hold sockets** — unlike the 07-21 specimens' "no socket"
   reading: one unix socket (consistent with a pgbouncer connection) and one
   **ESTABLISHED TCP to localhost:9000 (the gateway)**, plus the inspector
   listener. The "straggler holds nothing" generalization from doc-1 fact 5 is
   therefore specimen-dependent, not universal.

## Sharpened mechanism

The wedge is: **the JSC microtask queue never stays empty — every
`drainMicrotasks()` pass executes native reaction jobs whose effect enqueues
more native jobs.** The event loop still turns (heartbeats punctual: the
do-while exits when the *tick* queue is empty, then the loop re-enters next
turn), no syscalls are needed per iteration (17:03 utime vs 0:27 stime on this
specimen — the earlier "kevent64 churn" signature is also specimen-dependent),
nothing allocates net-new, and child-exit/socket completions starve — the op
can neither finish nor exit.

Best candidate class for the native producer, fitting every observation: a
**native promise-reaction cycle in bun's stream/socket machinery** — e.g. a
ReadableStream pull loop (fetch response body, or node:net/pg socket pump)
whose native source keeps fulfilling pending pull promises without delivering
data or terminating. That would: run entirely in native reaction jobs (no JS
frames), need no syscalls once wedged (explaining the pure-user specimen), be
able to persist after the socket is torn down (explaining the 07-21 "no
socket" specimens), and start under fleet pressure when a read/connect races a
reset. **This paragraph is hypothesis, not finding** — the finding is
drainMicrotasks + native jobs; the producer needs one more capture (see next
steps).

## Specimen fate — and a hard methodology warning

After the full capture and all probes above, a follow-up probe calling
`bun:jsc.jscDescribe()` on one of the protected internal objects **crashed the
specimen**: `EXC_BREAKPOINT` (native assertion) at 01:43:31, main thread, mid
eval (`bun-2026-07-22-014331.ips` preserved in the artifact dir — a full,
stripped-offset native backtrace of the storm at the instant of death; its base
matches the canonical chain).

**Rule for future captures: `jscDescribe`/deep-introspection of protected
internal objects is a specimen-killing operation. Do it never, or last.**
Ordering that saved this session: runbook capture FIRST, then profilers, then
heap stats, then patches, then (only after everything else was banked) the
risky introspection.

Side effect: the crash released the push mutex; the fleet unblocked within
seconds (next push acquired at 23:43:27Z). The check failure surfaced to the
owning push as "Checks failed after rebasing" — the wedged worktree's push
(o0fi) will need a re-run.

## Next steps (in order of leverage)

1. **On the next armed wedge, identify the producer, not the drain.** The
   refined protocol (all safe, all verified this session): runbook capture →
   `startSamplingProfiler` accumulate 60 s → heapStats delta → lsof diff over
   time (does a socket vanish while the burn continues?) → enumerate
   `getProtectedObjects` *histogram only* (safe; describe is not). Add: check
   for live fetch/ReadableStream state via `process._getActiveRequests` /
   heap-snapshot (`generateHeapSnapshotForDebugging`) rather than jscDescribe.
2. **Symbolicate the native frames.** The crash .ips + native samples give
   exact stripped offsets (`0x295510c`, `0x2b5b534`, `0x25e9648`,
   `0x28591a8`, …). Downloading the official `bun-profile` 1.3.13
   darwin-aarch64 build and matching code bytes at these offsets would name the
   native producer without needing another wedge. Nontrivial but mechanical.
3. **Upstream**: once the producer is named, this is a bun 1.3.13 bug report
   with a complete evidence chain; also test whether a newer bun release
   changes the builtin's drain loop or the stream pull path.
4. The structural mitigations from doc-1 (cpu-slot/push-mutex lease-reclaim,
   watchdog re-trip on idle→spinning) remain unaddressed and are what turns
   one wedged process into a fleet gridlock.

## Known upstream issues (GitHub survey, 2026-07-22)

- **oven-sh/bun#27766** (open, 2026-03-03, no fix as of 1.4.0-canary.1) — "Event
  loop busy-spins at 100% CPU when spawning concurrent bun processes (macOS
  ARM64)". Best match: probabilistic (~5–10% of concurrent children),
  permanent 100% CPU spin, macOS ARM64. A second reporter confirms the same
  signature on **1.3.14 AND 1.4.0-canary.1** with a non-Ink workload that
  mirrors ours uncannily: file lock + Postgres-protocol work (PGLite) + git
  subprocess calls. Their native samples show the same structural shape
  (recursive JS-side frame → JIT → native leaf) with version-shifted offsets —
  independent confirmation of a bun-internal hot loop. Differences to keep
  honest: their leaf is `clock_gettime`/`mach_absolute_time`; ours lands in
  VM/JIT + `pthread_getspecific`. Same family, possibly a sibling loop.
  Consequence: **a bun version bump is unlikely to fix this** (canary still
  affected).
- Same-family open issues: **#32600** (node:http server pegs 100% CPU after
  ~a day of uptime, 1.3.13 + 1.4.0), **#31511** (usockets accept(2) spin on
  macOS after CLOSE_WAIT accumulation), **#35010** (segfault in JSC
  `MicrotaskQueue::drain`, 1.3.14), **#33366** (node:fs callbacks run as
  native promise reactions — the exact job type our storm is made of).
- Our capture is stronger than anything in #27766 (they have native samples
  only; we name the JS-level drain site + prove native enqueue + zero
  allocation + have a mid-storm crash dump). **Action: comment on #27766 with
  the evidence chain from this doc** once the producer is named — or now, since
  the drain-site naming alone advances that thread.

## Constraint compliance

- The specimen was not killed before the full capture was in hand (the fatal
  probe came after everything was banked, and taught us a new methodology rule).
- No fix is shipped here: the profile names the drain site conclusively, but a
  fix must follow from the *producer*, which is one capture (or one
  symbolication pass) away.
