# Build lock leak when a build is orphaned / killed by a catchable signal

## Context

A `./equin build` can be left orphaned (reparented to PID 1) and keep
running for many minutes after the shell/agent that launched it dies, holding
the cross-process build mutex (`plugins/framework/plugins/web-core/.build.lock`)
the whole time. Every subsequent build then blocks on
`"Another build is in progress; waiting..."` until the orphan is manually killed
and the lock manually removed.

Observed incident (2026-07-07/08, host load avg ~34): a foreground build's
invoker died (reported exit 144), but the exec'd `bun … bin/index.ts build`
process had no reason to die — `SIGURG`'s default disposition is *ignore* — so it
kept running ~13 min reparented to init, holding the lock. A retry build
correctly refused to steal the lock (holder PID genuinely alive via the
`kill(pid,0)` probe), then hit the fixed 600×500ms = **5-minute** wait ceiling
and threw — even though that ceiling is *shorter* than a real build under load
(the holder reported "built in 5m 55s"), so even a healthy concurrent build
spuriously times out its waiters. Killing the orphan required `SIGKILL`, which
runs no handlers, so the lock had to be `rm`'d by hand.

Three structural gaps, all in the lock/lifecycle code of
`plugins/framework/plugins/cli/bin/commands/build.ts` (the entire mutex lives
inline there, lines 136–181):

