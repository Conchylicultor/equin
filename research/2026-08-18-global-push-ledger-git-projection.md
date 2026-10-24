# The pushes ledger is a projection of `main`, not the output of a job

Date: 2026-08-18
Category: global (tasks/tasks-core, tasks, tasks/attempt-work, infra/git-watcher)

Follow-up to `research/2026-08-17-global-attempt-work-git-derived-standing.md`, which
moved the *destructive* exit decisions off this ledger. This one takes the rest of it.

## Context

The `pushes` table has exactly one writer: the `tasks.push-ingest` job, reacting to the
`git.refAdvanced` trigger event (`plugins/tasks/server/internal/push-watcher.ts:122-155`).
It was observed 40+ minutes behind a wedged queue, during which the table was empty for
commits fully merged into `main` and every consumer read landed work as not-pushed.

Two things came out of the investigation that change the shape of the fix.

### It is not "when the queue wedges" — the ledger is stale right now

`refAdvanced.emit()` is behind an `isMain()` gate
(`plugins/infra/plugins/git-watcher/server/internal/watcher.ts:102`), so the event only
ever exists in the **main** backend's database. The boot reconcile is a
`scope: "host"` warm-up (`push-watcher.ts:109-119`), which the executor skips on every
non-main backend (`warmup/server/internal/executor.ts:49`). A worktree backend therefore
has *no* ingest path and *no* heal path: its `pushes` table is frozen at the moment its
DB was forked from `singularity`.

Measured while writing this, with nothing wedged and the queue idle:

| database | rows in `pushes` | newest row |
| --- | --- | --- |
| `singularity` | 3396 | 2026-08-17 23:23:56Z (= `main`'s tip) |
| `att-1787008752-oydz` | 3395 | 2026-08-17 22:06:08Z |

That worktree is 77 minutes behind and will never catch up. Every agent working in a
worktree namespace sees a task list whose finished work looks unfinished.

### The lag is not display-only — it stops work from starting

`task_blocking_v` decides whether a dependency still blocks its dependents, and its rule
is `NOT EXISTS (SELECT 1 FROM attempts WHERE task_id = dep AND status = 'completed')`
(`tasks-core/server/internal/views.ts:128-138`). `attempts_v.status = 'completed'`
requires `attempt_push_agg.has_push`, which requires a `pushes` row
(`views.ts:49-59`, `rollup-spec.ts:183-268`). So while the ledger lags:

- dependent tasks stay **blocked** and their armed auto-start never fires;
- `tasks_v.status` never reaches `done`, and `finishedAt` stays null — task list badges,
  the stats completion series, `conversation-progress`'s `pushed` phase, the review pane
  and the docs button are all wrong with it.

The `attemptsResource` comment already flags the status half as a known gap and calls it
"non-destructive and self-healing" (`tasks-core/server/internal/resources.ts:137-141`).
Blocking dependents from launching is neither.

### Two more things the ingest gets wrong

- **Failures are swallowed.** Both `runInitialReconcile` and the job body end in
  `catch (err) { console.error(...) }` (`push-watcher.ts:97-105`, `:151-154`). A
  permanently failing ingest is indistinguishable from a quiet one.
- **The only heal is contractually optional.** `defineWarmup`'s own docstring says a
  warm-up "is an OPTIMIZATION, never a correctness dependency — consumers must work cold
  via their own lazy on-demand refresh" (`warmup/server/internal/registry.ts:22-25`).
  Nothing provides that cold path, so the ledger's correctness rests on a hook that is
  allowed to be skipped.

## The two questions, separated

**Why can a cheap job stall behind a wedged queue at all?** Every job in a backend routes
through one graphile task name into one shared pool of `JOB_CONCURRENCY = 4` slots
(`infra/jobs/server/internal/constants.ts:8,14`), and push ingest reaches it through
**two** unprioritised hops — `events.dispatch`, then `tasks.push-ingest`, both
`dedup: "none"` and neither `serial`. A 150 ms `git log` queues behind multi-minute DB
forks, builds and agent spawns. That is a whole-queue problem, and it is filed
separately (see Follow-ups); this change removes push ingest from the queue entirely
rather than waiting for it.

**Should a derivation this load-bearing depend on a background job's liveness?** No. The
answer this change implements: it does not have to, because every row in `pushes` is
already derivable from `main`'s own history. The table stops being *the output of a job*
and becomes *a projection of git that is refreshed on write and guaranteed on read*.

## The invariant

> **I5.** `pushes` is a projection of the trailer-bearing commits reachable from
> `refs/heads/main`. It is refreshed in-process on every observed advance of that ref
> (the push path) and re-derived before any read that could otherwise observe it stale
> (the pull path). No queue, no job, and no boot hook sits between a landed commit and
> the row that records it.

I3 from `attempt-work` is unchanged and still governs *interpretation*: a row proves a
push happened, its absence proves nothing. I5 governs *completeness*. They compose — I5
is what lets `attempts_v.status` keep deriving from the ledger without lying.

This is the shape `infra/corpus-index` already uses for file-derived indexes:
`startWatcher` is push freshness, `ensureFresh` is the lazy on-read correctness fallback.
The ledger gets the same two halves, over git instead of the filesystem.

## Design

### 1. The trailer grammar moves down, to the plugin that owns the table

`plugins/tasks/plugins/attempt-work/core/trailers.ts` →
`plugins/tasks/plugins/tasks-core/core/internal/trailers.ts`, re-exported from
`tasks-core/core`. `attempt-work/server/internal/measure.ts` imports it from there;
`attempt-work/core` stops exporting it (no cross-plugin re-export). `trailers.test.ts`
moves with it.

This is what makes the rest possible without a cycle: the projection has to live beside
`insertPush` and the `pushes` table, i.e. in `tasks-core/server`, and `tasks-core` cannot
import `attempt-work` (which imports `tasks-core/server`).

### 2. `tasks-core/server/internal/push-ledger/` — the projection

Three files, replacing `plugins/tasks/server/internal/push-watcher.ts`:

**`raw-reads.ts`** — the ungated reads the projection itself needs: `listPushShasIn`,
plus batched `getConversationsIn` / `listAttemptIds`. Not exported from the barrel. The
gated public accessors (§3) cannot call these and these cannot call the gated accessors,
so re-entrancy into the freshness gate has no spelling.

**`reconcile.ts`** — `reconcilePushLedger(since: Date | null)`:

- one `git log --no-color [--since=…] --format=<TRAILER_LOG_FORMAT> refs/heads/main` in
  `ensureMainWorktreeRoot()`, via `runGit` from `primitives/commit-list/server` (the
  local copy in `push-watcher.ts:21-33` goes away);
- `parseTrailerLog`, filter to shas not already present (`listPushShasIn`), resolve
  conversations in **one** `inArray` query instead of the current per-commit
  `getConversation` round trip, then `insertPush` each (already idempotent via
  `onConflictDoNothing` + `pushes_sha_unique`);
- **throws** on any git or DB failure. No `console.error`-and-return.

Bound: `since` is the ledger's own watermark, `max(pushes.created_at) - 24h`, and `null`
(full history) only when the table is empty. `created_at` is the commit's *committer*
date, which a rebase rewrites to the push time, so it tracks `main`'s history; the 24h
pad absorbs clock adjustment. Today's job walks the full 3577-commit history whenever
`previousSha` is null; watermark-bounded, the steady-state walk is a handful of commits.

**`freshness.ts`** — the gate, one `createSignedMemo` from `infra/git-read-cache/server`:

```ts
const ledgerMemo = createSignedMemo<LedgerCoverage>({
  name: "push-ledger",
  // Cheap and ungated: the watcher already tracks refs/heads/main in EVERY
  // backend (only `emit` is main-gated), so this is a Map read. One `rev-parse`
  // only in the window before the watcher seeds.
  signature: async () => lastKnownMainSha() ?? (await revParseMain()),
  compute: () => withHeavyReadSlot(() => reconcileFromWatermark()),
});

/** Guarantees the ledger covers `main` as this backend last observed it. */
export const ensurePushLedgerFresh = () => ledgerMemo.get(LEDGER_KEY);
```

Everything load-bearing is inherited rather than rebuilt: the signature hit
short-circuits before any heavy slot, `createInflight` collapses concurrent callers onto
one execution, and — the part that matters here — the cache is written *only* on success,
so a failed reconcile leaves the covered signature unadvanced and the next call retries.
A single fixed key: the ledger is global, not per-worktree.

### 3. The gate is inside the readers, so no consumer has to remember it

`tasks-core/server/internal/queries/pushes.ts` keeps only the accessors whose emptiness a
consumer could misread, and each awaits `ensurePushLedgerFresh()` first:

- `listPushesForAttempt` — review pane, task-events, docs-button, `attempt-work`'s
  `ledgerPushes` corroboration;
- `listPushesByPushId` — the per-push diff endpoint.

`listPushShasIn` and `getLatestPush` leave the barrel: the first is the projection's own
internal read (moved to `raw-reads.ts`), the second has no callers and is deleted.
`listPushes` stays ungated with a comment: its only caller is `pushesResource`'s loader,
the server-side cascade carrier that recomputes *because* the projection just wrote.

`pushesByAttemptResource`'s loader reads through `listPushesForAttempt`, so every
attempt-scoped push surface inherits the guarantee. It is deliberately *not* a
`bootCritical` descriptor (it hydrates post-mount, route-scoped), so gating it puts no
git read on the boot-snapshot path — unlike `tasksResource` / `attemptsResource`, which
is the whole reason those stay ungated.

### 4. `infra/git-watcher` gains an in-process reaction seam

```ts
export interface RefReactionSpec {
  name: string;                       // stable id → profiler span + report key
  refName: string;                    // "refs/heads/main"
  run: (advance: RefAdvancedPayload) => Promise<void>;
}
export function defineRefReaction(spec: RefReactionSpec): Registration;
```

Module-level registry populated at `register()` time, mirroring `defineWarmup`
(`warmup/server/internal/registry.ts:41-58`) byte-for-byte in shape. `recompute()` awaits
every matching reaction — under `runTracked`, **before** `refAdvanced.emit()` and
**without** the `isMain()` gate, which is precisely what fixes the frozen worktree
ledgers. A reaction that throws is reported through a `defineReportSink`
(`refReactionFailureSink`, the `worktreeRemovalSink` precedent at
`infra/worktree/server/internal/removal-seam.ts:39`) and does not stop the other
reactions or the emit; the pull path in §2 is what makes that safe.

The distinction goes in `git-watcher/CLAUDE.md`, because the plugin now offers two
signals and picking the wrong one is the bug this document is about:

> `refAdvanced` is the **durable** signal — work that must survive a crash, may be slow,
> and belongs in the queue. A **reaction** is the in-process signal — a cheap, idempotent
> refresh whose correctness is independently guaranteed by an on-read fallback, and which
> therefore must not be able to queue behind unrelated work. A reaction that needs
> durability is a job in disguise.

### 5. What is deleted

- `pushIngestJob` and its `Trigger` contribution (`tasks/server/index.ts:57-60`) — with
  them, both queue hops and the `dedup: "none"` fan-out on a burst of ref advances.
- `pushReconcileWarmup` and `runInitialReconcile`. The boot catch-up becomes
  `onReady: () => ensurePushLedgerFresh()` on `tasks-core` — `onReady` is documented as
  the home for reconcilers and does not gate readiness
  (`server-core/core/types.ts:94,115`). Watermark-bounded, it is cheaper than the
  full-history warm-up it replaces.
- `plugins/tasks/server/internal/push-watcher.ts` in its entirety.

`tasks` registers the reaction; `tasks-core` owns the projection and the `onReady`.

### 6. What does not change

`attempts_v` / `tasks_v` / `task_blocking_v` keep deriving status from the rollup. The
fix is to make the table a faithful projection, not to move the derivation — SQL cannot
shell out to git, and with I5 held there is nothing left to move. `attempt-work` keeps
measuring standing from git directly: it answers a different question (*where does this
branch stand relative to `main`*, including unpushed commits) and must stay independent
of any table.

## Tests

- **`tasks-core/server/internal/push-ledger/reconcile.test.ts`** (bun:test, temp git repo
  + `db-test-fixture`): a trailer-bearing commit lands a row; re-running inserts nothing;
  a commit missing either trailer is skipped; a commit whose conversation is absent from
  this DB is skipped; a commit older than the `--since` watermark is not re-walked; a git
  failure **throws**.
- **`push-ledger/freshness.test.ts`**: a second call with an unchanged main sha performs
  no git read (spy the reconcile); an advanced sha recomputes; a throwing compute leaves
  the covered signature unadvanced so the next call retries; concurrent callers share one
  execution.
- **`git-watcher/server/internal/reactions.test.ts`**: reactions run on a non-main backend
  (the regression that froze worktree ledgers); a throwing reaction neither stops its
  siblings nor suppresses the emit; only reactions matching `refName` run.
- **`tasks-core/core/internal/trailers.test.ts`** — moved, unchanged.

## Verification

1. `./equin test plugins/tasks/plugins/tasks-core plugins/infra/plugins/git-watcher plugins/tasks/plugins/attempt-work`
2. `./equin build` (background), then `./equin check` — `type-check` for the
   trailer move burndown, `plugins-doc-in-sync` / `plugins-registry-in-sync`.
3. **The frozen-worktree reproduction.** Before: `query_db` on a worktree DB shows
   `max(pushes.created_at)` behind `singularity`'s. After deploying, restart that backend
   and re-query — the two must agree, and must keep agreeing across a fresh
   `./equin push` from another worktree while nothing is restarted.
4. **The blocking consequence.** In a scratch worktree DB, delete the push rows of a
   landed attempt, confirm `select status from attempts_v where id = '<att>'` is no longer
   `completed` and its dependent task reads blocked in `task_blocking_v`; then GET a
   surface that reads `listPushesForAttempt` (the review pane, `/agents/c/<id>`) and
   confirm the rows are restored and both flip back.
5. **No queue involvement.** After a `./equin push`, `get_queue_health` on
   `singularity` shows no `tasks.push-ingest` job at all, and the new `pushes` row is
   present within seconds of the ref moving.
6. **Loud failure.** Point `ensureMainWorktreeRoot` at an unreadable repo (e.g.
   `chmod 000 <mainRepo>/.git/refs`) and confirm the push accessors throw, a report is
   filed for the failed reaction, and the ledger keeps its previous rows — never an
   empty result presented as settled truth.
7. **Cold boot.** Drop a worktree DB's `pushes` rows entirely and restart the backend: the
   `onReady` reconcile refills them from the full history exactly once, and the second
   boot's reconcile is a no-op walk.

## Rejected

- **Fix only the queue (lanes / reserved capacity) and keep the job.** Necessary on its
  own account, and filed as such — but it leaves a decision-grade fact depending on a
  background worker's liveness, and would not have touched the frozen worktree ledgers,
  which no amount of queue health can reach.
- **Keep the job and add a freshness check** ("is ingest caught up?"). Rejected in the
  predecessor doc and still rejected: an unenforced guard every future consumer must
  remember, where a re-derivation has no staleness to check.
- **Gate `listAttempts` / `listTasks` too**, so the status chain can never read a stale
  ledger either. Strictly stronger, and rejected on blast radius: those feed
  `bootCritical` resources, and putting a git read on the boot-critical path makes a
  transient git failure a failed task list. The push path (§4) already closes the window
  they care about within milliseconds of a ref advance, and `onReady` closes it at boot.
- **Have `./equin push` write the rows itself**, transactionally with the push it
  performs. Tempting — the pusher knows the pushId, the conversation and the shas — but
  it does not cover `--from-main`, hand-merges, or a push landing while the backend is
  down, so the git-derived path would still be needed underneath, and a CLI→server
  coupling would be added for nothing.
- **Move `pushes` into its own plugin** so the projection could own the table. The
  `attempt_push_agg` rollup, `attempts_v` and the FK to `attempts` all live in
  `tasks-core`; the table has to stay with them.

## Ordered implementation

1. Move `core/trailers.ts` + its test from `attempt-work` to `tasks-core/core`; repoint
   `attempt-work/server/internal/measure.ts` and `push-watcher.ts`. Pure move, no
   behaviour change, `type-check` enumerates the burndown.
2. `infra/git-watcher`: `defineRefReaction` + registry + the `refReactionFailureSink`,
   dispatched from `recompute()` before `emit` and ungated by `isMain()`; barrel export;
   `reactions.test.ts`; the CLAUDE.md note on durable-vs-in-process.
3. `tasks-core/server/internal/push-ledger/`: `raw-reads.ts`, `reconcile.ts`,
   `freshness.ts` + the two tests. No callers yet.
4. Gate `listPushesForAttempt` / `listPushesByPushId`; drop `listPushShasIn` and
   `getLatestPush` from the barrel (delete the latter); document `listPushes` as the
   projection's own downstream.
5. `tasks-core`'s `onReady` calls `ensurePushLedgerFresh()`; `tasks` registers the ref
   reaction.
6. Delete `push-watcher.ts`, `pushIngestJob`, its `Trigger`, and `pushReconcileWarmup`.
7. Docs: I5 in `tasks-core/CLAUDE.md`, the ledger note in `attempt-work/CLAUDE.md`
   (its "why not the pushes table" section now needs to say *why it still isn't the
   authority* — it answers a different question, not merely a laggier one), and update
   the stale gap comment at `tasks-core/server/internal/resources.ts:137-141`.
8. `./equin build` (background) && `./equin check`, targeted tests, then the
   manual checks 3–7.

## Critical files

- **New**: `plugins/tasks/plugins/tasks-core/server/internal/push-ledger/{raw-reads,reconcile,freshness}.ts`,
  `plugins/infra/plugins/git-watcher/server/internal/{reactions.ts,reaction-report-sink.ts}`
- **Deleted**: `plugins/tasks/server/internal/push-watcher.ts`
- **Moved**: `plugins/tasks/plugins/attempt-work/core/trailers.ts` →
  `plugins/tasks/plugins/tasks-core/core/internal/trailers.ts`
- `plugins/tasks/plugins/tasks-core/server/internal/queries/pushes.ts`
- `plugins/tasks/plugins/tasks-core/server/index.ts`, `core/index.ts` (barrels)
- `plugins/infra/plugins/git-watcher/server/{index.ts,internal/watcher.ts}`
- `plugins/tasks/server/index.ts`
- `plugins/tasks/plugins/attempt-work/server/internal/measure.ts`

## Follow-ups (not in this change)

- **The queue class.** One 4-slot pool per backend serves 150 ms projections and
  multi-minute DB forks alike, with no weight and no reserved capacity, so any cheap
  event-reaction job can be starved. Proposal: jobs declare a light/heavy lane and the
  runner reserves light slots, so a heavy job can never take the last one. Filed as its
  own task.
- Commits pushed with `--from-main` carry no conversation trailer and so can never enter
  the ledger. Unchanged by this work, and still the reason I3 keeps `ledgerPushes` as
  positive-only corroboration.
- `pushesResource`'s loader reads the whole `pushes` table (3396 rows) as a param-less
  live resource — the unbounded-collection shape
  `research/2026-07-18-global-bounded-working-set-resource-contract.md` is migrating away
  from. It exists only as the cascade carrier for the attempts edge.
