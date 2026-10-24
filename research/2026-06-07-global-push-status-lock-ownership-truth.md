# Push status UI: derive lock ownership from one source of truth

**Date:** 2026-06-07
**Category:** global (cli + infra/worktree + conversations/op-status)
**Status:** Plan — awaiting approval

## Context

The conversation banner and sidebar chip that show push status
(`Push in progress` = up-arrow, `Push queued — waiting for lock` = hourglass)
can show states that are **impossible** given the single global push lock:

- **Symptom A** — two+ conversations show "pushing"/running at once, for 10+ s and
  observed for minutes (one push displayed "running" for 31+ min).
- **Symptom B** — every queued push shows "waiting for lock" while *no* push shows
  as the active holder (lock appears held by nobody though one is running).

These indicators are how a user/agent reasons about "is my push running, queued,
or wedged?". Today they can lie, so they can't be trusted. This plan fixes the
correctness of the displayed status vs. true lock ownership.

## Root cause (confirmed by code trace)

The true serializer is an OS `flock` on `~/.singularity/push.lock`, held for the
whole critical section by the independent CLI push process and auto-released by
the kernel on process death — see `withPushLock` in
`plugins/framework/plugins/cli/bin/commands/push.ts:269-299`.

The **displayed** phase, however, comes from per-worktree marker files
`~/.singularity/worktrees/<slug>/ops/push.json` carrying a `phase` field that each
push process *asserts about itself*:

- `markWorktreeOpStart(slug,"push","waiting-for-lock")` before the lock wait — `push.ts:358`
- `setWorktreeOpPhase(slug,"push","running")` in `onLockAcquired` — `push.ts:364`
- `clearWorktreeOp` via `process.on("exit")` — `push.ts:359` (does **not** run on SIGKILL)

The op-status resource loader
(`plugins/conversations/plugins/conversation-view/plugins/op-status/server/internal/resource.ts:12-22`)
echoes each marker's stored `phase` verbatim, and the UI
(`op-status-chip.tsx`, `op-status-banner.tsx`, `web/internal/use-worktree-op.ts`)
chooses the icon **purely from that stored field**. Nothing ever cross-checks the
real flock or any global notion of "who holds the lock."

So "running" is **N independent per-process assertions** with no single source of
truth tied to the actual lock. Failure modes:

1. **Stale `running` after a hard kill** (SIGKILL/OOM/tmux pane killed). Kernel
   frees the flock but `clearWorktreeOp` never runs → marker lingers with
   `phase:"running"`. The next push acquires the real lock and flips *its* marker
   to running → **two `running` markers** = Symptom A.
2. **PID reuse** — the only reaper is `isPidAlive` (`process.kill(pid,0)`,
   `worktree-op.ts:53-60`). If the dead push's pid is recycled to any live
   process, the stale marker reads "alive" and is **never reaped**. This is the
   only mechanism that explains persistence for *minutes / 31 min* (the 30 s
   watcher reconcile would otherwise reap a genuinely-dead pid). Smoking gun.
3. **Handoff window** — ms-scale double-running while the releasing push hasn't yet
   run its exit handler.
4. **Symptom B** = the transient where a dead holder's marker was reaped (or never
   flipped) but the genuine new holder's flip hasn't propagated yet, or every
   shown push is genuinely waiting because the (dead) holder released the flock and
   no waiter has acquired yet.

`pushId`-matching alone does **not** defeat PID reuse: after kill+reuse, both the
stale marker and any sidecar carry the *same* old pushId and the *same* reused
(now-alive) pid — self-consistent but wrong. Only the kernel flock knows the truth.

## The fix — one source of truth: kernel flock + a single holder file

Stop trusting N self-asserted phases. **Derive** each push's phase in the resource
loader from two authoritative inputs:

- **Existence of a running push** → the kernel `flock` on `push.lock`
  (PID-reuse-proof, crash-proof: the kernel releases it on death).
- **Identity of the holder** → a single global holder file
  `~/.singularity/push-holder.json` = `{ slug, pid, pushId, acquiredAt }`, written
  atomically by whoever holds the flock and removed on release. One file ⇒ at most
  one running slug ⇒ **two-running is structurally impossible**.

