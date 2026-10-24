# CLI op wedge — the CPU sink is JSC garbage collection (live-specimen finding)

Supersedes the "strongest surviving lead" and the symptom corrections of both prior
docs:
- [`2026-07-19-global-cli-op-wedge-investigation-state.md`](./2026-07-19-global-cli-op-wedge-investigation-state.md)
- [`2026-07-20-global-cli-op-wedge-capture-watchdog.md`](./2026-07-20-global-cli-op-wedge-capture-watchdog.md)

Root cause is **not yet named at the JS line level**, but for the first time the
**subsystem is named from a live specimen**, and it is neither of the two things
the prior docs chased.

## The specimen

`bun cli/bin/index.ts build`, **pid 91991**, worktree `att-1784539909-po60`,
inspected live on 2026-07-21 ~10:44–10:50 UTC, ~32 min into the wedge. Marker
`ops/build.json` stuck at `phase: "running"` since 10:16:44Z, never finalised.

At the same instant the box held **five concurrent builds**; the other four were
either idle at 0 % CPU or `R`/`U` — see "It starves the fleet" below.

## Finding 1 — it IS spinning, and the sink is JSC GC

Measured, not inferred:

- CPU-time advances ~**1.0 s per 1.0 s wall** (`ps` `time`: 22:27 → 22:52 → 24:43
  → 26:22 across reads) → **one core, steady**, for 32+ min. The prior doc's
  "~2.5 cores" was inflated by `sample`'s own wall-time; the true rate is one core.
- Thread count **stable at ~43** over a 6 s watch → **no thread/subprocess churn**.
- Per-thread leaf analysis of the `sample` capture: the ONLY threads not parked in
  a blocking syscall are the **JavaScriptCore GC threads**:
  - `JavaScriptCore libpas scavenger` — running (JSC's allocator scavenger)
  - `3× Heap Helper Thread` — running (JSC parallel GC mark/sweep)
  - main thread — **77 % parked in `kevent64`**, 23 % periodic JS
  - all 18 `Bun Pool` workers → `__ulock_wait2` (idle)
  - tailwindcss-oxide rayon pool → `rayon ... Sleep::sleep` (idle)
  - fsevents / esbuild service child → idle

So the burning core is **GC**, not application JS on the main thread, not a
worker, not a native addon.

Corroborated by memory (from the `sample` header + `vmmap -summary`):
- **Physical footprint peaked at 1.9 GB** (691 MB at inspection).
- **619 MB swapped out**, only 70 MB resident — the heap ballooned, then paged out.

This **overturns** the prior conclusions:
1. "It is NOT spinning, it's an idle hang" → **false here**; it spins, in GC. The
   three earlier `sample` captures that showed "every thread blocked" were most
   likely **victim** builds parked on the cpu-slot turnstile (which looks exactly
   like an idle hang — see Finding 3), not the culprit.
2. "Strongest lead: a hung `git` child with unbounded stdout read" → **not it**.
   There was **no `git` process anywhere on the box**; the only child was an idle
   esbuild service. The decisive question the watchdog was built to answer — *is a
   git child alive?* — is answered **no**.
3. "Footprint 0.8–1.4 GB is a normal post-run heap, no signal" → **the footprint
   IS the signal** (1.9 GB peak + active GC threads).

## Finding 2 — this explains "wedges AFTER finishing its work" (occurrence C)

A bun/Node process exits when the event loop is empty **and** nothing keeps it
alive. Here the build's work is done (main thread idle in `kevent64`; occ. C even
printed its success banner), but a **GC thread is stuck running and never
quiesces** — so the process both **cannot exit** and **burns a core**. That is the
"completed successfully, then spun for 17 h" signature, with **no external child
needed** to explain it. The git-child framing was never required.

## Finding 3 — one wedge starves the whole fleet (the "blocked builds" symptom)

`91991` held **fds on all 8 cpu-slots** (`~/.singularity/cpu-slots/slot-0..7.lock`)
for its entire life. Concurrent builds were blocked behind it:
- `97279` (worktree `7p7b`): its **8 `host-semaphore/flock-wait.ts` children were
  blocked in `flock` for 23 min** waiting for a slot; the parent sat at 0 % CPU
  (an "idle hang" that is actually a **victim**).
- `3186`, `11694`, `97279` parked on `turnstile.lock`.
- Two more builds queued behind.

So "builds are blocked" = one GC-wedged build pins the entire cpu-slot pool for
hours. This reframes remediation: even before the JS cause is fixed, a wedged op
holding the whole pool is its own incident (candidate: a slot lease/heartbeat so a
wedged holder is reclaimed — deferred until the cause is known, per the
no-fix-on-a-guess precedent).

## What is still NOT known

The **exact JS allocation site**. bun is a stripped static binary, so every JS/JIT
frame in `sample` is `???` and the GC's work does not name what it is collecting.
The main thread's periodic-JS branch has a stable offset chain across both samples
(a real recurring code path), but offsets don't symbolicate.

## How to name it — the two paths (in priority order)

1. **Build-phase instrumentation (this change).** The build already funnels every
   step through `buildProfilerStart()` (`cli/bin/profiler.ts`), but its spans live
   in an in-memory array flushed only by `writeBuildProfile()` at the very end — a
   wedged build never flushes, which is why occ. C left no phase record. Add a
   **durable, synchronous** marker at that same chokepoint (via `defineFileSink`,
   exactly like the committed check-progress log `9e337217f`) writing
   `~/.singularity/build-progress.jsonl`, **with `process.memoryUsage().rss` on
   every marker + heartbeat**. Then the next wedge names *both* the phase
   (`enter` with no `leave`) *and* that its RSS was climbing — which is precisely
   what the check log could not show. Zero cost, always-on, survives SIGKILL.
2. **Reproduce under an inspectable bun.** The trigger correlates with **concurrent
   builds / memory pressure** (5 at once, heap → swap). Reproducible by running
   several `./equin build` across scratch worktrees. Under `bun --inspect`
   (on demand — never always-on: it opens a full-control debug socket, inhibits JIT
   tiers, and shifts GC timing enough to be a heisenbug), a heap/sampling-profiler
   snapshot of the culprit phase names the function outright.

Instrumentation first names the *phase*; the targeted `--inspect` repro of that
phase names the *line*.

## Candidate phases to suspect first

Given GC/heap and the threads seen: the heavy heap producers in a build are the
**facet-parsing plugin-tree walk** (`buildPluginTree({ facets: true })` during
codegen — parses every plugin) and the **web-artifacts / frontend** stage
(tailwind-oxide + esbuild were loaded, though idle at capture). The instrument will
settle which.

## Evidence preserved

- `sample` captures: `/tmp/wedge-91991-po60-*.sample.txt` (+ scratchpad copies).
- Child tree, `lsof`, cpu-slot holders, footprint/vmmap, thread-churn watch — in
  the 2026-07-21 session transcript.