1. **No lifecycle tie to the invoker.** The build does not die when its invoker
   dies — no parent-liveness watchdog — so a foreground build can orphan to init
   and hold the lock indefinitely. (This is the incident's root cause; the build
   didn't even receive a fatal signal, its parent just went away.)
2. **Cleanup runs on too few death paths.** Lock release + build-log finalize
   run only on `exit`, `SIGINT`, `SIGTERM`. A catchable fatal signal that isn't
   one of those (`SIGHUP` on terminal/SSH hangup, `SIGQUIT`) terminates without
   releasing the lock or closing the build-log record. (`SIGKILL` is legitimately
   uncatchable — the dead-holder ESRCH steal is the correct backstop there.)
3. **Fixed 5-min wait, no progress heuristic.** The wait ceiling is below the
   worst-case build time under load, so waiters fail spuriously against a healthy
   holder; and there is no way to distinguish a *wedged* holder (alive, stuck)
   from a *slow* one (alive, progressing).

The desired outcome: an orphaned/hung-up build reliably releases the lock (or
dies so the ESRCH steal reclaims it), and a healthy-but-slow holder is waited on
patiently instead of timing out — while two concurrent builds are never allowed.

## Approach

Three complementary fixes. (1) and (2) make an orphaned/hung-up holder actually
*die* (→ ESRCH-stealable, or → runs its exit handlers and releases). (3) makes
the wait patient with a healthy slow holder and loud with a wedged one, and never
steals from a live process.

### Fix 1 — Parent-death watchdog for foreground builds

Reuse the exact orphan-detection idiom already proven in
`plugins/framework/plugins/server-core/bin/index.ts:379-386` and
`plugins/framework/plugins/central-core/bin/index.ts:87-91`
(macOS has no `PR_SET_PDEATHSIG`, so poll `process.ppid` against `1`; `.unref()`
the timer so it never keeps the process alive):

```ts
// A foreground `./equin build` dies with its invoker so an orphaned build
// never holds the build lock. The detached self-restart build (run-build.ts)
// opts out — it *intends* to outlive (and kill) the backend it restarts.
if (process.ppid !== 1 && !process.env.SINGULARITY_BUILD_DETACHED) {
  setInterval(() => {
    if (process.ppid === 1) process.exit(140); // 128+12: orphaned
  }, 2000).unref();
}
```

- **Placement:** in `build.ts` `action()`, right after the signal handlers at
  lines 823–825 (before `acquireBuildLock` at 838). `process.exit(140)` fires the
  already-registered `exit` handlers — `finalizeBuildLog(false)` (823) and the
  lock-release (registered inside the lock once acquired) — so the lock is
  released and the build-log closed as failure.
- **Exempting the detached self-restart build (required):**
  `plugins/build/server/internal/run-build.ts:174-180` spawns
  `./equin build --allow-main` with `detached: true`; that build kills its
  own parent backend during restart and *must* survive being reparented to init.
  Add `SINGULARITY_BUILD_DETACHED: "1"` to the spawn `env` (line 179, alongside
  the existing `SINGULARITY_BUILD_ID`). An explicit flag, decoupled from the
  build-id passthrough — do not overload `SINGULARITY_BUILD_ID`.
- Foreground builds kill only the *backend* (not their own ancestor) during
  restart, so their `ppid` becomes `1` only if the invoker genuinely dies — the
  watchdog is safe for them. The env flag doubles as the escape hatch for anyone
  intentionally backgrounding a build (`SINGULARITY_BUILD_DETACHED=1 nohup …`).

### Fix 2 — Release on more catchable fatal signals

Extend the per-signal → `process.exit()` convention (the repo's consistent rule:
signal handlers just `process.exit(code)`; the `exit` handler does the cleanup).
Replace the two hand-written lines at `build.ts:824-825` with a small table so
`SIGHUP` (terminal/SSH hangup — directly relevant to "invoker died") and
`SIGQUIT` also run the `exit` handlers:

```ts
// Catchable fatal signals → graceful exit so the `exit` handlers below
// (lock release + build-log finalize) run. SIGKILL is uncatchable — the
// dead-holder ESRCH steal in acquireBuildLock is the backstop there.
for (const [sig, code] of [
  ["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129], ["SIGQUIT", 131],
] as const) {
  process.on(sig, () => process.exit(code));
}
```

Do **not** handle `SIGURG` (default disposition is ignore; the Bun/Go runtime
uses it for preemption — trapping it would be wrong).

### Fix 3 — Heartbeat + adaptive-cap wait loop (extract to a module)

Extract the mutex from `build.ts` into a co-located, unit-testable module
**`plugins/framework/plugins/cli/bin/build-lock.ts`** exporting
`acquireBuildLock(lockPath, opts?)`. This isolates the correctness-critical
steal/staleness logic (mirroring how the repo already isolates durable-lock
logic in `run-build.ts`/`worktree-op.ts`) and lets it be tested without a build.

**Holder side — heartbeat freshness.** On acquire, keep the atomic-symlink
creation and the `pid-<pid>-<ts>` target, but treat `<ts>` as a *heartbeat*:
start an `.unref()`'d `setInterval` (every `HEARTBEAT_MS = 5_000`) that refreshes
the freshness stamp. Refresh atomically so there is never a window where the lock
is absent (a waiter must not be able to `symlink` into a gap):

- **Primary:** `fs.lutimesSync(lockPath, now, now)` — updates the symlink's own
  mtime in a single syscall, target unchanged; waiter reads freshness from
  `lstatSync(lockPath).mtimeMs`. *Verify Bun implements `lutimesSync`* during
  implementation.
- **Fallback (if `lutimesSync` is unavailable):** write a temp symlink
  `.build.lock.hb.<pid>` with target `pid-<pid>-<now>` and `renameSync` it over
  `lockPath` (atomic replace); waiter reads freshness from the `<ts>` in the
  target. Keep freshness in exactly one place (mtime *or* target-ts), not both.

`release` clears the heartbeat interval and `unlinkSync`s the lock; it stays
registered on `process.on("exit")` as today.

**Waiter side — patient, progress-aware, never steals from a live process.**
Replace the fixed 600-attempt loop. Each poll (`POLL_MS = 500`), `readlink` +
`lstat` the lock and branch:

| Holder state | Action |
| --- | --- |
| PID dead (`kill(pid,0)` → `ESRCH`) | **Steal** — `unlink`, retry acquire (existing behaviour, keep). |
| PID alive, stamp **fresh** (age ≤ `STALE_MS`) | Slow-but-healthy → keep waiting. Reset the wedged tracker. |
| PID alive, stamp **stale** (age > `STALE_MS`) | Wedged → **throw** a descriptive error naming the holder PID and staleness. Never steal from a live process. |
| Absolute cap exceeded (even while fresh) | Throw — clock-anomaly / pathological sanity bound. |

- `STALE_MS = adaptiveTimeoutMs(60_000, 180_000)` — 12 missed heartbeats at
  baseline, growing under host load (the incident ran at load ~34). Build steps
  run as *awaited subprocesses*, so the holder's event loop is free to heartbeat
  during them; ≥60s of total heartbeat starvation genuinely indicates a wedge.
- Absolute cap = `adaptiveTimeoutMs(600_000, 1_800_000)` (10 min → 30 min under
  load) — well above a real build so a healthy slow holder is never cut off.
- Reuse the existing `adaptiveTimeoutMs(base, max)` helper already used
  throughout `build.ts` (e.g. `probeHealth`, restart fetch). Constants overridable
  via `opts` so unit tests run fast.
- **Why throw, not steal, on a live wedged holder:** two concurrent builds
  corrupt shared state (`node_modules`, migrations, `dist.*` swap). Failing
  loudly with the wedged PID lets the operator kill it; once dead, the ESRCH path
  reclaims cleanly. This also *removes* the double-holder race entirely (the lock
  is only ever removed by its own holder's release or by a waiter after the
  holder is already dead), so the heartbeat needs no ownership self-check.

The `build.ts` call site (838) is unchanged apart from the import moving to
`./build-lock`; it may keep discarding the returned `release` (the on-exit
handler remains the durable release path).

## Files to change

- `plugins/framework/plugins/cli/bin/build-lock.ts` **(new)** — extracted
  `acquireBuildLock` with heartbeat + adaptive-cap + throw-on-wedged wait loop.
- `plugins/framework/plugins/cli/bin/build-lock.test.ts` **(new)** — `bun:test`
  unit tests (see Verification).
- `plugins/framework/plugins/cli/bin/commands/build.ts` — remove inline
  `acquireBuildLock` (136–181), import from `./build-lock`; add the parent-death
  watchdog and the signal table near 823–825.
- `plugins/build/server/internal/run-build.ts` — add
  `SINGULARITY_BUILD_DETACHED: "1"` to the detached-build spawn `env` (line 179).

## Verification

**Unit (`bun:test`, fast, deterministic — inject small timing via `opts`):**

```bash
bun test plugins/framework/plugins/cli/bin/build-lock.test.ts
```

Cases:
- **Dead-holder steal:** pre-create the lock symlink naming a definitely-dead PID
  → `acquireBuildLock` steals and resolves.
- **Wedged-alive throws:** pre-create the lock naming `process.pid` (alive) with a
  stale stamp (small `STALE_MS`) → rejects with an error naming the holder PID;
  the live holder's lock is left intact (not stolen).
- **Uncontended acquire + release:** acquire on a fresh path, assert the lock
  exists, call `release`, assert it's gone and the heartbeat interval is cleared.

**End-to-end (real build):**
- Baseline: `./equin build` succeeds and leaves no `.build.lock` behind
  (`ls plugins/framework/plugins/web-core/.build.lock` → absent after completion).
- Watchdog: start `./equin build` from a subshell, kill the subshell (its
  invoker) mid-build; confirm the `bun … build` process exits within ~2s
  (`ps`/`pgrep`), the lock is gone, and the global build-log has a matching
  `completed`(`success:false`) record. Confirm a build launched from the UI
  (detached, `SINGULARITY_BUILD_DETACHED=1`) completes its self-restart normally
  and is *not* killed by the watchdog.
- Hangup: send `SIGHUP` to a running build; confirm graceful exit + lock removed.
- Patience: hold the lock with a live process carrying a *fresh* heartbeat while a
  second `./equin build` waits — confirm the waiter keeps waiting past the
  old 5-min ceiling and proceeds the instant the holder releases (no spurious
  "Timed out" against a healthy holder).
