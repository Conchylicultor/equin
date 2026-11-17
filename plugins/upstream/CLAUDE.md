# upstream

The repo this checkout was cloned from, watched — by its **releases**.

Everything else in this app is offline: agent worktrees branch off the local
`main`, main rebuilds itself when that ref moves, and the pushes ledger reads
local `main` only. So for someone who cloned this repo rather than authoring it,
upstream can move for months in complete silence. This plugin is the one place
that notices.

Plan: `research/2026-11-17-global-release-updates.md` (this is its phase 1).

## Releases, not commits

The author pushes to `main` a hundred times a day, so "behind upstream's main"
is true of every clone all the time — noise. A clone is measured against
**releases** instead: annotated tags `v<YYYY.MM.DD>` (`.2`, `.3`… for another the
same UTC day) on main, cut on purpose with `./equin version cut`
(`framework/cli/plugins/version`), which refuses unless main is published,
serving HEAD, and its build of HEAD passed. The tag grammar is
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
reminder (later phases of the plan) take over the bell and Investigate.

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

- Description: Registers the Upstream merges automation's config (schedule, push policy, model, prompt template) for the Automations pane and Settings → Config. Upstream, portable half: the Upstream merges automation's config registration, the Upstream task category, and the upstream_release_check table the desktop half records each check of upstream's releases in.
- Web:
  - Contributes:
    - `ConfigV2.WebRegister` "upstream-merge"
    - `Automations.Config` "upstream-merge"
  - Uses: `tasks/automations.automationConfigContributions`
- Server:
  - Contributes:
    - `ConfigV2.Register` "upstream-merge"
    - `taskCategory` "upstream"
    - `resource.declare` "upstream.release-status"
  - Uses:
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
    - `standingAgainst`
    - `UPSTREAM_BRANCH`
    - `upstreamReleaseNamespace`
- Cross-plugin:
  - Imported by:
    - `framework/cli/upstream`
    - `framework/cli/version`
- Sub-plugins:
  - **`release`** — What an equin release is, as web-safe data: the release tag grammar (annotated `v<YYYY.MM.DD>[.<n>]` tags on main — parse, order, name the next one, display), the upstream.release-status live value…

<!-- AUTOGENERATED:END -->
