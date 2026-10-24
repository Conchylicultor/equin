# Reap a dead build's open `build_runs` row at claim time

## Context

A hand-run `./equin build` mints its own `build_runs` row
(`recorder.insertRun`, `plugins/framework/plugins/cli/plugins/build/cli/run.ts:1065`).
Only two paths close it: the success path (`closeRun(buildId, 0)`, ~line 1543)
and the failure-verdict funnel (~line 1400). Every other ending leaves the row open:

- a `process.exit(n)` from inside a step (e.g. `generateAppSources`' exit 2 / exit 1),
- a thrown error that unwinds to `runCli`,
- a catchable signal, and a SIGKILL.

The `process.on("exit")` backstop cannot help. It runs only synchronous code, and
`closeRun` is a database write.

The open row holds `build_runs_inflight_uniq`. Only the backend's supervised-run
reconciler closes it, and that runs on backend boot. A failed build does not
restart the backend. So until some build succeeds far enough to restart it:

- every later manual build hits the index, prints `already has a build in flight —
  no ledger row minted`, and records no history;
- every UI / auto build request is silently dropped (`claimBuildRun` returns
  `false`).

Observed 2026-09-16 in `att-1789472390-n157`: row `931c0e0b4-1789568802673`
stayed open ~87 min. Its `build-logs-<id>.json` said `exitCode 1` at 14:27:06.
The build that finally recovered has no row.

Patching each exit site does not fix this, and it misses SIGKILL anyway. The
general problem: **only the backend can tell that the build holding the lock is
dead, and it only looks at boot.** The fix is to have **whoever is blocked by the
lock** decide whether the holder is dead, using the same rule the supervised
reconciler already uses.

## Design

### The rule (same as `settleRun` in supervised-job's `supervisor.ts`)

```
terminal = build's own terminal record  ??  (isPidAlive(pid) ? STILL RUNNING : hard kill -1)
```

- **The build's terminal record already exists:** `build-logs-<buildId>.json`
  (`worktreeArtifacts.buildLogs(ns, id)`). `writeBuildLogs` is synchronous and
  runs on every graceful ending: the ok verdict, the failure verdict, and the
  exit-hook verdict guard's `onFallback`. That covers early `process.exit`, throws
  and catchable signals. It carries `exitCode`, and the file's mtime is when the
  build ended. So the row gets the **real** exit code and end time, not
  `-1`/"now". It plays the same role as a supervised run's exit marker.
- **No record + dead pid** means a SIGKILL. Close it with `HARD_KILL_EXIT_CODE`
  (`-1`) and the current time.
- **No record + live pid** means the build is really running. Leave the row alone.
  That is today's "lost" outcome.

### Where it runs: at the claim, in both claimants

Both claimants are the CLI's `insertRun` (manual builds) and the backend's
`claimBuildRun` (UI / auto builds). When either gets `23505` on
`build_runs_inflight_uniq`, it:

1. reads the holder row for this namespace (`id, pid`, `finished_at IS NULL`);
2. applies the rule above;
3. if the holder is dead, closes it with the existing first-writer-wins UPDATE
   (`where id = ? and finished_at is null`), then **retries the INSERT once**;
4. otherwise returns lost / `false`, as today.

Why this is race-safe, when the old pid pre-check (see the comment in `tables.ts`)
was not:

- **The index still decides every race.** Reaping happens only *after* losing the
  insert, and only for a pid that is provably dead. A dead process cannot come back
  to life.
- **Two claimants reaping the same row is harmless.** One UPDATE writes and the
  other matches nothing. Both retry, and the index picks exactly one winner.
- **A reused pid only reads as "alive".** That falls back to today's behavior and
  can never close a live build. When the log file exists, it answers before the
  pid is even checked, which was the case in the incident.
- **A UI build's row starts with the backend's own live pid** (see the
  `claimBuildRun` docblock), so the window before the child is spawned is never
  reaped.
- **The reaper adds no new state.** Boot reconcile already closes a row whose pid
  is dead. This just does it at the moment the lock is actually blocking someone.

### One shared implementation, in the run-ledger leaf

Add one function to `plugins/build/plugins/run-ledger/server/` (new
`internal/stale-holder.ts`, exported from the barrel):

```ts
/** Close this namespace's in-flight row iff its build provably ended. true ⇒ caller may retry the claim. */
export async function settleDeadInflightRun(db: NodePgDatabase, namespace: Namespace): Promise<boolean>
```

It uses:

- `isPidAlive` and `HARD_KILL_EXIT_CODE` from
  `@plugins/infra/plugins/jobs/plugins/supervised-job/core`. That barrel
  deliberately touches no DB and no jobs, so the leaf stays safe to load from the
  CLI. Verify the leaf's import rule in its `CLAUDE.md` still holds, and update the
  prose to name this edge.
- `worktreeArtifacts.buildLogs` from `@plugins/infra/plugins/paths/core`.
- a small `readBuildTerminal(ns, buildId): { exitCode, finishedAt } | null`, in the
  same file. It zod-parses only `exitCode` from the JSON, and `finishedAt` is the
  mtime from `statSync`. A missing file returns `null`. A malformed file
  **throws**, because it is a real fault and not "no record".

It is called from:

- `createBuildRunRecorder.insertRun` (`run-ledger/server/internal/recorder.ts`),
  on `isUniqueViolation`, followed by one retry of the hand-written INSERT.
  Tighten the check to also match `constraint === "build_runs_inflight_uniq"`,
  as `run-state.ts` already does, so an id collision is never read as "in flight".
- `claimBuildRun` (`plugins/build/server/internal/run-state.ts`), on
  `isInflightViolation`, followed by one retry. It passes its namespace-bound `db`.
  Its signature is already `NodePgDatabase`-compatible; confirm while
  implementing.

`closeBuildRow` / `closeRun` stay exactly as they are. The reaper reuses the same
guarded UPDATE shape. It stamps only `finished_at` and `exit_code`, so it stays
safe against the schema-skew hazard `recorder.ts` documents.

### Explicitly not done

- **No async close in the exit hook** (e.g. a sync child process running `psql`).
  The log file already is the synchronous terminal record, and SIGKILL would still
  need the reaper.
- **No periodic sweep.** It would be polling, and it is unnecessary: the row only
  matters when someone is blocked on it, and that someone now settles it.

## Files

- `plugins/build/plugins/run-ledger/server/internal/stale-holder.ts` — new:
  `settleDeadInflightRun` and `readBuildTerminal`.
- `plugins/build/plugins/run-ledger/server/index.ts` — export it.
- `plugins/build/plugins/run-ledger/server/internal/recorder.ts` — settle and retry
  in `insertRun`, plus the constraint-name check. Update the docblock: "lost" now
  means *a live build holds it*.
- `plugins/build/server/internal/run-state.ts` — settle and retry in `claimBuildRun`.
- `plugins/build/plugins/run-ledger/CLAUDE.md` — a short section on the claim-time
  settle and the build-logs file as the terminal record. Name the
  `writeBuildLogs`-on-every-graceful-exit dependency, and add one line next to
  `writeBuildLogs` (`op-runtime/cli/build-logs-writer.ts`) saying the ledger now
  reads that file.
- `plugins/framework/plugins/cli/plugins/build/cli/run.ts` — adjust only the "lost"
  soft-note wording ("a live build … holds the slot").

## Verification

1. **Unit / DB tests** (`./equin test plugins/build/plugins/run-ledger`),
   using the `database/db-test-fixture` throwaway DB and a temp worktree data dir:
   - open row + `build-logs-<id>.json` with `exitCode 1` → the row is closed with
     `exit_code 1` and `finished_at` = the file's mtime; the new insert is
     `"claimed"`;
   - open row, no log, dead pid (a spawned-and-reaped child) → `exit_code -1`,
     `"claimed"`;
   - open row, no log, live pid (`process.pid`) → `"lost"`, row untouched;
   - malformed log → throws.
2. **Repro end-to-end in this worktree.** Make a manual build fail early (e.g. an
   invalid `--migration-answers` value that exits after the mint, or a temporary
   throw in stage 2). Then:
   - check with `query_db` that the row is open;
   - run `./equin build` again (in the background) with the fault removed;
   - expect no "already has a build in flight" note;
   - expect the old row closed with exit 1 and its real end time, and the new row
     present and closed with 0.
3. `./equin check` (type-check, plugin-boundaries, plugins-doc-in-sync).
