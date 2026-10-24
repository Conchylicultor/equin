# CLI op wedge — corrected symptom + a capture watchdog to catch the next one

Supersedes the symptom section of
[`2026-07-19-global-cli-op-wedge-investigation-state.md`](./2026-07-19-global-cli-op-wedge-investigation-state.md).
Root cause is still **NOT found**. This doc records what the preserved `sample`
captures actually prove, kills two more hypotheses, and specifies the one thing
that will close the gap: a watchdog that captures forensics from a live wedge.

## Context — why this exists

`bun cli/bin/index.ts {build,check}` intermittently never exits, holding its host
cpu-slots and (for a push, or a check nested in one) the global push mutex,
serialising every build and push on the machine. Three occurrences in 48h, none
before 2026-07-17. Two prior sessions have failed to find the cause; one shipped a
fix built on a wrong diagnosis, which was reverted.

The blocker is not analysis — three independent static sweeps of the whole
build/check path have now come up empty. The blocker is that **no one has
inspected a live wedge with the right questions**. This plan builds the thing that
does.

## Correction 1 — it is NOT spinning. It is an idle hang.

This is the single most important finding, and it invalidates the framing every
prior session (including the first half of this one) worked from.

Three `sample` captures of real occurrences were preserved on disk:

- `/tmp/spin-sample.txt` — **pid 63550, occurrence B**, launched 17:52:21,
  sampled 18:12:41 (20 min into the wedge)
- `/tmp/bun_2026-07-18_162222_4yme.sample.txt`
- `/tmp/bun_2026-07-18_162239_tqQQ.sample.txt`

In all three, **every thread is parked in a blocking syscall**:

| thread | leaf | state |
|---|---|---|
| main | `kevent64` (161/235 samples) | blocking wait |
| 18× `Bun Pool` | `__ulock_wait2` (235/235) | idle futex wait |
| 3× `Heap Helper` | `__psynch_cvwait` | idle |
| fsevents | `mach_msg2_trap` | idle |

There is no busy thread anywhere. The prior doc's reading — *"main thread
dominated by the kevent64 branch (event loop alive and turning, NOT blocked)"* —
is exactly backwards: `kevent64` **is** the blocking wait. The reported
"~95-100% CPU, state R" is not corroborated by any capture and should be treated
as a misread until a capture shows otherwise.

**Consequence:** stop looking for a busy loop. Look for a handle or an `await`
that never settles. `physical footprint 0.8-1.4 GB` is just a normal post-run Bun
heap and carries no signal.

## Correction 2 — the progress log is committed, not uncommitted

The prior doc's "Instrumentation available now (kept, uncommitted)" is stale. The
check progress log landed as **`9e337217f`** and is in `main`. It is therefore
collecting evidence fleet-wide already; any worktree branched after
2026-07-19 20:41 has it.

## Disproven this session — do not re-investigate

Additions to the prior doc's list:

7. **NOT an undrained-`stderr` deadlock.** Both I and a subagent independently
   flagged that ~140 repo call sites do `Bun.spawn(..., { stderr: "pipe" })` and
   never read `stderr`, theorising the child blocks once the 64 KB pipe buffer
   fills. **Tested in isolation on bun 1.3.13 and refuted:** a child writing 2 MB
   to an undrained `stderr` completes in 52 ms. Bun does not deadlock here.
   (Draining `stderr` is still tidier, but it is not this bug and must not be
   sold as the fix.)
8. **NOT the esbuild service child.** esbuild's own `lib/main.js` (0.18.20)
   `unref()`s the service child, its stdin and its stdout at spawn, `ref()`ing
   only for the duration of an outstanding request. The child observed alive at
   17h47m rides along; it cannot hold the loop open. The prior doc's named
   suspect is cleared.
