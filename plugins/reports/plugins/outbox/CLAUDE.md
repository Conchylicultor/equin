# outbox

How a process with **no server** files a report — a `./singularity` CLI run, a
supervised child. `recordReport` is a Postgres write inside a backend; a CLI
process has neither. So the process writes the report into a host-global
directory, and main's backend records it.

Plan: wiki page `block-ff91e68c-c8d9-4d92-928a-ba1edf2f1107` ("check thread
stalls file reports").

## Writing: `fileReportFromProcess` (core)

```ts
await fileReportFromProcess({ kind, message, data, code? });
```

- **One JSON file per report**, in `~/.singularity/state/report-outbox/`
  (`data-dirs/`). Written under a dot-prefixed temp name, then renamed, so the
  reader never sees half a file.
- **Never throws, never rejects.** Its callers are diagnostics next to real work
  (the check runner's thread watch). A failed write prints one loud
  `console.error` line and comes back as `{ outcome: "failed" }`.
- **Bounded:** at 1,000 undrained entries it refuses, with a line saying why.
  That happens when main has been down a long time. Entries waiting for an
  unmerged kind (see the drain below) count toward the cap too, for up to 14
  days each.
- **Stamps its repository** (`writer.repo`, `repositoryOf`: the realpath of the
  writer's main checkout). The outbox is host-global, so another clone on the
  machine writes into it too — `upstream`'s migration-journey e2e runs
  `./singularity check` in a temp clone — and the drain must know whose code an
  entry names.
- Node-only and DB-free, so the check runner (`core → core`) can import it.
- `kind` should be a `ReportKind` registered on main, and `data` must pass that
  kind's schema — both are checked at the drain, not here.
- `await` it before the process can exit. A write still in flight at
  `process.exit()` is a report lost.

## Reading: the drain (server, main only)

`server/internal/watcher.ts` drains the directory once in `onReady`, then on
every change its `reportOutboxWatcher` (a main-only `defineFileWatcher`) reports. No timer: a write is the signal. It is
main-only because the directory is host-global and one reader is the whole
design — a worktree backend would race main and file under its own namespace.

For each entry, oldest first (`server/internal/drain.ts`):

1. Parse it (`OutboxEntrySchema`).
2. **Is its kind registered on main?** If not, a branch added the kind and has
   not merged yet — that is not a failure. The entry is left in place (logged
   once per process) and filed by the first drain after the kind reaches main.
   Once it is older than `UNKNOWN_KIND_TTL_MS` (14 days), the branch is taken
   as abandoned: the entry is deleted with a log line naming the kind and the
   writer's checkout, and no report is filed.
3. **Another repository's entry** (`writer.repo` is not main's) is filed
   WITHOUT the staleness rule — main cannot judge another repository's code
   against its own history — and its message is suffixed with where it came
   from and that it was not checked. Never dropped: an issue is never silenced.
   (The note goes in the message, not `data`: each kind owns its payload's
   schema, and kinds fingerprint `data`, so it does not split a row.)
4. Otherwise apply the **staleness rule** when it carries `code`.
5. `recordReport({ kind, source: "cli", message, data, occurredAt })`.
6. Delete the file.

**An entry that cannot be filed** — bad JSON, a shape the envelope schema
rejects, a payload a KNOWN kind's schema rejects, a staleness check that cannot
decide — is filed as a `server-caught` crash report carrying the error,
and then deleted. It is never retried forever. Only if that crash report ALSO
fails (the database is down) is the entry left for the next pass.

The `cli` source is server-only (`reports/core/sources.ts`), so the browser
endpoint cannot claim it.

## The staleness rule: don't file from out-of-date code

Most worktrees are behind main, so "only file from the tip of main" would drop
nearly every report. Instead an entry carries `code = { mergeBase, paths }`: the
writer's `git merge-base HEAD main` (`mergeBaseWithMain`) and the repo files the
report is about. Main runs `git diff --name-only <mergeBase> main -- <paths>`:

- **Nothing changed** → filed. The code still exists on main as the writer saw
  it. That includes a problem the writer's own branch introduced — exactly the
  regression a report should name.
- **Something changed** → dropped, with one log line naming the files: main may
  already have fixed it.
- **The merge-base is not a commit of this repository** (`git cat-file -e`,
  checked first) → depends on the writer. One stamped as THIS repository: a
  broken assumption, so a crash-style report. One unstamped (a writer older
  than `writer.repo`): main's history never loses a commit and every worktree
  shares main's refs, so it came from another repository — filed with the
  same origin note, naming the missing commit.
- **git fails** otherwise (a git error, a timeout) → a crash-style report.
  "Cannot tell" is never evidence for either verdict.
- **Empty `paths`** → filed. No code is named, so there is nothing to compare.

Blind spot: a fix made OUTSIDE the named files (say, in a shared runner) still
lets older branches file, until they rebase. The rule errs toward reporting,
never toward silence.

The rule belongs to the outbox, not to any kind: every future CLI report can
pass the same `code` field.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Report outbox drain: on main only, records every report a process with no server (a CLI run, a supervised child) wrote into the host-global outbox — once at boot, then on each file change (no polling). An entry whose code main has changed since the writer's branch point (git diff of its paths) is dropped and logged; one from another repository (the writer stamps its own) is filed without that check, its message saying where it came from; an entry that cannot be filed (bad JSON, unknown kind, rejected payload, undecidable staleness) becomes a server-caught crash report and is deleted.
- Server:
  - Uses:
    - `infra/file-watcher.defineFileWatcher`
    - `infra/file-watcher.FileWatcher`
    - `reports.isReportKindRegistered`
    - `reports/engine.recordReport`
  - Register: `defineFileWatcher('reports-outbox.outbox-dir')`
- Core:
  - Uses:
    - `infra/paths.REPO_ROOT`
    - `infra/spawn.getMainRepoRoot`
    - `infra/spawn.spawnCaptured`
  - Exports (types):
    - `FileReportOutcome`
    - `MergeBaseResult`
    - `OutboxCode`
    - `OutboxEntry`
    - `ProcessReport`
  - Exports (values):
    - `fileReportFromProcess`
    - `isOutboxEntryName`
    - `isOutboxTempName`
    - `mergeBaseWithMain`
    - `OUTBOX_MAX_PENDING`
    - `OutboxCodeSchema`
    - `OutboxEntrySchema`
    - `repositoryOf`
- Cross-plugin:
  - Imported by: `framework/tooling/checks`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `core/internal/file-report.ts`, `server/internal/drain.ts` (debt)

<!-- AUTOGENERATED:END -->
