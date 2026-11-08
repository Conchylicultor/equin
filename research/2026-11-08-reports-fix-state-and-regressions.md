# Reports: fix state and regressions

Task: task-1794143800-gmyvg5. Mockup: proto-1792931808-jimks8 (scenes bell / toasts / catalog → "A report's fix").

## Context

Supervisor sessions audit and fix reports, but the engine has no notion of "fixed". A report row has a count, first/last seen, noise and an optional `task_id`, and nothing else about its fate. As a result:

- nothing records that a report was fixed, or by which commit;
- a report firing again from code that HAS the fix (a regression) looks the same as one firing from older code. Example: the "error watching …/runs" crash was fixed in 51f9fdf on 10-15, came back on 11-07 20:33–23:56, broke every supervised job, and nothing flagged it;
- server occurrences carry no commit (`buildId` is null; the browser's `buildId` is a graph hash, not a commit);
- progress cannot be measured: there are no opened / fixed / regressed counts.

Outcome: a fix is recorded from the commit that names it, at the moment main deploys it. Every occurrence carries the commit its code ran. The status is derived from those facts (open → fix pending → fixed → regressed). Notifications and Debug → Reports show the status, and supervisors work from Open ∪ Regressed.

Decisions taken with the user:

- start empty, with no backfill;
- a report regresses on the first occurrence from code that contains the fix;
- an occurrence whose commit cannot be named, firing after the fix is live, counts as regressed ("commit unknown"). "Cannot tell" never keeps a report quietly fixed.

## Facts the status is derived from

| Fact | Where it comes from | Stored |
|---|---|---|
| A fix claim: commit C names report R | `Fixes-report: <report-id>` trailer on a commit reachable from `refs/heads/main` | `report_fixes(report_id, commit, landed_at)` |
| The fix is live | main's deployable carriers (server pin and web `.build-commit`) both descend from C | `report_fixes.deployed_at` |
| An occurrence ran commit X | stamped at record time (see below) | `recent[].commit`, `reports.last_commit` |
| A regression | an occurrence of R recorded after `landed_at` whose X descends from C, or whose X is unknown once the fix is live | `report_fixes.regressed_at`, `regressed_commit` (null = unknown) |

**Derived status** (`core/fix-state.ts`, a pure function over R's latest `report_fixes` row):

| Status | Condition |
|---|---|
| `open` | no fix row |
| `pending` | `deployed_at` is null and no regression yet |
| `fixed` | `deployed_at` is set and no regression |
| `regressed` | `regressed_at` is set |

A newer fix row (fixing it again) starts the cycle over, so the history is kept. An occurrence from code without the fix (a worktree behind main) leaves the status alone; the detail pane shows that occurrence's commit.

It is materialized on `reports` as `fix_state`, `fix_commit` and `fix_state_at`, because the DataView filters and groups on it. The columns are written only by `deriveReportFixState(reportId)`, which recomputes from `report_fixes` through `reportsProducer.mutate`. No endpoint sets them, so the status is never hand-set. The engine's `CLAUDE.md` records that this function is the only writer.

## 1. Every occurrence carries its commit

- `ReportOccurrenceSchema` gets `commit: string | null` (default null for rows written before this change), and `reports` gets a `lastCommit` column, last-writer-wins like `lastBuildId`. `ReportInput` gets `commit`. Callers never pass it: `fileReport` stamps it per source.
- **Server**: the `server` carrier pin (`build/deployment/machine/internal/server-pin.ts`, a `Resolvable`; `unresolved` on a mixed boot). The engine is a `server/` barrel and cannot import the `machine/` pin, so `build/server-build-id/server` gains a `processCommit()` holder. It follows the same pattern as `setClientBuildIdentity`: the deployment machine half fills it when it seals the pin at `onAllReady`. Before then it is unresolved, so the commit is null.
- **Browser**: `reports/web/report.ts` sends `commit: import.meta.env.VITE_BUILD_COMMIT || null` (baked into the bundle; `ClientReportBody` omits it so a caller cannot set it). `ReportBodySchema` gets `commit`.
- **Outbox (CLI, exec children)**: an entry's `writer` gets `commit` (the writer checkout's `HEAD`, sampled at module eval like the server pin; resolved in `onReadyBlocking` for the sync fatal path). The drain passes it to `recordReport`.
- A worktree with uncommitted edits is stamped with its `HEAD`. That is a known blind spot, shared with the deployment model, and acceptable because only main's rows carry fixes.

## 2. Naming the fix: `./equin push --fixes-report <id>`

- The flag is new and repeatable. Push stamps `Fixes-report: <id>` with the existing `trailerAmendCommand` path, next to `Equin-Attempt` (`push/cli/attribution.ts`), so every commit of the push carries it.
- **One spelling.** Push refuses a `-m` message that contains a `Fixes-report:` line: the trailer has one writer.
- **Validated before anything lands.** The id must parse as `reportIdKind`, and the row must exist in main's database with `worktree = main`. The read uses the same read-only path as `query_db`. A miss refuses the push and names the id. Worktree DBs exclude reports from the fork, so only main's ids are meaningful.
- The key is added to the trailer constants (`tasks-core/core/internal/trailers.ts` holds the others). Put it in a leaf the reports engine can import without reaching into tasks, either `reports/core` or a tiny shared trailer-keys leaf. Decide during implementation by what `boundary-rules` allows.

## 3. Recording on main: landed, then deployed

The new sub-plugin `reports/plugins/fixes` (engine side, non-portable) owns `report_fixes` and its writers.

- **Landed.** A main-only `defineRefReaction` on `refs/heads/main` (git-watcher) walks the new commits (`git log <prev>..<new>`, the `runGit` helper from `primitives/commit-list`) for `Fixes-report` trailers. It inserts one `report_fixes` row per (report, newest commit naming it in this range), with `landed_at` set to the commit's time. Then it calls `deriveReportFixState` → `pending`. It is idempotent on (report_id, commit). An id unknown to main files a crash-style report: loud, not dropped.
- **Deployed.** In main's backend `onReady`, after the server pin is sealed, a second step runs. For every fix row with `deployed_at` null, it runs `isAncestor(commit, pin)` for both the server and the web carrier, reusing `build/deployment`'s `isAncestor` and `readDeploymentState`. When both hold, it sets `deployed_at = now` → `fixed`. A deploy always restarts main's backend, so "the process that runs the fix records it": a fix can never read fixed before its code ships. `deploymentServed` is a second trigger, for a web-only build that skips the restart.

## 4. Regression detection at record time

- After `writeReport`, if R has an unregressed fix row, the engine queues `judgeRegression(R, occurrence.commit)` on a keyed coalescer per report (`packages/coalesce`), off the write path. Most reports have no fix row, so they pay one indexed read, and that read rides the row the upsert already returns (join on `fix_state`).
- The verdict, memoized per (fix commit, occurrence commit) pair. Server pins are constant per process, so a storm costs one git call:
  - `commit` is not null and `isAncestor(fix, commit)` → regressed (`regressed_commit = commit`);
  - `commit` is null and `deployed_at` is set → regressed (unknown commit);
  - otherwise the occurrence is from older code, and nothing changes.
  - A git failure files a crash-style report. "Cannot tell" is never a verdict (same rule as the outbox staleness check).
- The first regression wins (the user's choice is the first occurrence). Later occurrences only bump the count.

## 5. Notifications (rules in `shell/notifications/CLAUDE.md`)

The notifications plugin gets one generic primitive. No reports names leak into it.

- **`state` on a notification**: `{ tone: "pending" | "ok" | "returned", icon, text, refId? }`. It draws one line under line 2 (the mockup's `FixState`: "fix on its way ‹C›", "fixed by ‹C› 3h ago", "came back after ‹C›"), with the commit as a subject chip. Changing `state` never touches `created_at` or `dismissed`, which fits both rules.
- **`about`**: a new indexed column, the record id a row is about. It survives the dedup key being released when a recurrence opens a new episode. Reports write `about = report id`.
- **`restateNotifications({ about }, state)`** (server) updates every row about that id in place, through the notifications' own writer. A `fixed` row also settles visually (`.fixed` look in the mockup: check glyph, faint description), driven by `tone: "ok"`.
- Reports' `deriveReportFixState` calls it on every status change:
  - `pending` / `fixed` → the existing rows change state in place;
  - `regressed` → existing rows show "came back after ‹C›", **and** `recordNotification` files a NEW row on top. That row has dedupe key `<reportId>:regressed:<fixCommit>`, `variant: "error"` even for a warning kind (so it stays until handled), headline `spec.meta.notif` with a "Regressed" tag (`state.tone = "returned"`), and the `fix-report` action.
- A sixth notification category is not needed: it stays `reports`.

## 6. Debug → Reports

- `reports.list` picks `fixState`, filterable and groupable, and carries `fixCommit` and `fixStateAt`. Field presenter: a badge (Open / Fix pending / Fixed / Regressed) plus the commit chip (the commit id kind from `code-explorer/commit-detail` opens the diff).
- The view bar is a `DataViewSwitcher` over the same collection: **Worklist** (open ∪ regressed, the default) · Regressed · Fix pending · Fixed · All. Each is a `where` on `fix_state` (plus `noise = false` for Worklist).
- Detail pane: a Fix card (the fix commit, landed / deployed / regressed times, the regressing commit) and each occurrence's commit chip in `report-occurrences.tsx`.
- **Supervisors' worklist**: `uninvestigated.ts` changes to `noise = false AND (fix_state = 'regressed' OR (fix_state = 'open' AND task_id IS NULL))`. A regressed report re-enters the investigations automation even though it has a done task (the two June crashes). It is renamed `reportWorklist` / `reportWorklistCounts`; the callers are `tasks/reports-investigation` and `upstream/merge-automation`.

## 7. Progress metrics

`report_fixes` plus `reports.first_seen_at` hold everything: opened per day (`first_seen_at`), fixed per day (`deployed_at`), regressed per day (`regressed_at`). This plan delivers a `stats` sub-plugin chart (`plugins/stats`, stacked per day). Exact chart polish is out of scope.

## Files

- `plugins/reports/core/entity.ts`: occurrence `commit`, `lastCommit`, `fixState` / `fixCommit` / `fixStateAt` fields, and `core/fix-state.ts` (the pure derivation and its test).
- `plugins/reports/server/internal/tables.ts`: the new columns, an index on `fix_state`, and `updatedAt.touchedBy` (fix columns: true; `lastCommit`: false).
- `plugins/reports/plugins/engine/server/internal/record-report.ts`: stamp `commit`, queue `judgeRegression`.
- `plugins/reports/plugins/engine/server/internal/uninvestigated.ts`: the worklist.
- `plugins/reports/plugins/fixes/` (new): `report_fixes`, the ref reaction, the onReady deploy step, `deriveReportFixState`, `judgeRegression`.
- `plugins/reports/plugins/outbox/`: `writer.commit`.
- `plugins/reports/web/report.ts`, `core/report-body.ts`: browser `commit`.
- `plugins/build/plugins/server-build-id/server` + `build/deployment/machine/internal/server-pin.ts`: the `processCommit()` holder.
- `plugins/framework/plugins/cli/plugins/push/cli/{run,attribution}.ts`: `--fixes-report`, validation, refusing the trailer in `-m`.
- `plugins/shell/plugins/notifications/`: `state`, `about`, `restateNotifications`, `NotificationView`'s state line, and the CLAUDE.md rules section.
- `plugins/debug/plugins/reports/web/`: field, switcher sources, Fix card, occurrence commit.
- Docs: `reports/CLAUDE.md`, `engine/CLAUDE.md` (fix-state writer rule), the new `fixes/CLAUDE.md`, and a note in root `CLAUDE.md` § Push on `--fixes-report`.

## Verification

- Unit tests (`./equin test plugins/reports`):
  - the `fix-state` derivation table;
  - the regression verdict (descendant / older / null-after-deploy / null-before-deploy / git failure);
  - trailer parsing;
  - push validation (bad grammar, unknown id, trailer in `-m` refused).
- DB suites (`worktree-db` rolled-back harness):
  - `report_fixes` landed → pending → fixed;
  - a regression files a new notification row and restates the old one, with `created_at` untouched (the stable-position trigger proves it).
- End to end on the worktree build:
  - record a report, insert a fix row for a commit that `HEAD` descends from, and call the deploy step → Fixed in Debug → Reports, and the bell row reads "fixed by ‹C›";
  - fire the report again → Regressed, a new error row on top, the old row "came back";
  - screenshot both with `screenshot.ts` against the mockup scenes.
- `./equin check`: migrations, boundaries, producer-writes, docs.
