# Orphaned CLI ops (push / check / build) must self-terminate

## Context

A `./equin push` whose invoking shell / agent pane dies keeps running
forever (reparented to pid 1). During the 2026-07-21/22 op-wedge incident, one
orphaned push sat **queued on the global push mutex for 11 hours**, and stale
orphaned pushes repeatedly grabbed the mutex ahead of live agents' retries. The
push mutex is the most serialized resource on the box (`pushPool` =
`defineHostPool({ id: "push", size: 1 })`), so a single orphan-hold stalls every
agent's push host-wide.

Builds already solved this: `build.ts` polls its own `ppid` and exits (code 140)
when reparented to pid 1, because macOS has **no `PR_SET_PDEATHSIG`** — a child
cannot ask the kernel to signal it when its parent dies, so it must poll. Push
and check have no equivalent, so an abandoned op contends for a host resource
indefinitely.

### The exposure is wider than "push has no guard"

**Check shares the exposure.** A direct `./equin check` that is orphaned
holds its host-CPU admission grant (`withHostGrant`, another `flock`-based host
pool) until killed — same failure mode, different lock.

**Build's own guard is currently DEFEATED by the inspector re-exec.** The
recently-added pre-armed inspector (`inspect.ts`, commit `12efa0e37`) re-execs
every op command once:

```
shell (agent pane / Bash tool)
 └─ bun index.ts push          ← WRAPPER  (ppid = shell)   — maybeReexecUnderInspector, blocks on child.exited
     └─ bun --inspect index.ts push   ← WORKER (ppid = WRAPPER) — runs the command + holds the lock
```

`build.ts`'s inline `ppid`-poll (build.ts:897-901) runs in the **worker**, whose
parent is the **wrapper**, not the shell. When the shell dies, the *wrapper*
reparents to pid 1 (its `ppid` → 1) but **stays alive** blocking on
`child.exited`; the worker's `ppid` stays pointed at the (living) wrapper and
**never becomes 1**. So the worker's poll never fires. Build is exposed in the
default (inspector-on) configuration exactly like push and check.

**Conclusion:** the orphan-poll must live in the process whose parent is the
shell — the **outer wrapper** — and it must actively tear down its inspected
child. This is one shared mechanism for all three ops, not three inline copies.

## Design

A single shared helper, armed in two places, plus graceful teardown so the
kill releases the lock cleanly.

### 1. New shared helper — `plugins/framework/plugins/cli/bin/orphan-guard.ts`

```ts
// macOS has no PDEATHSIG, so a foreground CLI op reparented to pid 1 (its
// invoking shell / agent pane died) would otherwise run forever — holding or
// queuing on a host lock. The push mutex is the worst case: one serialized slot
// host-wide, so a single orphan-hold stalls every agent's push. Poll ppid;
// when it becomes 1 (orphaned), run onOrphan. unref() so the timer never itself
// keeps the process alive.
export const ORPHAN_EXIT_CODE = 140; // 128 + 12

export function installOrphanGuard(onOrphan: () => void): void {
  // The detached self-restart build (build/run-build.ts) sets this and INTENDS
  // to outlive the backend it restarts — it must never self-terminate on reparent.
  if (process.env.SINGULARITY_BUILD_DETACHED) return;
  if (process.ppid === 1) { onOrphan(); return; } // already orphaned at launch
  setInterval(() => {
    if (process.ppid === 1) onOrphan();
  }, 2000).unref();
}
```

### 2. Arm in the outer wrapper — `inspect.ts` `maybeReexecUnderInspector`

Right after the child is spawned and the signal-forwarding loop (inspect.ts:74-76),
before `await child.exited`. This is the **primary** fix: the wrapper's `ppid`
is the shell, so it is the process that actually observes the orphaning, and it
owns the inspected child it must kill.

```ts
installOrphanGuard(() => {
  child.kill("SIGTERM");        // release the lock via the worker's graceful exit
  process.exit(ORPHAN_EXIT_CODE);
});
```

### 3. Arm the worker/no-inspector backstop — `index.ts`

After the `maybeReexecUnderInspector()` block (index.ts:18-20). Code past that
block runs only when this process runs the command itself — i.e. the inspected
**worker** (backstop: fires if the wrapper is SIGKILLed and the worker reparents
to 1), or the **direct op** when the inspector is disabled
(`SINGULARITY_CLI_INSPECT=0` / kill-switch), where `ppid` is the shell and this
is the primary guard.

```ts
if (isOpCommand(process.argv[2])) {
  installOrphanGuard(() => process.exit(ORPHAN_EXIT_CODE));
}
```

`isOpCommand` = membership in the existing `INSPECTED_COMMANDS`
(`build`/`check`/`push`) set — export it (or a small `isOpCommand` predicate)
from `inspect.ts` so the op set stays single-sourced.