Derivation (pure function, see below): for each live push marker `m`,
`phase = "running"` iff the holder file names `m.slug` **and** is corroborated as
live; else `"waiting-for-lock"`. Builds are unaffected — always `running`, no
holder, no lock.

**Liveness gate for the holder (defeats PID reuse, keeps the probe off the hot path):**
- holder pid dead (`!isAlive`) → no running push → reap holder file → all `waiting`.
- holder pid alive **and** holder.pushId matches the live marker for holder.slug →
  corroborated by two independently-written files sharing a UUID → **running**, no
  flock probe needed (the common path).
- holder pid alive but **no** live marker corroborates it (the PID-reuse ghost
  signature) → and only then → do a single non-blocking `flock(LOCK_EX|LOCK_NB)`
  probe on `push.lock`, releasing immediately:
  - acquired (lock free) → ghost → reap holder → all `waiting`.
  - failed (lock held) → a real push holds it → holder authoritative → `running`.

The probe is confined to the rare ghost case, so it essentially never perturbs the
CLI's own non-blocking contention probe (`push.ts:288`); worst case is one cosmetic
"waiting" log line, never a correctness or serialization effect.

### Why this satisfies the hard constraints

- **CLI is independent / push works with servers down** — all push-side writes stay
  in the CLI (holder file written/removed by the holder process); the server only
  *reads/derives*. The flock remains the sole serializer; the holder file is a
  descriptive sidecar.
- **Many restarting per-worktree backends** — each backend still derives
  identically from the same global files; restart just re-runs the loader.
- **No polling** — push-driven via the existing file watcher; the flock probe is
  event-gated, not a timer.

## Files to change

