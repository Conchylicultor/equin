# `./equin push` hands its post-rebase steps to the rebased code

## Context

`./equin push` rebases its own checkout onto main mid-run, then keeps running as the
**pre-rebase process**. From the rebase on, one push mixes two versions of the code:
children (checks, `./equin` sub-calls) run the new tree, while the push process runs the
old one — yet still reads the tree by path (`flock-wait.ts` spawned by path, lazy
`import()`s) and relies on on-disk layout (`process.execPath`).

Incident, 2026-11-06, push op `cc13eee2…` (conv-1793899737-c2ukls): the rebase brought in
`f77bd3e8b7` (process-name: per-verb machine-wide named Buns). The new code, run by a
sub-`./equin`, deleted the old per-checkout name `equin-bun/equin · push · <checkout>` —
the push process's own `process.execPath`. The push's next spawn (main's tree-lock flock
helper, before `git merge --ff-only` into local main) failed with ENOENT: origin/main moved,
local main did not. That cause is a one-off; the **class** (any change to something an
older running push depends on breaks the push that lands it) recurs. Old worktrees are out
of scope (user decision): only future breaking changes matter.

Goal: every step after the rebase runs on the rebased code, while the push mutex and the
interactive host grant stay held — no re-queue.

### Measurements (2026-11-06)

- Push's import closure: 490 modules static, 1,849 following dynamic imports; computing it
  costs 0.1–0.7 s. But 35 % (static) / 57 % (dynamic) of single main commits touch it, at
  ~100 commits/day → a "did the closure change?" gate fires on ~every push. **No gate:
  always hand off.**
- Releasing the mutex to restart: over 436 pushes in 7 days, p50 mutex wait 6 s, p90 6 min,
  and 31 % had another push land while queued (up to 7) → a restart would rebase again and
  usually need another restart. **The mutex must stay held.**
- A bare `./equin` start (warm): ~0.8 s — the handoff's added cost.

## Lock handoff: options considered

| Option | Verdict |
|---|---|
| **Parent stays the holder; the child runs inside the hold** | **Chosen.** Already how the grant reaches the checks: `grant.env()` → child's `inheritedGrant()` (`host-admission/server/internal/grant.ts:192`), `withDirectOp` "nested" (`op-runtime/cli/direct-op.ts`). The mutex needs nothing to cross processes: the parent holds it (its own fd uncontended, a `flock-wait` child contended) and releases it when `pushPool.run` returns. Parent death kills the child (orphan guard, 2 s) and frees both — the lifetimes stay tied. |
| Child inherits the flock fd | Rejected. No fd-passing exists (`OwnedFd` is close-on-exec, `Bun.spawn` lint-restricted); a contended push holds the lock through a `flock-wait` child's stdin pipe, not an fd; and the parent must stay alive anyway, so it buys nothing over the chosen option. |
| `execve` the new code in place (FFI), adopting fds via env | Rejected. Same pid and lock, but needs non-CLOEXEC fds + pipes, an adoption protocol for the profiler/marker/helpers, and an exec of the old named binary path — the very path that vanished. Fragile for no gain. |
| Release the mutex, re-run `./equin push` | Rejected by the measurements above. |
| Rebase/check in a scratch worktree, never touch the running checkout | Rejected: a fresh worktree costs an install + normalize per push. |
| Dedicated detached holder process / lease | Rejected: a lock that outlives its taker is against the flock plugin's design; nothing needs it here. |

## Design

**One rule: after the rebase, the push driver (old code) does nothing but spawn the land
phase, await it, and record the result.** No step, spawn, lazy import or tree read of its own.

### Driver (pre-rebase process) — `push/cli/run.ts`

Unchanged up to and including the rebase (both arms that produce the landing shape —
`containsMain` amend and the ordinary rebase — and the from-main path's rebase). Then,
still inside `withPushLock`'s `fn(grant)`:

1. Spawn `./equin push` (the shell script — **never `process.execPath`**) via
   `spawnPassthrough` (`infra/spawn`), cwd = checkout root, env =
   `{ ...process.env, ...grant.env(), EQUIN_FROZEN_LOCKFILE: "1", EQUIN_PUSH_LAND: <json> }`.
2. Await it; read its land report (below); `profiler.recordStep(...)` each reported step;
   `profiler.complete(<reported outcome>)`; exit with the child's code.

Always — no closure gate (see Measurements). The `containsMain` arm hands off too: one path,
exercised on every push.

The driver's current post-rebase code (install, normalize, checks, push-branch,
push-main, ff local main) moves out of `run.ts` into the land phase. `bun-install` disappears
as a push step: the child's bootstrap (`bin/index.ts` → `ensureDeps`) installs the rebased
lockfile, on the new code, frozen via `EQUIN_FROZEN_LOCKFILE` (existing).

