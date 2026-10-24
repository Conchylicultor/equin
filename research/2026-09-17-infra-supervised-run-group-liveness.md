# Supervised run liveness: judge the process group, not the wrapper pid

## Context

Every supervised run is spawned as `/bin/sh -c <shim> …argv`, `detached: true`.
The ledger row stores the shim's pid. Because the spawn is detached, that pid is
also the **process-group id**, and the real worker (`bun … supervised-exec …`,
`./equin build`, …) lives inside that group.

Two things read that pid, and they disagree about what it means:

- **Kill** (`killSupervisedRun`) already treats it as a group: `process.kill(-pid)`.
- **Liveness** (`isPidAlive` in `core/internal/terminal.ts`) treats it as one
  process: `process.kill(pid, 0)`.

So when only the shim dies (a lone `kill -9 <row pid>`), the close rule
`!(terminal == null && isPidAlive(pid))` sees "no marker, pid dead" and closes the
row as a hard kill (`-1`) while the worker keeps running, re-parented to init.
Knock-on effects, all observed on 2026-09-16 with `events-test.detached-sleep`
(wrapper 68081 killed, worker 68082 finished and logged "done"):

1. The row closes as `-1` → the retry ladder starts attempt 2 **while attempt 1
   is still running**. The in-flight lock (partial unique index on unfinished
   rows) was released by that close, so nothing stops it.
2. `settleRun` untracks the run → the transcript tail stops; the worker's later
   lines never reach the channel.

Cancel through the app signals the group and is unaffected.

## Design

### The fix: a run is alive while its process group is

Replace the pid probe with a run-level probe in `core/internal/terminal.ts`:

```ts
/** A supervised run's pid is the pid of its group leader (the shim). */
export function isRunAlive(pid: number | null): boolean {
  if (pid == null) return false;
  return probe(pid) || probe(-pid);   // kill(pid,0) || kill(-pgid,0); EPERM ⇒ alive
}
```

- `probe(-pid)` keeps the run open while **any** process of the group remains —
  the orphaned worker keeps its pgid after re-parenting, so the row stays open,
  the lock stays held, and the tail keeps publishing until the work really ends.
- `probe(pid)` is still needed: rows are **seeded with `process.pid`** (the
  backend's own) at claim time, and the backend is not guaranteed to be a group
  leader, so `kill(-backendPid, 0)` alone could say ESRCH for a live seed.
- Bonus: while a group is non-empty its id cannot be handed out as a new pid, so
  the "recycled pid reads as alive" blind spot does not get worse — it narrows.

**Make the wrong probe unspellable (rung 1):** remove `isPidAlive` from the
plugin's `core` barrel and export only `isRunAlive`. Every supervised-run
liveness decision then goes through the group-aware probe.

Call sites to switch:

- `server/internal/run/supervisor.ts` → `settleRun` (the reconciler / watcher close).
- `server/internal/observe.ts` → `observeRun` (the job workflow's `awaitSupervisedRun`).
- `plugins/backup/server/internal/run-state.ts` → `hasLiveBackup` (same pid, same bug:
  a lone shim kill would let the sweep delete a staging dir still being written).
- `plugins/build/plugins/run-ledger/server/internal/stale-holder.ts` → check whether its
  holder pid can be a supervised shim; if yes switch, if it is only ever a CLI
  process pid, switch anyway (the `pid ||` half keeps it correct) so there is one probe.

While here, do what `observe.ts`'s docblock already asks for: move the close rule
(`terminal ?? (isRunAlive ? running : -1)`) into one exported `core` function
that both `settleRun` and `observeRun` call, so the two statements of the rule
cannot drift again.

### What the outcome becomes after a lone wrapper kill

Only the shim can see the worker's exit status (`wait`), and macOS has no
subreaper, so once the shim is SIGKILLed that status is unrecoverable for an
arbitrary argv. With this fix the run:

- stays **open and running** for as long as the worker lives (no concurrent
  attempt, full transcript);
- closes with the honest `-1` / `signalCode: null` ("nobody witnessed the end")
  once the group is empty.

`-1` stays retryable, so the ladder may still run the body **again, afterwards**
(sequentially — never concurrently). That is the same policy as a genuine hard
kill of the whole group, where success is equally unknowable. Recovering the real
status for `run` bodies (the `supervised-exec` child writing its own outcome as a
second witness) is a separate, optional follow-up — noted, not in scope.

### Edge accepted

A marker-less run now also stays open while a *stray* process that inherited the
group lingers. That only matters after the shim itself was SIGKILLed (with a
marker, the marker closes the run regardless of liveness, unchanged). A group
kill (`kill -9 -pgid`, app cancel, gateway restart) empties the group, so it is
not reachable from any path the system uses.

## Docs

Update `plugins/infra/plugins/jobs/plugins/supervised-job/CLAUDE.md`: the close
rule snippets (`isPidAlive` → `isRunAlive`), a short "Liveness is the process
GROUP" subsection beside "Kill signals the process GROUP", and the pid comment on
`StartedRun` / `LiveRun`. Regenerate the autogen reference via `./equin build`.

## Tests

- `core/internal/terminal.test.ts`: `isRunAlive` — null ⇒ false; own pid ⇒ true;
  reaped detached child ⇒ false; **detached `sh -c 'sleep 30 & wait'` with only
  the `sh` SIGKILLed and reaped ⇒ still true**; after `kill(-pgid, 9)` ⇒ false.
- `server/internal/run/supervisor.test.ts`: real reconciler + fake ledger — start
  a run whose child sleeps and then writes a line, SIGKILL the shim alone,
  reconcile ⇒ row NOT finished and still tracked; after the worker exits, reconcile
  ⇒ finished with `-1`, and the late transcript line was published before `finish`.
- `server/internal/observe.test.ts`: same shape for `observeRun` ⇒ `running` then `ended -1`.
- `loop.test.ts`: attempt 2 is not claimed while attempt 1's group is alive.

Run: `./equin test plugins/infra/plugins/jobs/plugins/supervised-job plugins/backup`.

## Verification end-to-end

1. `./equin build` (background).
2. Enqueue `events-test.detached-sleep` with `seconds: 60`.
3. `kill -9 <supervised_job_runs.pid>` (shim only), confirm the worker survives
   (`ps -o pid,pgid,command -g <pgid>`).
4. `query_db`: the row stays `finished_at IS NULL`; no attempt-2 row appears while
   the worker runs; the channel log keeps receiving `N/60s` lines through "done".
5. After the worker exits: the row closes with `exit_code = -1`; only then may
   attempt 2 start.
6. Regression: cancel a run via the app ⇒ still `143 TERM`, closed promptly.