9. **NOT the type-check warm-base pool (`224ace3de`), and not `423afa587`.**
   The former spawns per-target children and correctly
   `await Promise.all([...text, proc.exited])`; the latter runs in the *backend's*
   reconcile pass, not the CLI's exit path. Both also **postdate occurrence A**
   (13:46 / 17:51 CEST vs A beginning 05:04 CEST), so neither can be the cause of
   a regression that spans all three occurrences. `b5538a83d` is eliminated on the
   same timeline grounds.

## What reproduced, and what did not

**Not reproduced:** a real `./equin {check,build}` wedge. The harness used
(6 concurrent checks in one worktree) was invalid — they collide on the shared
per-worktree op marker and exit 1 with no output. Genuine contention on this box
is *cross-worktree*. A valid repro needs several scratch worktrees; running load
inside other agents' worktrees is not acceptable.

**Reproduced synthetically:** a child process that never settles leaves the parent
blocked, idle, `cpu/wall = 0.00`, and unable to exit — the exact wedge signature.
This demonstrates the mechanism is *possible*; it is not evidence that it is what
occurs.

## The strongest surviving lead

Both durably-recorded hangs blocked on the **same primitive**. From
`check-progress.jsonl`:

| run | check | evidence |
|---|---|---|
| `3c77eca2` | `orphaned-db-tables` | 71 selected, 71 started, **70 ended** |
| `257a5b8f` | `no-raw-websocket` | single-check run, started, never ended |

(`257a5b8f` is a **fourth occurrence** the prior doc does not record.)

- `no-raw-websocket` → `grepCode` → `getRoot()`
  (`checks/core/grep-code.ts:147-151`)
- `orphaned-db-tables` → its own `git()` helper
  (`database/plugins/migrations/check/orphaned-tables.ts:73-84`)

Both do `await new Response(proc.stdout).text()` on a spawned `git`, **with no
timeout**. `getRoot()` additionally never awaits `proc.exited` at all. If such a
child never EOFs its stdout, the check never settles and the process parks
forever, idle — matching every capture.

This also reconciles the two framings: for `check` the *work* never finishes,
while for `build` (occurrence C) the banner proves `writeBuildLogs` ran — and a
build runs checks, so the same stall explains both.

Note this pattern **predates** the regression window, so it cannot by itself be
"the CL that broke it". `50027f334` (01:33 UTC Jul 18, ~1.5h before occurrence A)
is the best remaining candidate: it is the only commit to touch `grep-code.ts`
since Jul 14, and it added three new `git` spawns to the shared scan path —
plausibly raising exposure rate rather than introducing the defect.

**The decisive unanswered question:** *when it hangs, is a `git` child still
alive?* One line of evidence settles it, and neither existing instrument records
it.

## Plan — the capture watchdog

A main-only scheduled job that finds a CLI op which has been alive too long and
captures forensics from it *while it is still wedged*.

Mirror **`plugins/debug/plugins/boot-watchdog/`** byte-for-byte in shape — it is
the closest sibling (main-only scheduled sweep of a filesystem signal → deduped
report). Structure:

```
plugins/debug/plugins/op-wedge-watchdog/
  core/config.ts      # budget + enabled + capture toggles
  core/kinds.ts       # the `cli-op-wedge` report kind
  core/index.ts
  server/index.ts
  server/internal/op-wedge-kind.ts
  server/internal/monitor-job.ts   # defineJob, scheduled, main-only
  server/internal/read-fleet.ts    # sweep every worktree's ops/*.json
  server/internal/capture.ts       # the forensics dump
  web/index.ts        # one-line Debug -> Reports renderer + config registration
```

### Detection

Sweep `~/.singularity/worktrees/*/ops/{build,check,push}.json` — these markers
already carry `{op, pid, startedAt, phase}` and are written by
`markWorktreeOpStart` (`infra/worktree/server/internal/worktree-op.ts:86`).
Reuse the existing readers (`isWorktreeOpActive`, `worktreesDir`); do not
re-derive the paths.

Trip when: the marker's `pid` is **alive** AND `now - startedAt > budget`
(default 15 min — well past a legitimate build, well under the 8-17h observed).
Dedupe per `(worktree, op, pid)` so one wedge files one report, not one per tick.

