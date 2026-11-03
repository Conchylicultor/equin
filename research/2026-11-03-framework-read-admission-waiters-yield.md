# Read admission: a read that waits gives its slot back

Task: task-1793715927-v0zvtd (taken over from task-1793710061-z8r1z5). Parent track:
"Diagnose slow main branch builds" (task-1793712666-aurzii).

## Problem

The resource runtime admits at most `READ_LOAD_CONCURRENCY = 6` cold read-path loads
at once. A read held its slot for its whole duration, including time it spent only
waiting on work another caller was doing. Six reads waiting on one slow read filled
the gate, and every unrelated read queued behind them: the latency of one read
became the latency of all.

Main, 2026-11-03, backend up 10:45:06Z: at +34.8 s the tabs resubscribed (131+ reads);
the first read of one 4.8 MB transcript took 12.0 s (a host file stall,
task-1793715780-wysema); six values derived from that conversation's transcript held
the six slots; 131 unrelated reads waited ~12 s (`wait read-admit took 11588ms`).
`wait read-admit` has 20,218 slow-op reports in main's DB (max 35 s).

## Mental model

- Before: a read-admission slot = "a read is in progress".
- After: a read-admission slot = "a read is running". A read whose loader joins an
  in-flight run someone else started (`packages/inflight` — the runtime's own flights,
  `createGitStateMemo` / `createSignedMemo` computes, any future shared memo) holds no
  slot while it waits, and resumes ahead of every newcomer when the run settles.

## Design

`packages/semaphore` gains **yieldable slots** (`run(fn, { yieldable: true })`) and
`whileWaiting(promise)`. The slots a body holds are carried in an ambient lease scope
(injected context runtime, AsyncLocalStorage on the server, installed by `runtime-profiler/server` beside
its span context — the same pattern as the profiler's span context; core stays host-neutral).
`whileWaiting` releases them for the wait and re-acquires each at the head of its
gate's queue. `packages/inflight`'s joiner path calls it, so every dedup join is a
wait that holds nothing. The runtime marks its read gate (load + revalidate) yieldable.

Rejected:

- Raising the cap / a deadline on reads: hides the head-of-line blocking (task rule).
- Partitioning the gate by source (db vs external): an fs stall would still block
  every other external read; the defect is waiting-as-occupancy, not mixing.
- Yielding at every gate queue (a read queued for a DB connection gives its read slot
  back): it would take the read slot back while HOLDING the connection, pinning it
  behind running reads. Not done; documented in `semaphore/CLAUDE.md`.

## Measurement

`./equin run plugins/framework/plugins/resource-runtime/scripts/read-admit-bench.ts`:
one 2 s shared read, six derived values joining it, then 30 unrelated reads (5 ms
loaders). "held" = no lease scope (the old behaviour), "yielded" = the fix.

| | unrelated sub-ack, median | unrelated sub-ack, max | derived sub-ack, max |
|---|---|---|---|
| held (before) | 2019 ms | 2031 ms | 2003 ms |
| yielded (after) | 62 ms | 78 ms | 2002 ms |

Unrelated reads drop from the slow read's latency to their own (30 × 5 ms over six
slots); the reads that do depend on the slow one are served as soon as it settles,
exactly as before. Pinned by `core/runtime-read-admit-yield.test.ts` (gate
`{active: 0, queued: 0}` while six joiners wait; unrelated subs acked; the starter
keeps its one slot; six distinct running loads still cap at six) and
`packages/semaphore/core/internal/lease-scope.test.ts`.

## What the profiler saw (and what this does not fix)

A join wait was already charged as a `join` wait (`git-coalesce:<name>`,
`read-coalesce`), never as own time. The incident's "sub jsonl-events took 10097ms
of its own (12063ms wall)" is the derived reads' OWN file I/O — each resolves the
chain (a projects-dir glob per session, `findTranscriptPath`) and lstats it
(`transcriptChainSignature`) before the memo — and main's aggregates agree:
`git-coalesce:jsonl-events` totals 98 ms across all `subagents.parent-facts` subs.
So under a host file stall the six reads were each stalled in their own fs call, not
in a join. Two follow-ups close that:

1. File waits named as waits (task-1793715790-g75uef): once a file wait has a seam,
   it should call `whileWaiting`, so a read stalled on the filesystem stops holding a
   slot too, and its time reads as a wait.
2. The per-read chain resolution and signature probe are not shared between values
   derived from one transcript; single-flighting them per conversation would make the
   derived reads joiners of ONE probe (filed as a sidequest).