### 4. Remove build's now-dead inline poll

Delete build.ts:892-901 (the inline `ppid`-poll). It is defeated under the
inspector and now redundant with the centralized guard. Keep build's existing
terminal-signal handlers (build.ts:886-890).

### 5. Graceful teardown on push and check

When the wrapper SIGTERMs the worker, the worker must run its on-exit cleanup so
the lock's holder/marker files don't linger. push (push.ts:360) and check
(check.ts:187) register only `process.on("exit", …)`, which does **not** fire on
an unhandled SIGTERM. Mirror build.ts:886-890 in both — register
SIGINT/SIGTERM/SIGHUP/SIGQUIT → `process.exit(code)` so their exit handlers
(`clearPushHolder` + `clearWorktreeOp` for push; `clearWorktreeOp` for check)
run. The `flock` itself is OS-released on death regardless; this just avoids a
stale-holder window and makes the teardown observably clean.

### Why the whole subtree self-heals

push spawns a nested `check --scope tree`, which itself re-execs under the
inspector. When the orphaned push worker is SIGTERM'd and exits, that nested
check subtree reparents to pid 1 and each layer's own guard (armed by the same
`index.ts` / `inspect.ts` wiring) fires — so no descendant lingers. Arming the
guard uniformly for every op invocation is what makes this hold without
per-spawn wiring.

## Files to modify

- **New:** `plugins/framework/plugins/cli/bin/orphan-guard.ts` — `installOrphanGuard`, `ORPHAN_EXIT_CODE`.
- `plugins/framework/plugins/cli/bin/inspect.ts` — arm the guard in `maybeReexecUnderInspector` (child-kill + exit); export `INSPECTED_COMMANDS` / `isOpCommand`.
- `plugins/framework/plugins/cli/bin/index.ts` — arm the worker/no-inspector backstop guard for op commands.
- `plugins/framework/plugins/cli/bin/commands/build.ts` — remove the inline `ppid`-poll (lines 892-901).
- `plugins/framework/plugins/cli/bin/commands/push.ts` — add terminal-signal → graceful-exit handlers (mirror build.ts:886-890).
- `plugins/framework/plugins/cli/bin/commands/check.ts` — same terminal-signal handlers.

## Considerations / trade-offs

- **Mid-push kill.** If a push acquires the mutex and is then orphaned, the
  guard SIGTERMs it mid-flight (up to ~2 s later). A push interrupted mid-merge
  is no worse than a crashed/SIGKILLed push (the flow is re-runnable: fetch /
  `merge --ff-only` / rebase / `push --force-with-lease`), and is vastly better
  than an 11 h lock-hold. This is the same risk build's lock already accepts.
- **2 s latency** matches build's cadence; acceptable given the 11 h status quo.
- **Detached self-restart build** is correctly exempt via the
  `SINGULARITY_BUILD_DETACHED` env check inside the helper — it must outlive its
  spawner.
- **Non-op commands** (`start`, `serve-app`, `db`, `regen-*`) are untouched:
  they are gated out by the `INSPECTED_COMMANDS` set. `start` (gateway) and
  `serve-app` (served composition) are long-lived and must NOT be orphan-killed.

## Verification

1. `./equin build` — confirm the CLI still builds/deploys and the removed
   inline poll causes no type/lint errors. Run
   `bun test plugins/framework/plugins/cli/bin` (covers `admission-valve.test.ts`,
   `build-lock.test.ts`, etc.) plus any new unit test for `installOrphanGuard`.
2. **Orphan repro (push):** start a `./equin push` (e.g. with a trivial
   `-m`) from a shell, then kill the invoking shell/pane (not the push) so the
   push reparents to pid 1. Within ~2 s the wrapper should detect `ppid===1`,
   SIGTERM the worker, and exit 140. Verify with `ps` that no
   `bun … index.ts push` / `--inspect … push` processes remain, and that
   `~/.singularity/push-slots/slot-0.lock` is free (a fresh push acquires
   immediately). Confirm `push-holder.json` is cleared (graceful teardown).
3. **Orphan repro (check / build):** same procedure for `./equin check`
   (host-CPU grant released) and `./equin build` (build lock released) —
   verifying the previously-defeated build case now self-terminates under the
   inspector.
4. **Kill-switch path:** rerun repro with `SINGULARITY_CLI_INSPECT=0` (no
   re-exec, command runs in the wrapper directly) — the `index.ts` backstop
   guard must fire.
5. **Detached build unaffected:** trigger a normal in-app build (the detached
   self-restart path with `SINGULARITY_BUILD_DETACHED=1`) and confirm it still
   completes across the backend restart (guard correctly exempt).
