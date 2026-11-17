# equin updates for clone users: releases, an updates health row, quiet reminders

Prototype: `proto-1792516777-e95kao` (Health report rows).

## Context

Someone who cloned equin should learn when a new version is out and update with
one click, without being nagged. Part of this exists in `plugins/upstream`:
- a daily job (`upstream.detect-updates`) files a rolling
  `upstream-updates-available` report;
- the report rings the bell weekly and its Investigate button mints a merge
  task;
- an Upstream merges automation exists (off by default).

It has three problems:

1. **It is keyed on upstream `main`.** The author pushes 100+ commits a day, so
   every clone is behind all the time. The signal is noise.
2. **It surfaces as a developer report** (audience developer, `fix-report`
   action, a fixed 7-day bell). A user can't tell it is an update, can't see
   that it costs an agent run, and can't control the reminders.
3. **It never says "done".** Nothing shows the update in progress, landing, or
   being installed.

What we want:
- releases the author cuts on purpose;
- a health-report row that names the state ("equin is out of date",
  2026.10.30 → 2026.11.14);
- "Send agent to update" through the standard launch popover;
- one in-progress view that shows the conversation's own status;
- an "Installing" step while main rebuilds;
- rare reminders the user controls.

Updates are never automatic. Out of scope: the Upstream merges automation stays
as it is (off by default); it only inherits the new detection.

## Design

### 1. Releases are annotated tags: `./equin version cut`

- **A release is an annotated tag `v<YYYY.MM.DD>` on main** (`v2026.11.14`; a
  second release the same day is `v2026.11.14.2`).
  - Its message is a single line ("equin 2026.11.14"). There are no release
    notes: no UI ever lists changes.
  - A tag, not a branch, because a tag gives a named version for free (shown as
    "you're on X") with no state to store.
  - Tags already protect commits from worktree cleanup
    (`debug/worktree-cleanup/server/internal/safety.ts` counts `--tags`).
- **New CLI group `version`**, a sub-plugin
  `plugins/framework/plugins/cli/plugins/version/` modelled on the `upstream`
  group:
  - `./equin version` prints the current release (the newest `v*` tag reachable
    from `main`) and the newest one known upstream.
  - `./equin version cut [-m "…"]` creates and pushes the tag. It is refused
    unless all of these hold:
    - this checkout can publish (`resolvePublishTarget`, `infra/git/remotes`);
    - `main` HEAD is what main is serving: `readServedDeployment()` from
      `build/deployment` reports converged;
    - the last `build_runs` row for that commit exited 0 (`build/run-ledger`).

    So a release is always a main that built and passed its checks. It then
    runs `git tag -a` and `git push <remote> refs/tags/<tag>`.
  - Not a flag on `push`: a release must follow a *confirmed green* main, which
    `push` cannot know when it lands. The name `release` is taken (artifact
    packaging, `plugins/release`).
- The shared version helpers live in `upstream/core`, next to
  `fetchUpstreamStatus`, so the CLI and the server agree:
  - `RELEASE_TAG_PREFIX`
  - `parseReleaseTag` / `compareReleases`
  - `currentRelease(root, ref)`, which uses `git describe --tags --abbrev=0 --match 'v*' <ref>`

### 2. Detection keyed on releases (`plugins/upstream`)

- **`fetchUpstreamStatus`** (`upstream/core/internal/status.ts`):
  - Fetch tags as well as `main`: `git fetch <remote> main 'refs/tags/v*:refs/tags/v*'`.
  - Pick the newest release tag, and answer with these arms:
    - `no-upstream`, unchanged;
    - `unreachable`, unchanged;
    - `no-release`: upstream has no tag yet, so the user is told nothing;
    - `current { release }`;
    - `behind { current: string | null, latest, remote, url }`.
  - Behind means `latest` is not an ancestor of local `main`
    (`git merge-base --is-ancestor`).
  - Drop `count` and `newest`, the commit subjects: no change lists anywhere.
