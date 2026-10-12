# upstream

The repo this checkout was cloned from, watched.

Everything else in this app is offline: agent worktrees branch off the local
`main`, main rebuilds itself when that ref moves, and the pushes ledger reads
local `main` only. So for someone who cloned this repo rather than authoring it,
upstream can move for months in complete silence. This plugin is the one place
that notices.

- `core/`: `fetchUpstreamStatus(root)` — resolve upstream (via
  `infra/git/remotes`), fetch it, and answer how far behind local `main` is, as
  `no-upstream` / `unreachable` / `current` / `behind`. It lives in `core/` because two runtimes
  ask the same question: `./singularity upstream status|merge`
  (`framework/cli/plugins/upstream`) and the daily job here. One definition, so
  the command a user runs by hand and the report that wakes them up can never
  disagree about what "behind" means. It fetches — a count against a stale
  remote-tracking ref is a number that looks current and is not.
- `server/internal/detect-job.ts`: the daily `upstream.detect-updates` job. Main
  only (no `perWorktree` on the schedule) — "is there an update?" is a question
  about the clone, not about one agent's branch.
- `server/internal/report-kind.ts`: the `upstream-updates-available` kind.
- `server/internal/merge-automation.ts`: the **Upstream merges** automation
  (`upstream-merge`, see below).
- `shared/merge-prompt.ts`: the task text — one template
  (`UPSTREAM_MERGE_PROMPT`: `{{updates}}`, `{{ref}}`, `{{pushPolicy}}`), the
  automation's default prompt, filled with "do not push" for Investigate.
- `shared/config.ts`: the automation's config document
  (`config/tasks/automations/upstream-merge.origin.jsonc`).

## The report files no task; the automation does

An update is news. The job records a report; the bell rings; Debug → Reports
holds a row with an **Investigate** button, and pressing it mints the task —
carrying the merge instructions from `merge-prompt.ts`, ending on "do not push".
The job itself merges nothing and touches no working tree.

The **Upstream merges** automation (Automations pane; off by default — daily at
07:00 local and Push = never once turned on) is the hands-off path for a clone user: it asks
`fetchUpstreamStatus` itself and, when `behind` with no merge task open, files
ONE auto-started task (Upstream category) whose agent merges in its own
worktree, builds and checks the app. It lands the change only as far as Push
allows — by default it raises a flag and the user lands it, because an upstream
merge is a change to the user's own trunk. The filed task is linked to the
rolling report, so Investigate does not mint a second one. On the canonical
repo (`no-upstream`) and offline (`unreachable`) it files nothing.

## Being offline is not an incident

`unreachable` is its own arm, and the job returns on it **without filing
anything**. It learned nothing about whether updates exist, so it has nothing to
report, and a weekly "we could not check" row is a bell the user learns to
ignore. Do not fold it into `current` (that reports "no updates" on a question
nobody answered) or into `no-upstream` (that denies the remote exists).

Which git failures count as "could not ask" is `isCouldNotAsk` in
`core/internal/status.ts`: `unreachable` and `no-credentials` yes, `denied` and
`unclassified` no — a remote that recognised us and refused the read is a broken
configuration that will not fix itself. The classification itself is
`classifyRemoteFailure` from `infra/git/remotes`, shared with push's write probe.

## One rolling row

The report's fingerprint is a **constant**, not the newest sha. "You are behind
upstream" is one standing fact whose count rises, not a new problem per commit —
and a sha-derived fingerprint would mint a fresh row and a fresh alert every
time upstream moved, which is exactly the cross-fingerprint fan-out the reports
ceiling exists to collapse. Each detection lands on the same row and refreshes
its payload, so the row always names today's count and today's newest commits.

Read that row's own `count` column as "how many days running this has been
true" — the commit count is in the payload, not there.

## Migrations after a merge

Both sides' migrations are published (upstream's on `<remote>/main`, the user's
on local `main`), so the merge renames, deletes and re-hashes none of them. Their
snapshot chains fork at the merge base; the first `./singularity build` (or
push's normalize) after the merge joins them with a **merge node** — a no-op
migration whose snapshot is the 3-way merge of the two tips — and fails, naming
the schema paths, when both sides changed the same column differently. See
`database/migrations/CLAUDE.md` → **Merge nodes**. `shared/merge-prompt.ts` tells the
agent to keep the node and to stop and report on a conflict.

## What it does not do yet

The row never clears itself. Once the user merges, the next day's job records
nothing new, but the existing row stays until retention drops it. If that starts
reading as stale, the job should resolve the row when the count reaches zero.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Registers the Upstream merges automation's config (schedule, push policy, model, prompt template) for the Automations pane and Settings → Config. Daily upstream.detect-updates job (main only): when the repo this checkout was cloned from has commits local `main` does not, it records one rolling `upstream-updates-available` report — the bell and Debug → Reports, whose Investigate mints a merge task. And the Upstream merges automation (upstream-merge; off by default, daily once on, editable from the Automations pane): when upstream is ahead and no merge task is open, it files ONE auto-started task (Upstream category, linked to the report) whose agent runs `./singularity upstream merge`, builds and checks the app, and lands it only as far as its Push setting allows (never, by default).
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "upstream-merge"
    - `Automations.Config` "upstream-merge"
  - Uses: `tasks/automations.automationConfigContributions`
- Server:
  - Contributes:
    - `report-kind` "upstream-updates-available"
    - `ConfigV2.Register` "upstream-merge"
    - `taskCategory` "upstream"
  - Uses:
    - `infra/jobs.defineJob`
    - `primitives/log-channels.Log`
    - `reports.linkReportsToTask`
    - `reports.recordReport`
    - `reports.ReportKind`
    - `reports.uninvestigatedReports`
    - `tasks/automations.automationConfigRegistration`
    - `tasks/automations.defineAutomation`
    - `tasks/task-category.TaskCategory`
  - Exports (types): `UpstreamUpdatesPayload`
  - Exports (values):
    - `UPSTREAM_UPDATES_KIND`
    - `upstreamUpdatesKind`
  - Register:
    - `defineJob('upstream.detect-updates')`
    - `defineAutomation('upstream-merge')`
- Core:
  - Uses:
    - `infra/git/remotes.classifyRemoteFailure`
    - `infra/git/remotes.RemoteFailure`
    - `infra/git/remotes.resolveUpstreamRemote`
    - `infra/spawn.spawnCaptured`
    - `infra/spawn.spawnExpectOk`
    - `infra/spawn.SpawnFailedError`
  - Exports (types):
    - `UpstreamCommit`
    - `UpstreamStatus`
  - Exports (values):
    - `fetchUpstreamStatus`
    - `UPSTREAM_BRANCH`
    - `UPSTREAM_SUBJECT_LIMIT`

<!-- AUTOGENERATED:END -->