### Capture — the whole point

For a tripped op, dump, into a `defineFileSink`-declared durable file:

1. **`sample <pid> 10`** — the thread states. Settles spin-vs-block for good.
2. **The child process tree** (`ps -o pid,ppid,stat,%cpu,etime,command`,
   recursively from the wedged pid) — **this answers the decisive question: is a
   `git` child alive?**
3. **`lsof -p <pid>`** — open pipes/fds, showing what the process still holds.
4. The op marker. (**Not** the `check-progress.jsonl` tail — see the caveat
   below.)
5. `ps` `%CPU` **and** cumulative CPU time, sampled twice ~5s apart — so
   "spinning" is derived from a *delta*, never from a single misreadable number.

Then file **one deduped report** through the existing reports engine so it reaches
the bell + Debug → Reports, exactly as `boot-watchdog` does.

### Constraints

- **No in-process timers** — `defineJob` with a schedule, per the repo rule.
- **Main-only.** A per-worktree job cannot reliably observe a wedge in its own
  worktree, and the markers are on shared disk anyway. Same argument
  `boot-watchdog` makes.
- **Capture must be bounded and duress-exempt.** `sample` is expensive; run it at
  most once per `(worktree, op, pid)`. This monitor exists to observe duress, so
  it must not be shed by the duress engine.
- **Do not kill the wedged process.** The whole value is an intact live specimen.
  Reaping it is a separate decision, taken only once the cause is known.
- **Fail loudly.** If `sample`/`lsof` fail, the report says so — never a silent
  partial capture presented as complete.

### Caveat — the check-progress tail is deliberately NOT captured

The capture originally included the `check-progress.jsonl` records for the wedged
pid. It does not, and this is a knowing trade rather than an oversight.

Reading them means calling `readCheckProgress` from
`@plugins/framework/plugins/tooling/plugins/checks/core` — the CLI's *check
runner*. The two ways to reach it are both worse than going without:

- A **static import** makes this the first server plugin to pull that entire
  runner (`runChecks`, `grepCode`, warm-base, read-set) and its transitive graph
  into the main backend's boot. That is a real boot-weight regression, in a repo
  that runs a boot-budget monitor specifically to catch them.
- The **lazy `await import`** that avoids the boot cost is rejected by the
  `inline-import` boundary rule as an undeclared cross-plugin edge. There is no
  precedent for it in any server plugin (the one lookalike,
  `infra/asset-mirror/server/internal/run-prewarm.ts:46`, imports via a computed
  registry constant, not a literal `@plugins` path). Widening that rule is a
  change to load-bearing infrastructure and out of scope here.

**What is actually lost is small.** The decisive datum is the descendant process
tree — *is a `git` child still alive?* — not check-progress. And
`check-progress.jsonl` remains fully readable on its own via
`./equin check --status`; every dump records the pid and both timestamps,
so the two are correlated by hand in seconds.

**If that correlation ever proves load-bearing**, the principled fix is to extract
`readCheckProgress` plus the progress-log path into a leaf plugin both runtimes
may import — keeping one owner of the path *and* the record grammar. Do **not**
widen the boundary rule, and do **not** re-derive the path or re-parse the JSONL
inside this plugin.

## Verification

1. `./equin build`, then confirm a normal run trips nothing.
2. Synthetic wedge: write a fake marker with a live pid and a `startedAt` past the
   budget (e.g. point it at a `sleep 600`), run the job, confirm exactly one
   report with a complete capture attached.
3. Re-run the job on the same marker; confirm dedupe suppresses a second report.
4. Confirm the capture correctly reports the child tree by giving the fake wedge a
   known child.
5. Leave it running. The next real occurrence should produce a full dump.

## Explicitly NOT in this change

No fix. No timeout added to the `git` spawns, no `stderr` draining, no spawn
primitive. Those are candidate fixes for a cause that is **not yet confirmed**,
and the prior reverted fix is the cautionary precedent. Instrument first, then fix
what the evidence names.