1. `plugins/infra/plugins/worktree/server/internal/worktree-op.ts`
   - `markWorktreeOpStart` (62) / `WorktreeOpInfo` (29) / `readLiveMarker` (101):
     thread an optional `pushId` into the push marker (server-internal; builds omit it).
   - New holder helpers: `pushHolderPath()`, `readPushHolder()`,
     `writePushHolder(info)` (atomic temp-write + `renameSync`), `clearPushHolder(pushId)`
     (no-op unless the on-disk holder's pushId matches — so a late-dying waiter can't
     delete the real holder's file).
   - New `pushLockHeld(lockPath = PUSH_LOCK_PATH): boolean` — the gated FFI
     `flock(LOCK_EX|LOCK_NB)` probe, immediate release. Single server-side flock
     site (mirrors the CLI's single FFI use at `push.ts:271-274`).
   - New **pure** `derivePushPhases(markers, holder, { isAlive, lockHeld })` —
     all correctness lives here; no fs, no process calls (injected predicates).
2. `plugins/infra/plugins/worktree/server/index.ts` — export the new helpers.
3. `plugins/framework/plugins/cli/bin/commands/push.ts`
   - `markWorktreeOpStart(opSlug,"push","waiting-for-lock", pushId)` (358).
   - `onLockAcquired` (360-366): `writePushHolder({ slug: opSlug, pid: process.pid, pushId, acquiredAt })`.
     Keep `setWorktreeOpPhase` only as an advisory hint (the loader now overrides it).
   - `process.on("exit")` (359): also `clearPushHolder(pushId)` (covers normal exit,
     every `process.exit(1)` path, and thrown errors).
4. `plugins/conversations/plugins/conversation-view/plugins/op-status/server/internal/resource.ts`
   - Loader builds the payload via `derivePushPhases(listActiveWorktreeOps(), readPushHolder(), { isAlive: isPidAlive, lockHeld: pushLockHeld })`.
     Builds pass through as `running` unchanged.
5. `plugins/conversations/plugins/conversation-view/plugins/op-status/server/internal/watcher.ts`
   - Hardening: watch `[worktreesDir(), SINGULARITY_DIR]` (filter `.json`) so a
     holder-file change notifies even if it ever lands without a paired marker
     change; the 30 s reconcile remains the backstop. (Strictly optional — every
     ownership transition already touches a `.json` under `worktreesDir`, so notify
     already fires; this is defense-in-depth.)

**Keep** the stored `phase` field on disk (build markers and the shared
`WorktreeOpSchema` depend on it; old markers default to `running`). The loader
*overrides* the push phase with the derived value, so the chip/banner and shared
schema need **no** changes. `WorktreeOpInfo.pushId` stays server-internal (omit
from `WorktreeOpSchema` — no client churn).

## Crash-safety walkthrough

- **Holder SIGKILLed** — kernel frees flock; marker + holder file linger. Next
  notify/reconcile: holder pid dead → reap → all `waiting`; or pid reused →
  no-corroboration → flock probe → lock free → reap. Invariant restored within one
  cycle. A new push that grabbed the flock atomically overwrote the holder file, so
  its slug reads `running` and the stale slug reads `waiting` — **never two running**.
- **Waiter SIGKILLed** — never wrote the holder file; its marker is reaped by
  pid-liveness; it can only ever read `waiting`, so it can't cause Symptom A.
- **Handoff** — releaser removes the holder file in `finally`/exit *before* the next
  holder writes its own; both gated by the same flock ⇒ never two holder files; the
  atomic rename means the loader reads old-or-new, never torn.

## Verification — unit-tested, no real pushes

All bug-prone logic is the **pure** `derivePushPhases(...)`, tested in-memory with
fabricated markers/holder and **injected** `isAlive`/`lockHeld` — no flock, no
process spawning, no `./equin push`. Thin fs/FFI adapters are tested in
isolation against throwaway paths.

Add `plugins/infra/plugins/worktree/server/internal/worktree-op.test.ts` using
`bun test` (zero-config, bun-native, resolves the repo's tsconfig path aliases;
the only existing tests are web vitest specs in `web-core`, and there is no
server-test precedent — `bun test` avoids standing up a second vitest node
project. Vitest-node is the alternative if a single runner is preferred). Cases:

1. **Two-running impossible** — two markers, holder names A, both pids alive,
   pushIds match → exactly one `running` (A), B `waiting`. (Provable by
   construction; the test confirms no gap.)
2. **Dead holder → all waiting** — holder.slug=A, `isAlive(A.pid)=false` → A and B
   both `waiting`.
3. **PID-reuse ghost reaped** — holder.slug=A, `isAlive=true`, **no** corroborating
   live marker for A, `lockHeld=false` → A `waiting` (today's code would show A
   `running` forever; this is the regression test that fails on `main`).
4. **Ghost but lock genuinely held** — same as 3 but `lockHeld=true` → A `running`.
5. **pushId mismatch** — holder.slug=A but holder.pushId ≠ A-marker.pushId →
   A `waiting`.
6. **Build untouched** — a `build` marker with no holder → `running` (wrench).
7. **`pushLockHeld` adapter** — flock a *temp* lock file in the test process →
   `pushLockHeld(tmp)===true`; release → `false`. (Real FFI, throwaway path, no push.)
8. **fs adapters** — `writePushHolder`/`readPushHolder`/`clearPushHolder(pushId)`
   round-trip and the pushId-guarded no-op delete, against a temp dir (give the
   adapters an optional `root` arg defaulting to `SINGULARITY_DIR`, since it is a
   module const, not env-overridable).

Run: `bun test plugins/infra/plugins/worktree/server/internal/worktree-op.test.ts`.

**Then** the standard gate + a manual smoke:
- `./equin build` (regen + checks) and `./equin check` must pass
  (boundary checker: the worktree primitive owns the holder/flock helpers;
  op-status only consumes them — preserves the boundary in `op-status/CLAUDE.md`).
- Optional end-to-end confirmation (no merge risk): launch a real push, `kill -9`
  it mid-hold, and confirm the chip/banner self-heal to a correct state (the killed
  slug stops showing `running`) within one watcher cycle, and that a second push
  shows exactly one `running`.

## Out of scope

The Debug → Profiling push Gantt
(`plugins/debug/plugins/profiling/plugins/push/`) reads a *separate* source
(`push-contention.jsonl`) and is a manual-refresh snapshot reconciled by
`finalizeOrphanedPushes` at backend boot. It has analogous staleness but is not
the user-facing indicator in scope here. If desired as a follow-up, route its
"is this push still live" check through the same new `pushLockHeld` helper so both
surfaces share one authoritative liveness primitive.
