# Duress admission: one agent build at a time, no timeout

## Context

The build duress valve (`op-runtime/cli/admission-valve.ts` + the retry loop in
`build/cli/internal/app-artifacts.ts` `acquireAndRunHeavySection`) holds **every**
gated (agent, background-lane) build while the host duress latch is fresh. With
zero builds admitted there is no progress guarantee, so it fakes one with a 30-min
fail-open (`MAX_VALVE_HOLD_MS`). That bound is per hold, and the post-grant
re-check requeues into a *fresh* hold — a flapping latch starved a build 1h11 over
6 requeues.

Decided with the user: **strict** one-at-a-time. Under duress a gated build is
admitted only when no other gated build is running; the rest wait for it to finish
or for duress to clear. It gets a **full** CPU share. No timeout: global progress
holds by construction (some build always holds the gate exclusively and finishes).

## Design

**A host-wide readers/writer flock**, `locks/agent-build-gate/gate.lock`:

- calm admission = **shared** lock (any number of calm builds run together);
- duress admission = **exclusive** lock (granted only once every running gated
  build has released — "nothing else running");
- held for the whole heavy section; released in `finally`; process death releases
  it (kernel flock semantics), so no lease or timeout is needed.

**Order: gate → grant** (never hold an idle grant while waiting for the gate; a gate
holder only ever waits on a grant, never the reverse → deadlock-free).

```
admitted = await admitThroughGate(gated)          // null when ungated
withHostGrant(...):
  if admitted.mode === "shared" && isUnderDuress(): REQUEUE (release grant + gate)
  run heavy section
```

`admitThroughGate` loop:

- **under duress** → `flockTry(EX)`; else race `waitForFlock(EX)` against the latch
  clearing (existing fs.watch + lease-deadline wake, now abortable). EX wins →
  return `exclusive` (never re-checked, never requeued). Clear wins → abort, loop.
- **calm** → `flockTry(SH)`; if it fails an EX holder is running → `waitForFlock(SH)`
  (wait for it, "in line"). Then re-check duress: fresh → release, loop; else return
  `shared`.

Requeue survives only for the calm path (a shared holder that sees duress once its
grant is held). It terminates: the requeued build goes to the exclusive path, which
never requeues. No `MAX_VALVE_HOLD_MS`, no `fail-open`, no `shouldRequeue`.

Known, accepted:
- flock has no writer preference and no FIFO among waiters: "in line" means progress,
  not strict order. Under duress no new shared admissions happen, so EX can't starve.
- The exclusive holder keeps the gate after duress clears; calm builds wait for it to
  finish (follow-up: downgrade on clear).
- Multi-target builds admit per target (each `buildAndPublishWebDist`); a gate is never
  held across targets (holding it while re-queuing for a grant would deadlock).
- Every blocked waiter costs one `flock-wait` child (~37 MB); `flockTry` first so only
  a real block spawns one.

## Changes

1. **`packages/flock`** — nothing to add: main already ships `flockTryShared` and
   `waitForFlock(path, { shared, signal })` (ccefa2d3cc, host-semaphore's
   `demand.lock`). Reuse them.
   That same commit made `withHostGrant` take a required `priority`
   (sidequest → `low`); the gate sits in front of it and passes it through
   unchanged. A `low` exclusive holder may wait on `normal` grant demand — fine,
   those holders always finish.
2. **`op-runtime`**
   - new `data-dirs/index.ts`: `defineDataDir({ kind: "locks", name: "agent-build-gate", reclaim: restart })`.
   - `admission-valve.ts` rewritten: keep `valveGates`, `checkValveGuard`; replace
     `holdThroughValve` / `MAX_VALVE_HOLD_MS` / `shouldRequeue` / `HoldOutcome` with
     `admitThroughGate({ gated }, deps): Promise<GateAdmission | null>`
     (`{ mode: "shared" | "exclusive", release() }`). `ValveDeps` gains the lock seams
     (`tryLock(mode)`, `waitLock(mode, signal)`), `waitForWake(signal)` becomes
     abortable; `onHoldStart(reason, kind)` / `onHoldEnd(result)` with result
     `"cleared" | "acquired"` (existing `WaitResult`s).
   - `admission-valve.test.ts` rewritten on injected deps (calm, duress → EX, clear
     mid-wait, SH blocked by EX, SH then duress, ungated, abort releases), plus a
     real-flock test that a duress admission waits for a shared holder.
   - barrel exports, exempt entry stays (fs.watch).
3. **`build`** — `app-artifacts.ts` `acquireAndRunHeavySection`: gate → grant →
   shared-and-duress re-check → REQUEUE (releases both) → loop; `endGrantWait` after
   admission. `HeavyAdmission` comment. `run.ts` valve deps wiring (`waitEnd` result).
4. **Docs** — op-runtime / op-log / op-gantt CLAUDE.md prose naming fail-open or the
   valve semantics; op-log keeps `fail-open` + `requeue` vocabulary for historical rows.

## Verification

- `./singularity test plugins/packages/plugins/flock plugins/framework/plugins/cli/plugins/op-runtime plugins/debug/plugins/profiling/plugins/op-log`
- `./singularity build` (checks: type-check, eslint, boundaries, data-dirs, docs in sync).
- Manual: `setDuress` via a script while two worktree builds run → the second build
  logs "held … waiting for the running build" and starts once the first finishes;
  clear the latch → a waiting build proceeds shared.
