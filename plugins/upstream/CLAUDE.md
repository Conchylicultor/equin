# upstream

The repo this checkout was cloned from, watched — by its **releases**.

Everything else in this app is offline: agent worktrees branch off the local
`main`, main rebuilds itself when that ref moves, and the pushes ledger reads
local `main` only. So for someone who cloned this repo rather than authoring it,
upstream can move for months in complete silence. This plugin is the one place
that notices.

Plan: `research/2026-11-17-global-release-updates.md` (phases 1–3).

## Releases, not commits

The author pushes to `main` a hundred times a day, so "behind upstream's main"
is true of every clone all the time — noise. A clone is measured against
**releases** instead: annotated tags `v<YYYY.MM.DD>` (`.2`, `.3`… for another the
same UTC day) on main, cut on purpose with `./equin version cut`
(`framework/cli/plugins/version`), which tags the commit main serves and
refuses unless it is published, newer than every release, and its build passed. The tag grammar is
`plugins/release` (web-safe core).

- `core/`: `fetchUpstreamStatus(root)` — resolve upstream (via
  `infra/git/remotes`), fetch its main and `v*` tags, and answer where local
  `main` stands against upstream's newest release: `no-upstream` /
  `unreachable` / `no-release` / `current` / `behind { current, latest }`.
  Upstream's tags are fetched into their own namespace,
  `refs/release-tags/<remote>/` (force-updated and pruned — a mirror), never
  into `refs/tags/`: a tag of the user's own can neither collide with one of
  upstream's (`refs/tags/` refuses the fetch, "would clobber existing tag") nor
  pass for one. Upstream's releases are those merged into `<remote>/main`. "Behind" means
  `latest` is not an ancestor of local `main`. Also `currentRelease(root, ref)`
  (the newest release in a ref's history — by the release grammar, not
  `git describe`, which answers the nearest tag) and `standingAgainst(root,
latest)` (the local half, no fetch). One definition, because the CLI
  (`upstream status|merge`, `version status`), the daily job and the automation
  all ask it.
- `machine/`: the `upstream.release-status` live value (declared in
  `plugins/release`), the daily `upstream.detect-updates` job and
  `POST /api/upstream/check` and the Upstream merges automation. All three run `checkUpstream()`: fetch, store
  the answer in `upstream_release_check` (one row), notify the value.
- `server/`: the automation config registration, the task category, the table.
- `shared/merge-prompt.ts`: the merge task's text (`UPSTREAM_MERGE_PROMPT`:
  `{{updates}}` — the release and the one this checkout is on, `{{ref}}` — the
  release tag, `{{pushPolicy}}`). No commit list: nothing lists changes.
- `shared/config.ts`: the automation's config document.
- `shared/reminder-config.ts` / `shared/reminder.ts`: the update reminder's
  settings and its pure decision (below).
- `web/`: the health report's updates row and the reminder's action (below).

## The live status: stored answer + git, re-derived

Only what needs the network is stored: upstream's newest release tag (or that
there is none / no upstream) and when it was read. Where local `main` stands
against it is re-derived from git on every read, and the value recomputes on
`refHeadServed` (any tracked ref moving — the edge `build.deployment` uses) and
on each recorded check. So merging the release reads as current the moment
`main` moves, not at the next daily check. Before any check it is `unknown`,
never "up to date". Fetching stays in the scheduled job / the explicit check:
upstream has no change signal a clone can subscribe to.

The old `upstream-updates-available` report kind is retired (a data migration
deletes its rows): the status value replaces it, and the health row and the
reminder take over the bell and Investigate.

## The updates row (health report)

`web/` contributes the health report's `updates` row (phase 2 of the plan). Its
state is derived, never stored (`web/internal/updates-view.ts`, pure and
tested): the release status, the live task about the newest release, that
task's latest run. Whether main serves the release is the status's own
`installed` (machine: the backend's server pin holds the release tag; true
off main; re-read on restart and on an adopted deploy).

| State | Title | Summary | Health |
|---|---|---|---|
| no upstream / no release / never checked / no computer | — | — | `absent`: the row is not drawn |
| behind, no task | equin is out of date | `2026.10.30 → 2026.11.14` | `attention`, ambient: the dot stays green |
| behind, task about it | Update in progress | same | working → `ok` pulsing; at rest / not started → `attention` |
| current, main's backend not built from it yet | Installing | `2026.11.14` | `ok` pulsing |
| current | equin is up to date | `2026.11.14` | `ok` |

