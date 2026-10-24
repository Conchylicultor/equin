# Checkout build lock: time out on a stalled holder, not on a long wait

## Context

On 2026-09-16 a deploy (`drun-1789596179808-gcvl6k`, composition `website`) failed its
build step. Here is what happened:

- 22:00:00 — a push took CPU slots from the interactive lane and kept them for 17 min.
- 22:00:08 — main's automatic build (pid 54424) took the main checkout's build lock
  (`plugins/framework/plugins/web-core/.build.lock`). By 22:02 it was queued for a CPU
  grant, and it stayed queued for 882 s while still holding the lock.
- 22:03 — the deploy's `release` ran `build --hermetic` in the same checkout and queued
  for that lock.
- 22:19:57 — `acquireCheckoutLock` gave up at its fixed limit (`capMs`, which adjusts to
  load between 600 s and 1800 s; here it was 983 s). The release exited 1.

The lock holder was healthy the whole time. It was queued behind other work, then running
checks. The limit exists to catch a **wedged** holder, but it measures **total wait time**.
So any holder that queues long enough fails every command waiting behind it.

**Goal:** a waiter fails only when the holder has stopped making progress. A holder that is
queued in a declared wait (host CPU grant, duress valve) is blocked, not wedged. A holder
that keeps entering and leaving build steps is progressing. Neither should use up the
waiter's time limit.

**Out of scope:** building releases in a separate checkout. That is a separate task, and it
removes release-vs-main-build contention entirely.

## Signals that already exist (nothing new is written)

- **Build-progress log** (`op-runtime/cli/build-progress.ts`, host-global). Each build
  writes a `run` record carrying `pid` and `buildId`, **before** it takes the lock
  (`run.ts:836`). It then writes `enter`/`leave` records for each top-level step. It also
  writes 30 s `pending` heartbeats, but those only show the process is alive.
  `readBuildProgress()` already rebuilds runs from these records. Today it merges the
  heartbeats into `lastActivityAt`.
- **Op log** (`debug/profiling/op-log`, host-global). A build's op record has
  `opId = buildId`. It carries `openWait: { kind: WaitKind, startedAt }` while the build is
  in a declared wait (`host-grant`, `duress-valve`). The op profiler's `grantHooks()` and the
  valve's hold bracket (`run.ts` ~1283) write it. `readOpRecords()` folds those records.
  `WaitKind` is the one place that declares what counts as a blocked interval.

## Design

### 1. The lock asks for an observation, not a description (`bootstrap/cli/checkout-lock.ts`)

Replace the injected `describeHolderActivity(pid) => string | null` with
`observeHolder(pid) => HolderObservation`. The lock derives both its message and its
deadline from this one value, so the two can't disagree:

```ts
export type HolderObservation =
  | { kind: "unknown" }                                   // no live progress record for this pid
  | { kind: "waiting"; wait: string; since: number }      // holder is in a declared wait
  | { kind: "working"; step: string; lastAdvanceAt: number }; // last enter/leave instant
```

This stays a pure type in `bootstrap`. It imports no package, so the no-package check
`cli:bootstrap-package-free` stays green.

**Deadline policy** (in the poll loop, re-observed at most every ~10 s rather than on every
500 ms poll):

| observation | fails when |
|---|---|
| `unknown` (install lock; a hermetic release holding the lock; no describer) | total wait > `capMs` (today's behaviour, unchanged) |
| `waiting` | never while it stays waiting; the budget clock is paused |
| `working` | `now − max(lastAdvanceAt, waitEnteredAt, lastWaitEndedAt) > stallMs` |

- `stallMs` defaults to `adaptiveTimeoutMs(1_800_000, 3_600_000)`, which is 30 to 60 min
  of **no step entered or left**. It has to exceed the longest single step in a normal
  build: the checks step went ~615 s with no top-level `enter`/`leave` in this incident.
- If the holder's pid changes (another process got the lock between our polls), the budget
  starts over. It belongs to one holder.
- On timeout, the error names the reason: stalled in step X for N s, or unknown holder past
  the limit. It stays a thrown `Error`, so failure remains loud.

**Output:** print one line each time the holder's observation changes (unknown → working
"checks", working → waiting "host-grant", …), plus the current single stale-threshold line.
The output stays bounded, and the deploy transcript shows why it is still waiting.

### 2. Expose "last advance" separately from "last activity" (`op-runtime/cli/build-progress.ts`)

Add `lastAdvanceAt` to `BuildRunProgress`. Only `run`/`enter`/`leave` records set it;
heartbeats (`pending`) do not. `lastActivityAt` stays as it is for existing readers.

### 3. Build the observer (`build/cli/internal/app-artifacts.ts`)

`describeBuildHolder` becomes `observeBuildHolder(pid)`:

1. Find the open run (`done === null`) for `pid` in `readBuildProgress()`. If there is
   none, return `unknown`.
2. Find the op record whose `opId === run.buildId` in `readOpRecords()`
   (`@plugins/debug/plugins/profiling/plugins/op-log/server`, which the build CLI already
   imports via `createOpProfiler`). If its `openWait` is non-null, return
   `waiting { wait: openWait.kind, since }`.
3. Otherwise return `working { step: outstanding.at(-1)?.label, lastAdvanceAt }`.

`acquireArtifactLock` passes it in, and both callers pick it up: the deploy build
(`run.ts:836`) and the hermetic build (`hermetic-build.ts:208`). The install lock
(`ensure-deps.ts:464`) passes nothing, so it keeps the fixed limit.

## Critical files

- `plugins/framework/plugins/cli/plugins/bootstrap/cli/checkout-lock.ts`: observation type,
  deadline policy, and transition lines
- `plugins/framework/plugins/cli/plugins/bootstrap/cli/index.ts`: export the type
- `plugins/framework/plugins/cli/plugins/op-runtime/cli/build-progress.ts`: `lastAdvanceAt`
- `plugins/framework/plugins/cli/plugins/build/cli/internal/app-artifacts.ts`:
  `observeBuildHolder`

## Known limitation (not fixed here)

A hermetic release writes no build-progress run, so a build waiting behind a **release**
still sees `unknown` and keeps the fixed limit. The separate-checkout task removes that
case: releases stop taking this lock at all.

## Verification

- **Unit tests** in `checkout-lock.test.ts`, with an injected fake observer, short
  `capMs`/`stallMs`, and a real flock held by a second fd:
  - `waiting` for longer than `capMs` does not time out; it acquires once the holder
    releases.
  - `working` whose `lastAdvanceAt` keeps moving does not time out past `capMs`.
  - `working` with a frozen `lastAdvanceAt` times out after `stallMs`, and the message names
    the step.
  - `unknown` still times out at `capMs` (the existing test stays green).
  - A pid change resets the budget.
- **`build-progress` fold test:** a `pending` record moves `lastActivityAt` but not
  `lastAdvanceAt`.
- **Observer test** over fixture progress and op records: an open `host-grant` gives
  `waiting`, no open wait gives `working`, no run gives `unknown`.
- Run: `./equin test plugins/framework/plugins/cli/plugins/bootstrap plugins/framework/plugins/cli/plugins/op-runtime plugins/framework/plugins/cli/plugins/build`
- **Manual end to end:** in this worktree, start `./equin build` and, while it sits in
  "wait for host CPU grant" (or any step), run
  `./equin release --composition website --target web --platform linux-x64` from the
  same checkout. The release prints the holder's transitions and acquires after the build
  exits, however long that takes.
- `./equin check` (boundaries, including `cli:bootstrap-package-free`).