- **`./equin upstream merge`** (`framework/cli/plugins/upstream/cli/merge.ts`)
  merges the **tag** (`status.latest`), never `<remote>/main`.
- **A live value for the web: `upstream.release-status`.**
  - It returns `{ kind: "unknown" | "no-upstream" | "no-release" | "current" | "behind", current, latest, checkedAt }`.
  - It is persisted as a singleton row (`upstream_release_status`), written by
    the daily job and by a `POST /api/upstream/check`.
  - The web never spawns git. Fetching is network work, so it stays in the
    scheduled job (no change signal exists upstream, the documented `defineJob`
    case).
  - `current` comes from local `main`, so it is recomputed whenever local `main`
    moves. Reuse the trigger the deployment read already reacts to
    (`build.deployment`'s target).
- **Retire the `upstream-updates-available` report kind.** Its jobs (bell,
  Investigate) move to the health row (§3) and the reminder (§5). The automation's
  `onFiled` report link is removed with it.

### 3. The updates health row (new sub-plugin `upstream/plugins/health-row`)

Template: the Gateway row (`infra/launcher/gateway-drift/web`). That row is a
`status` row with a `remedy` that is exactly a `LaunchAgentPopover`.

```ts
HealthReport.Row({ kind: "status", id: "updates", title: …, useStatus: useUpdatesHealth,
  glance: UpdateGlance, actions: ReminderBell, remedy: SendAgentToUpdate })
```

The row's state is derived and never stored. It comes from three reads:
`upstream.release-status`, the live merge task (by subject), and
`build.deployment` for main.

| Derived state | Title | Summary | Health status |
|---|---|---|---|
| status unknown | — | — | `unknown` (Checking…) |
| no-upstream / no-release | — | — | `not-applicable` (the row is hidden on the canonical repo) |
| behind, no live merge task | equin is out of date | `2026.10.30 → 2026.11.14` | `attention` + `ambient: []`: drawn as attention, but the dot stays green. Being behind is not a problem. |
| behind, merge task live | Update in progress | same | follows the conversation: `attention` while it waits for the user, `ok` + `transitioning` while it works |
| `latest` in local main, main not yet serving it | Installing | `2026.11.14` | `ok` + `transitioning` |
| current | equin is up to date | `2026.11.14` | `ok` (folds into System checks) |

- **No duplicated state.** The in-progress glance draws the conversation's
  *own* status chip and links to the conversation.
  - Export a by-id chip from
    `conversations/conversation-view/plugins/status/web`, as
    `ConversationStatusChip({ convId })`. It is the existing inner `StatusChip`,
    lifted out of `StatusBadge`, which today reads the pane params.
  - The link opens `conversationPane` (`openPane(conversationPane, { convId })`).
- **Finding the merge task** uses `tasks/task-subject`:
  - The launch files with `subject: { kind: "upstream-release", id: <latest> }`.
  - `useSubjectTask` finds it, and its latest conversation is the one shown.
  - A second click on Send can't file a twin, because a launch with a live
    subject reuses the task.
  - The automation files with the same subject, so both paths dedupe.
- **"Send agent to update"** is the `remedy`: `LaunchAgentPopover` (`primitives/launch/web`).
  - Its tooltip reads "Launch an agent in a new worktree to merge main changes
    with your app".
  - `title`: "Update equin 2026.10.30 → 2026.11.14", placeholder "Add
    instructions for the agent…".
  - `getRequest` builds the prompt from `UPSTREAM_MERGE_PROMPT` with the user's
    text appended, `categoryId: "upstream"` and the subject above.
  - The popover's own launch options (pre-prompt, model, effort) are what lets
    the user control the run.
- **The bell (`actions`, shown in every state)** toggles the reminder config's
  `enabled` (§5).
  - Icons: `notifications-active` / `notifications-off`, as in
    `shell/notifications/native`.
  - Tooltip: "Reminders on — click to stop them" (or the reverse).
- **Placement:** a new row id in
  `config/shell/health-report/shell.health-report.row.jsonc`, right after the
  identity row.

### 4. Identity row titled by checkout kind (`tasks/worktree-identity`)

The title no longer clashes with "equin is …", and never carries a long task
title:
- main: title **Main checkout**, summary `equin`.
- agent worktree: title **Agent worktree**, summary
  `<task short title> · <checkout>`. The short title is `task-title`'s
  ≤3-word one (`taskShortTitleColumns`), falling back to the checkout alone.
- a composition on a worktree: title **`<Composition>` worktree**, same summary.
- local: **Local dev**, unchanged.

The change is in `identity.ts` (`identityInfo` / `summaryOf`), plus its tests.

### 5. Reminders: a notification the user controls

- **Config** `upstream/shared/reminder-config.ts` (`config_v2`):
  - `enabled: bool` (default true)
  - `snoozedUntil: date`
  - `skippedRelease: text`

  The row's bell and the notification's menu write it with `useSetConfig`.
- **The daily job** records a notification only when all of these hold:
  - the status is `behind`;
  - `enabled`;
  - now > `snoozedUntil`;
  - `latest !== skippedRelease`;
  - no live merge task.

  The call:
  ```
  recordNotification({ category: "updates", variant: "info", title: "equin is out of date",
    description: "2026.10.30 → 2026.11.14", dedupeKey: "equin-release:<latest>",
    resurfaceAfterMs: 30 days, action: { kind: "equin-update", payload: { latest } } })
  ```
  So the user hears about a new release once, and is reminded at most monthly
  after that. The author's release cadence sets the noise level.
- **The notification action `equin-update`** is a `Notifications.Action` of the
  `Control` shape. It draws two things:
  - "Send agent to update" (the same popover component as the row);
  - "Remind me later ▾": Tomorrow / In a week / In a month / Skip this release /
    Never.

    The first three set `snoozedUntil`, Skip sets `skippedRelease`, and Never
    sets `enabled = false`. Each also dismisses the notification.
- The audience is `user`, not developer.

### 6. The merge agent resolves conflicts itself

- **`upstream/shared/merge-prompt.ts`:** drop the commit list. Tell the agent to:
  - merge the release tag;
  - resolve every conflict itself, keeping the user's intent and the release's
    behaviour;
  - for a migration snapshot conflict, decide the schema in the owning
    `schema.ts` and rebuild. Never edit `migrations/data`;
  - stop and ask the user (the conversation then waits, and the row shows it)
    only when the choice is a product decision it cannot infer;
  - build, check, open the app, then follow the push policy. Investigate's "do
    not push" is gone: the user lands it from the conversation.
- **`framework/cli/plugins/upstream/cli/merge.ts`:** the conflicted-migration
  message becomes guidance ("resolve via the schema, never edit data files")
  instead of "STOP and report".

## Phases (each lands separately)

1. **Releases + detection:** `version` CLI, release helpers, `fetchUpstreamStatus`
   on tags, `upstream merge` merging the tag, the `upstream.release-status`
   value + job, report kind retired. Cut `v2026.11.17` afterwards.
2. **Health row:** the updates row, `ConversationStatusChip` export, the
   launch subject, the identity row retitle.
3. **Reminders:** config, job gating, `equin-update` notification action.
4. **Agent-resolved conflicts:** the prompt and CLI changes.

## Verification

- `./equin test plugins/upstream`: `status.test.ts` extended with temp repos
  (a clone with tags: no tag → `no-release`, behind/current by ancestry, two
  releases the same day ordered, unreachable remote). Plus a test for the pure
  row derivation (`useUpdatesHealth`'s mapper) over every table row in §3.
- `./equin test plugins/tasks/plugins/worktree-identity` for the new titles.
- `plugins/upstream/e2e/clone-journey.ts`, extended:
  1. clone, cut a release upstream, run the job;
  2. the row reads "out of date";
  3. launch through the popover, and the row shows the conversation chip;
  4. land it; the row goes Installing, then up to date.
- `./equin check` (boundaries, config sync, plugin docs).
- `register_before_after` on the health report (route `/`) for the identity and
  updates rows; compare with the prototype.