- **Send agent to update** (the remedy, out of date only) is the standard
  `LaunchAgentPopover`: the Upstream merges prompt (the user's edited one) with
  the on-request push policy and the user's words, filed in the Upstream
  category about `upstreamReleaseSubject(latest)` (`shared/subject.ts`). Never
  automatic.
- **One task per release, whoever files it.** A launch about a subject with a
  live task reuses it; the automation skips a release that already has one and
  stamps the subject on what it files (`onFiled`), so the row follows either.
- **In progress draws the conversation's own status chip**
  (`ConversationStatusChip` from `conversation-view/status`) beside a link to
  it — the row never restates the agent's state.
- **The bell** (`actions`, every state) toggles `shared/reminder-config.ts`
  (`enabled`, `config/upstream/reminders.jsonc`). Having actions, the row never
  folds into System checks.
- "Never checked" is `absent` rather than "Checking…": the first check can be
  a day away, and a grey pulsing dot for a day is a false alarm.

## The update reminder (a notification the user controls)

The user must never be spammed, but hears — rarely — that a release is out.
The daily job, on `behind`, calls `remindOfRelease` (`machine/internal/reminder.ts`),
which writes ONE user notification "equin is out of date" (`2026.10.30 →
2026.11.14`, category Updates) only when `reminderDecision`
(`shared/reminder.ts`, pure and tested) says it is due:

- reminders are `enabled` (the row's bell and the menu's Never share it);
- the release is not the `skippedRelease`;
- no task about the release exists (an update is under way — the row shows it);
- now is past `snoozedUntil`;
- and the release was never brought up, or its last reminder is 30 days old,
  or the user snoozed it after that reminder (the snooze replaces the cadence,
  so "Tomorrow" is tomorrow's check, not a month away). A snooze ends at the
  start of the UTC day it lands on, so the daily 05:00 UTC check of that day
  picks it up whatever hour the user clicked.

"Its last reminder" is read from the notifications table (the newest row of
type `upstream-release-reminder` whose metadata names the release, dismissed or
not). Each reminder is its own row; the day in its dedupe key only keeps two
runs of one day's job from writing twice. On `current`, the job settles every
reminder (that release's and every earlier one's) in place (state resolved,
"Updated to …"). The reminder is `info`: it toasts if a page is on screen and
waits in the bell under Updates, never in the unread badge — rare and quiet by
design.

Its action, `equin-update` (`web/components/reminder-action.tsx`, a
`Notifications.Action` `Control` placed `below`), draws — only while that
release is still the update to make — "Send agent to update" (the row's own
launch popover, `SendAgentButton`) and "Remind me later ▾": Tomorrow / In a week
/ In a month write `snoozedUntil`, Skip this release writes `skippedRelease`,
Never turns `enabled` off (`laterWrite`). Each, and a filed launch, calls the
control's `done()`, dismissing the notification — a choice only once its write
was accepted (a refused one, e.g. a config conflict, is announced and the
reminder stays). Audience `user`.

## Being offline is not an incident

`unreachable` is its own arm, and the job returns on it **recording nothing**:
the last answer stands. It learned nothing about whether a release exists. Do
not fold it into `current` (that reports "up to date" on a question nobody
answered) or into `no-upstream` (that denies the remote exists).

Which git failures count as "could not ask" is `isCouldNotAsk` in
`core/internal/status.ts`: `unreachable` and `no-credentials` yes, `denied` and
`unclassified` no — a remote that recognised us and refused the read is a broken
configuration that will not fix itself. The classification itself is
`classifyRemoteFailure` from `infra/git/remotes`, shared with push's write probe.

## The automation

The **Upstream merges** automation (Automations pane; off by default — daily at
07:00 local and Push = never once turned on) asks `fetchUpstreamStatus` itself
(through `checkUpstream()`, so what it acts on is recorded) and, when
`behind` with no merge task open, files ONE auto-started task
(Upstream category) whose agent runs `./equin upstream merge` — which merges
the release tag, never `<remote>/main` — builds and checks the app, and lands it
only as far as Push allows. `no-upstream`, `no-release` and `unreachable` file
nothing.

## Migrations after a merge

Both sides' migrations are published (upstream's on `<remote>/main`, which the
check fetches with the tags; the user's on local `main`), so the merge renames,
deletes and re-hashes none of them. Their snapshot chains fork at the merge
base; the first `./equin build` (or push's normalize) after the merge joins them
with a **merge node** — see `database/migrations/CLAUDE.md` → **Merge nodes**.
`shared/merge-prompt.ts` tells the agent to keep the node, to resolve every
conflict itself (a schema decided in its `schema.ts`, never in a migration
file), and to ask the user — its conversation then waits — only for a product
decision it cannot infer, or for the one case no code edit resolves: a snapshot
merge conflict or a `migration-applies-clean` failure (a published migration
that cannot run on this database).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Registers the Upstream merges automation's config (schedule, push policy, model, prompt template) for the Automations pane and Settings → Config. The health report's updates row on a clone: titled by its state — 'equin is out of date' (2026.10.30 → 2026.11.14; drawn as attention but ambient, so the dot stays green) with a Send agent to update remedy (the launch popover, filed about the release so it is never filed twice), 'Update in progress' with the merging conversation linked beside its own status chip (pulsing while it works, attention while it waits on the user), 'Installing' while main rebuilds the merged release, then 'equin is up to date'; a reminder bell in every state (the update reminders config). The update reminder's action (equin-update) on the 'equin is out of date' notification the daily check writes: Send agent to update (the row's launch popover) and Remind me later (Tomorrow / In a week / In a month / Skip this release / Never), each settling the notification. Absent on the canonical repo, before any check, and where upstream has cut no release. Upstream, portable half: the Upstream merges automation's config registration, the update reminders config, the Upstream task category, and the upstream_release_check table the desktop half records each check of upstream's releases in.
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "reminders"
    - `ConfigV2.WebRegister` "upstream-merge"
    - `Automations.Config` "upstream-merge"
    - `HealthReport.Row` "Updates"
    - `Notifications.Action` "equin-update"
  - Uses: 23 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×6
    - `config_v2` ×3
    - `apps-core/tabs.useAppLinkProps`
    - `conversations/conversation-view/status.ConversationStatusChip`
    - `network/live/live-state.ResourceErrorInline`
    - `network/live.useLive`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/text.Text`
    - `primitives/icon-button.IconButton`
    - `primitives/launch.LaunchAgentPopover`
    - `shell/health-report.HealthReport`
    - `shell/notifications.Notifications`
    - `tasks/automations.automationConfigContributions`
    - `tasks/task-subject.useSubjectTask`
    - `ui/icons.Icon`
- Server:
  - Contributes:
    - `ConfigV2.Register` "reminders"
    - `ConfigV2.Register` "upstream-merge"
    - `taskCategory` "upstream"
    - `resource.declare` "upstream.release-status"
    - `restart-skip.adopted` "whether the served build holds the newest upstream release"
  - Uses:
    - `config_v2.ConfigV2`
    - `database/sql-column.parsedText`
    - `tasks/automations.automationConfigRegistration`
    - `tasks/task-category.TaskCategory`
  - DB schema: `plugins/upstream/server/internal/tables.ts`
  - Resources: `upstream.release-status` (push, notified)
- Machine:
  - Uses:
    - `infra/endpoints.implementMachine`
    - `network/live.serveValue`
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
    - `upstream/release.newestReleaseTag`
    - `upstream/release.RELEASE_TAG_GLOB`
  - Exports (types):
    - `ReleaseStanding`
    - `UpstreamStatus`
  - Exports (values):
    - `currentRelease`
    - `fetchUpstreamStatus`
    - `OWN_RELEASE_NAMESPACE`
    - `releaseInCommit`
    - `standingAgainst`
    - `UPSTREAM_BRANCH`
    - `upstreamReleaseNamespace`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --spacing`
  - Imported by:
    - `framework/cli/upstream`
    - `framework/cli/version`
- Sub-plugins:
  - **`release`** — What an equin release is, as web-safe data: the release tag grammar (annotated `v<YYYY.MM.DD>[.<n>]` tags on main — parse, order, name the next one, display), the upstream.release-status live value…

<!-- AUTOGENERATED:END -->