### Land phase (rebased process) — new `push/cli/land.ts`

Entered when `EQUIN_PUSH_LAND` is set (env-driven, like `check --run-id`; no hidden-command
concept exists and the manifest stays unchanged). Refuses loudly unless:
- `inheritedGrant()` is defined (it runs under a parent's grant), and
- the push mutex slot is held (`slotHeld` / pool probe, `host-admission/server/internal/pool.ts:35`),
- the payload's `v` is one it knows.

It creates **no** profiler, marker or mutex request (the "nested" rule of `withDirectOp`),
installs `installFatalSignalExit` for a graceful exit, then runs: normalize (force) →
checks (`runRebasedChecks`, grant from `inheritedGrant()`) → push-branch → push-main →
ff local main under `withTreeWrite`. Same messages and failure guidance as today.

State it needs is **re-derived, not handed over** wherever possible: `branch`, root,
`mainWorktree` (git), `publish` (`resolvePublishTarget`, cached probe). Only what cannot be
re-derived crosses: the payload `EQUIN_PUSH_LAND = {"v":1,"pushId":…,"report":<path>}`.

### Land report (child → parent) — the op log keeps ONE writer

The op profiler is single-writer per op (`seq` is per process; two `completed` events
collide — `op-log/server/internal/profiler.ts`). So the parent stays the sole writer and the
child writes a report file at `report` (under the worktree data dir's `ops/`, next to the
marker): `{ v:1, outcome: "success"|"failed_checks"|"error", steps: [{name, startedAtMs,
durationMs}] }`, written as each step ends (a crash leaves the steps done so far).
Parent: `recordStep` each; outcome from the report, else `"error"` when the child exited
non-zero without one. Check-span detail keeps flowing as today (`--run-id` /
`readCheckProgress` inside the child's `runRebasedChecks`).

### The cross-version contract, made explicit

Driver (version N) ↔ land phase (version N+k) share exactly: the `./equin push` entry, the
`EQUIN_PUSH_LAND` payload, the report file, and the grant env (already shared with checks).
All three new shapes carry `v`; a land phase that sees an unknown `v` fails loudly naming
it, and changing a shape means bumping `v` with the old one still accepted for a while. A
`push/cli/handoff-contract.ts` holds the schemas (zod) and is the one file both sides import.

### Where the from-main path fits

Same structure: its own rebase, then the same handoff (`land.ts` takes `mode` from the
payload; from-main publishes with `git push` instead of the merge into main).

## Files

- `plugins/framework/plugins/cli/plugins/push/cli/run.ts` — driver: post-rebase steps
  replaced by the handoff; dispatch to `land.ts` when `EQUIN_PUSH_LAND` is set.
- `plugins/framework/plugins/cli/plugins/push/cli/land.ts` (new) — the land phase.
- `plugins/framework/plugins/cli/plugins/push/cli/handoff-contract.ts` (new) — payload +
  report schemas, report writer/reader.
- `plugins/infra/plugins/host/plugins/host-admission/server` — export a "push mutex held"
  probe if `slotHeld` is not reachable from the barrel.
- `plugins/framework/plugins/cli/plugins/push/CLAUDE.md` — the driver/land split and the
  one rule.

Reuse: `spawnPassthrough` (`infra/spawn/core`), `grant.env()` / `inheritedGrant()`
(host-admission), `runRebasedChecks` / `runCheckSubprocess` (`op-runtime/cli/check-subprocess.ts`),
`normalizeGeneratedArtifacts`, `withTreeWrite`, `publishMain`, `profiler.recordStep`,
`installFatalSignalExit`.

## Risks

- **The driver's own post-rebase code still runs old**: the await + report read +
  `profiler.write()`. Keep it minimal and statically imported (no lazy import after the
  rebase); a regression there is the one remaining exposure.
- **Op-log consumers** reading `summary.steps` see `bun-install` disappear (now part of the
  child's start-up). Check the push-step dashboards / slow-op readers.
- **Lost output ordering**: the child inherits stdout/stderr (`spawnPassthrough`), so the
  user-visible log is unchanged.

## Verification

- Unit (`./equin test plugins/framework/plugins/cli/plugins/push`): payload/report schemas
  round-trip and reject an unknown `v`; land refuses without an inherited grant or held mutex.
- **End-to-end, the incident shape** — new `push/e2e/post-rebase-handoff.ts` on the
  temp-repo pattern of `plugins/upstream/e2e/migration-journey.ts` (a clone of this tree,
  real CLI): branch a worktree, then land on the clone's main a commit that (a) changes a
  land-phase message and (b) deletes the file the OLD driver would have spawned after the
  rebase. Push from the worktree: it must succeed, print the NEW message, and leave local
  main == remote main.
- Real push of this change, then confirm in `op_log_ops` that the op carries the child's
  steps and a single `completed`.
