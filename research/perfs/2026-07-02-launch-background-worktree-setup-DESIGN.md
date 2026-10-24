# Launch: background worktree setup + spawn (DESIGN — 2026-07-02)

> Design for the fix motivated by
> [`issue-launch-conversation-slow.md`](./issue-launch-conversation-slow.md). Read that issue
> doc first for the full evidence and Causes checklist. This doc is a design only — no code has
> landed. Status of the issue stays **(Ongoing)** until a fix lands AND is re-validated on
> `singularity`.

## Problem recap

Clicking **Launch** awaits `POST /api/conversations` end-to-end
(`launch-control.tsx:74` → `handleCreate` (fully sync) → `createConversation`
`lifecycle.ts:50-247`). The one expensive blocking step on that critical path is
`await setupWorktree(id, worktreePath)` (`lifecycle.ts:139` → `worktree.ts:57-77`), whose
`git worktree add -b <branch> <wtPath> main` does a full 8385-file checkout (~3.8 s uncontended,
up to ~13 s under the git index-lock + machine-contention amplifiers). The DB fork, config fork,
and Claude-CLI boot are already off the interactive path (async job / detached tmux). The checkout
is largely irreducible, so the cure is **structural**: stop blocking the interactive response on
it — insert the conversation row `starting` and return immediately, then run
`setupWorktree` + `runtime.create` in a durable graphile job, mirroring the `databaseForkJob`
pattern already living in the same function (`lifecycle.ts:147`).

## Decisions (confirmed with the user 2026-07-02)

This design was independently re-validated against the current code by three parallel Explore
passes (status lifecycle/poller, web rendering of a pre-spawn `starting` row, job infra + call
sites + cleanup) — all factual claims below held, and the two idempotency bugs in step 1–2 were
independently confirmed. Two open judgment calls were then decided:

- **Premature-`gone` risk → accept self-heal (no timeout change).** The `conversations.spawn`
  job leaves the row `starting`; the poller remains the single writer of `starting → gone` on the
  existing 30 s window and resurrects the row on a late successful spawn (`poller.ts:173-179`).
  Expected spawn is 4–13 s, comfortably inside 30 s; no schema change, no widened constant.
- **Scope → core cure + regression backstop.** Ship the background job + the two idempotency
  hardenings + the `> 1 s POST /api/conversations` slow-op alarm (step 6). The terminal-pane
  "Starting…" polish (step 5) is **deferred** — cosmetic, and the transient `can't find session`
  text is pre-existing and harmless.
- **Index-lock amplifier → its own follow-up task** (see Scope decisions); `add_task` it after
  this plan is approved.

## Altitude (named, per the `perfs-investigation` skill)

- **CURE for the interactive-latency symptom.** The wasted *wait* — the user's Launch spinner
  blocking on a 3.8–13 s subprocess — no longer happens. The blocking work is removed from the
  interactive path entirely; the client gets an id and opens the pane in ~one cheap-INSERT
  round-trip.
- **Containment / unchanged for the total git work.** The 3.8 s checkout still runs — now in a
  worker. `git worktree add` is irreducible (the agent needs a real full working tree), so making
  it *cheaper* was correctly rejected as a dead-end in the issue doc.
- **Out of scope at the throughput altitude:** the git index-lock amplifier (checkout serializing
  behind `worktree-cleanup.reap-stale`) is *removed from the interactive path* by this fix but the
  checkout job itself still serializes on the repo lock. That is a separate throughput issue (see
  Scope decisions).

Phase-4 counterfactual: if the same 13 s-amplified load recurs, the Launch button still feels
instant (row insert + return), and the checkout happens in the background where its wall-clock no
longer maps to perceived latency. That is the altitude intended.

## Proposed architecture

### New job: `conversations.spawn`

A new `defineJob` in `plugins/conversations/server/internal/` (sibling to `auto-start-jobs.ts`),
mirroring `databaseForkJob` (`fork-job.ts:14-39`):

```
name:   "conversations.spawn"
input:  { conversationId, attemptId, worktreePath, runtimeId, needsWorktreeSetup: boolean,
          create: { prompt?, model, effort?, resumeSessionId?, forkSession } }
event:  z.never()            // direct-enqueue only
dedup:  { key: (i) => i.conversationId }   // replace-if-not-running per conversation
maxAttempts: 5               // matches databaseForkJob
run:    if (needsWorktreeSetup) await setupWorktree(attemptId, worktreePath);
        await Runtime.get(runtimeId).create(conversationId, worktreePath, create);
        // on throw: recordNotification (deduped) + rethrow → graphile retries → dead-letter
```

- The job runs in-process (graphile worker), so `setupWorktree`, `worktreePathFor`, and
  `Runtime.get(...)` are all directly importable, exactly as they are in `lifecycle.ts` today.
- `runtime.create` reads `Bun.env.SINGULARITY_WORKTREE` for the parent host itself
  (`tmux-runtime.ts:672`), so nothing host-related needs threading through the job input.

### One job or two? — the new spawn job stays SEPARATE from `databaseForkJob`

Two independent jobs, each keyed by the same natural id (attempt/conversation), enqueued together:

- **The spawn does NOT depend on the DB fork.** The tmux session only launches the `claude` CLI;
  the CLI's first *worktree-DB* op happens later (an MCP `query_db`, or `./equin build`),
  not at boot. So there is no ordering dependency and coupling them would only serialize two things
  that can run in parallel (`git worktree add` checkout ∥ `pg_dump|pg_restore` fork). Keep them
  parallel. This also leaves `databaseForkJob` completely untouched.

### Refactored `createConversation` ordering

The only multi-second step is `setupWorktree`, and it fires **only in the new-attempt branch**
(`lifecycle.ts:117-149`). The reuse-attempt branch (`lifecycle.ts:111-116`, used by
fork-conversation / +Sonnet / fork-session) never calls `setupWorktree` — its worktree already
exists and its only spawn step (`runtime.create`) is sub-second. So we background **only the
new-worktree branch**, keeping the fast reuse path synchronous (no new job-pickup latency for the
interactive fork buttons, zero behavior change there — the minimal blast radius that still cures
the symptom).

New ordering (new-attempt branch):

1. Resolve fork/model/`spawnedBy` (unchanged; cheap).
2. `taskId` resolution + `createTask` if needed (unchanged; cheap DB).
3. `newAttemptId`; `worktreePath = await worktreePathFor(id)` — **derived purely from the id, so
   it is known before the worktree exists** (`worktree.ts:24-27`).
4. `await createAttempt({ id, taskId, worktreePath })` — a pure DB insert, **no disk access**
   (`attempts.ts:26-40`). Row can carry a path whose dir does not yet exist; `worktreePath` is
   just a `textField` string, never existence-checked at read time
   (`fields.ts:48`, `views.ts:218`).
5. `void forkConfig(thisAttemptId)` (unchanged; already fire-and-forget).
6. `await databaseForkJob.enqueue(...)` (unchanged).
7. Resolve prompt: `resolveAttachmentRefs`, preprompt bake (`wrapPreprompt`), effort — all cheap,
   **none touch the worktree** (task side-tables + config only). Do this here, in the endpoint, so
   the "what to run" decision stays in one synchronous place and the job body is pure slow I/O.
8. `insertConversation({ status: "starting" })` inside the existing try/catch that
   deletes the orphaned attempt on failure (`lifecycle.ts:156-178`). `starting` is both the DB
   default (`tables.ts:116`) and the app default (`conversations.ts:72`).
9. `await conversationCreated.emit(...)` — moved to fire right after insert (its subscribers —
   title-gen, queue-rank, preprompt snapshot — need only the row, never the session).
10. `await spawnJob.enqueue({ conversationId, attemptId, worktreePath, runtimeId,
    needsWorktreeSetup: true, create: {...} })`.
11. `return await getConversation(conversationId)` — a valid `Conversation` (view row, status
    `starting`).

The reuse-attempt branch keeps calling `runtime.create` inline with its existing mark-gone
try/catch (`lifecycle.ts:207-230`) — unchanged.

### Status model

No new status. `starting` already means "process spawning / worktree warming"
(`conversation-status.ts:3-9`) and the whole stack already treats a `starting` row with no live
session as a first-class, expected state (see Open Question 1). This design simply *widens the
window* in which that state is visible (from ~ms today to ~4–13 s), which the 30 s poller grace
window comfortably absorbs.

### Client impact

`useLaunchConversation.launch` (`launch-control.tsx:68-80`) is unchanged: it awaits the POST,
gets a `Conversation` with a real `id` and `status: "starting"`, and `openPane(conversationPane,
{ convId })`. The pane renders the normal "Starting…/No transcript yet" placeholder
(`jsonl-pane.tsx:173,257-264`) and flips to working/waiting within ~1 s of the job's spawn (poller
tick). The Launch spinner clears as soon as the POST returns (now ~tens of ms) instead of after the
whole checkout.

## Resolution of the open questions (with code evidence)

### OQ1 — Initial status + rendering of a pre-spawn row → RESOLVED (no gap)

- **Status:** `starting`, the existing DB + app default (`tables.ts:116`,
  `conversations.ts:72`). No schema change.
- **Poller does NOT prematurely kill it.** `poller.ts:33` `STARTING_TIMEOUT_MS = 30_000`, and the
  comment at `poller.ts:28-32` literally describes this exact case ("Grace window between
  insertConversation and the tmux pane becoming visible … a 'starting' row with no live session is
  normal (worktree git fork, claude warmup)"). At `poller.ts:219-221` a `starting` row younger
  than 30 s is `continue`d untouched. The clock is `dbRow.createdAt` (`poller.ts:220`), i.e. from
  insert time — a ~4–13 s spawn sits well inside 30 s. The poller **never deletes** a row; it only
  ever transitions to `gone`/`done`.
- **Terminal pane:** attaches `tmux -u attach -t <id>` unconditionally
  (`terminal-pane-body.tsx`, `pty-manager.ts:20-49`). If the session does not exist yet, tmux exits
  nonzero and the pane prints tmux's own `can't find session: <id>` text + `[Process exited]`
  (`terminal.tsx:76-77`) — **no app-level crash**, and it self-heals to a live PTY on the
  gone→live remount once the session appears (`terminal-pane-body.tsx:35-47`). This is the
  already-known cosmetic wart called out in `lifecycle.ts:216-218`; the window just gets longer.
  Optional minimal polish below.
- **JSONL viewer:** treats `starting` as `isWorking` and shows the "No transcript yet" placeholder
  (`jsonl-pane.tsx:173`); the server loader returns `[]` when there is no `claudeSessionId` and
  never touches the worktree/transcript (`jsonl-events-resource.ts:22-30`, ENOENT → `"none"` at
  `:37-51`).
- **Worktree-path loaders degrade, never crash.** `edited-files`, `commits-graph`, and
  `docs-button` all route through `runGit(args, cwd)` (`run-git.ts:3-16`), which returns `null` on
  a nonzero `git -C <missing-dir>` exit (128) and whose call sites guard on that null; the parcel
  watcher subscribe is wrapped in try/catch (`watch-edited-files.ts:73-109`). A missing worktree
  dir yields "no edited files / no commits", not an error.

**Minimal optional polish (recommended, not required):** gate the terminal pane on
`hasLiveProcess(status)`-style state and render a "Starting…" placeholder instead of attaching
while `status === "starting"`, to suppress the transient `can't find session` text over the wider
window. This is cosmetic; the fix is correct without it.

### OQ2 — Ordering / `worktreePath` → RESOLVED

`worktreePathFor(id)` is derived purely from the attempt id (`worktree.ts:24-27`), so the attempt +
conversation rows can be inserted first (client gets an id, pane opens), and the single spawn job
does `setupWorktree` then `runtime.create`. **Two jobs, not one** (spawn ∥ DB fork — no
dependency; the CLI needs the worktree DB only later, not at spawn). Ordering inside the spawn job:
`setupWorktree` MUST precede `runtime.create` (the tmux `-c <worktreePath>` needs the dir —
`tmux-runtime.ts:723`).

### OQ3 — Error handling in a retryable job → RESOLVED (idempotency + single gone-writer)

Mirror `databaseForkJob` (`fork-job.ts:22-38`): on any throw, `recordNotification` (deduped by
`spawn-error:<conversationId>`) + rethrow → graphile retries up to `maxAttempts` → dead-letters
(observable at `/api/jobs` + queue-health). Idempotency is the crux, and it is required anyway
because `ctx.step` does not protect a step that crashed *mid-execution* (retry re-runs it):

1. **`setupWorktree` must become idempotent AND stop swallowing real failures.** Today
   (`worktree.ts:57-63`) it awaits `git worktree add … .exited` and **ignores `exitCode`** — a
   genuinely failed checkout is silently treated as success, after which `runtime.create` spawns in
   a nonexistent dir. Redesign: `if (existsSync(wtPath)) return;` (idempotent — a retry after a
   completed add is a no-op; also covers the reuse branch uniformly), otherwise run the add and
   **throw on a nonzero exit that is not "already exists"** so the job actually retries a transient
   failure. This also fixes a latent swallow-failure bug (surface it per the footgun rule — a
   `git worktree add` failure should be loud).
2. **`runtime.create` (tmux spawn) must become idempotent.** Today `tmux new-session -s <id>`
   throws on a duplicate session (`tmux-runtime.ts:737-741`), so a retry after a crash *between*
   spawn and job-commit loops forever. Redesign: no-op if a live session for `conversationId`
   already exists (a `tmux has-session -t <id>` probe in the runtime, exposed as a small addition
   to the `Runtime` interface). With this, the job body mirrors `databaseForkJob` exactly:
   idempotent operations + rethrow + `maxAttempts` + deduped notification. (`ctx.step` from the
   jobs API is an available alternative for exactly-once, but operation-level idempotency is needed
   regardless for mid-step crash safety and matches the sibling job's precedent — so prefer it.)
3. **Single writer for `starting → gone`: the poller.** On retry exhaustion the job does NOT mark
   the conversation `gone` — it leaves the row `starting` and lets the poller's existing 30 s
   timeout (`poller.ts:219-238`) own the UI transition to `gone` (via `markConversationGone`,
   `conversations.ts:162-181`; `decideMissingProcessAction` returns `"gone"` for a session-less
   `starting` row — `hibernation-decision.ts:22-24`). This keeps a single writer of that transition
   (no job↔poller race) and self-heals: if a late successful attempt spawns tmux after the poller
   flagged `gone`, the poller "resurrects" it to working/waiting (`poller.ts:173-179`). Accepted
   tradeoff: on a *hard* total failure the pane shows "Starting…" for up to 30 s before flipping to
   `gone`, but the failure notification fires immediately and hard checkout failures are rare.
- The pre-insert cleanup path is unchanged: if `insertConversation` itself throws, the orphaned
  attempt is deleted and the error rethrown (`lifecycle.ts:170-178`) — the client sees the failure
  synchronously, exactly as today.
- Enqueue is post-insert and non-transactional, mirroring the existing `databaseForkJob.enqueue`
  (`lifecycle.ts:147`). A cleaner future improvement is atomic row+job via `enqueue({ tx })`
  (`registry.ts:109-126`) wrapping `createAttempt` + `insertConversation` + both enqueues in one
  `db.transaction` — noted, but out of scope to match precedent and avoid threading `tx` through
  the tasks-core mutation helpers.

### OQ4 — The still-forking-DB race → NOTED, not worsened

The race (a spawned agent's first worktree-DB op hitting a still-`pg_restore`-ing fork) already
exists today: `databaseForkJob` runs async in a worker (~7.4 s) while `setupWorktree` (~3.8 s) +
tmux spawn happen inline, so the CLI can already boot before the fork completes. Backgrounding the
setup does not materially change the relative timing — both fork and spawn become worker jobs
starting at ~the same wall-clock, and the CLI's first DB op is still deferred to build/MCP time.
**Do not couple them** (that would serialize two parallelizable steps and slow launch). If we ever
want to close the race it belongs in its own issue: the spawn job could gate its `runtime.create`
on a fork-complete signal (`ctx.waitFor` on a fork-done event, or a "canonical DB exists" probe)
— explicitly out of scope for the launch-latency symptom.

## Scope decisions (explicit)

- **Git index-lock amplifier — OUT of scope for this fix; file as its own issue.** Backgrounding
  the checkout removes index-lock queueing from the *interactive* path (the win we want), but the
  checkout *job* still serializes on git's repo-level lock against `worktree-cleanup.reap-stale`'s
  repeated `git worktree remove` (`worktree.ts:79-90`) and other concurrent adds. That is a
  worker-throughput concern, not interactive latency, so it must not block this fix. Recommended
  follow-up (its own perf doc): bound concurrent host-wide git worktree *mutations* (add/remove)
  through a fair cross-process semaphore — `packages/host-semaphore` already provides
  `createHostSemaphore` (flock slot files) — and/or make `reap-stale` yield the lock between
  removes / be bounded per tick. `add_task` it.
- **Boundary invariant — recommend a monitoring backstop, not a static lint.** The durable
  invariant is "the interactive `POST /api/conversations` response must never await worktree-scale
  subprocess work"; the structural enforcement is the pattern itself (setup+spawn always via the
  job). There is no clean static rule for "don't await a subprocess in an endpoint," so the
  enforceable backstop is a runtime alarm: file a slow-op/report when `POST /api/conversations`
  in-process `workMs` exceeds ~1 s (the runtime-profiler + slow-ops pipeline already exists). This
  is containment-style regression detection, and it is the right altitude here — it catches any
  future re-introduction of blocking work on this path without a brittle syntactic rule.

## Step-by-step implementation plan

1. **Harden `setupWorktree` (`worktree.ts:57-77`) for idempotency + loud failure.**
   `existsSync(wtPath)` early-return; capture `git worktree add` `exitCode`, throw on a genuine
   failure (treat "already exists" as success). Keep `copyTsBuildInfoToWorktree` + `mise trust`
   best-effort. (Fixes the latent swallowed-failure bug.)
2. **Make the tmux runtime spawn idempotent.** Add a `has-session`/`isRunning(id)` probe to the
   `Runtime` interface (`runtime.ts`) + tmux impl (`tmux-runtime.ts`); `create` no-ops if a live
   session already exists.
3. **Add `conversations.spawn` job** in `plugins/conversations/server/internal/spawn-job.ts`
   (mirror `fork-job.ts`): input schema above, `dedup` keyed on `conversationId`, `maxAttempts: 5`,
   deduped `recordNotification` + rethrow on failure. Register it in the conversations server
   `register: [...]` list.
4. **Refactor `createConversation` (`lifecycle.ts`).** In the new-attempt branch: drop the inline
   `await setupWorktree` (line 139); after `insertConversation` + `conversationCreated.emit`,
   enqueue the spawn job with the resolved `create` opts; return `getConversation(id)`. Leave the
   reuse-attempt branch (inline `runtime.create` + mark-gone) unchanged. Move the
   `conversationCreated.emit` to fire right after `insertConversation` for both branches.
5. **(DEFERRED — not in this fix)** Terminal pane "Starting…" placeholder. Cosmetic; the
   transient `can't find session` text is pre-existing and harmless. Left as a follow-up.
6. **(IN SCOPE — regression backstop)** Add the >1 s `POST /api/conversations` slow-op report,
   reusing the existing runtime-profiler + slow-ops pipeline, so any future re-introduction of
   blocking work on this endpoint is caught automatically.
7. Verify `maybeLaunchTaskJob` (`auto-start-jobs.ts:76-81`) and the fork/resume paths still work
   (they call the same `createConversation`; no signature change).
8. `./equin build`; run the manual verification plan; then re-validate on `singularity`
   before flipping the issue to `(Completed)`.

## Risks

- **Spawn job pickup latency.** The new-attempt spawn now waits for a graphile worker to pick up
  the job. Fast when the worker is idle, but under a job backlog the agent's session could start
  noticeably later (the *pane* is still instant; only the underlying spawn is delayed). Mitigation:
  keep the spawn job's `maxAttempts`/priority sane; validate pickup latency under load. If backlog
  starves it, consider a dedicated queue/priority — but do not add polling.
- **>30 s spawn → premature `gone`.** If the spawn job is delayed past 30 s (severe backlog or
  repeated retries), the poller flags the row `gone`. Self-heals via resurrection when the spawn
  finally succeeds (`poller.ts:173`), but the user briefly sees "Disconnected". Acceptable; the
  30 s window is generous vs the ~4–13 s expected spawn.
- **Idempotency correctness.** The whole retry story rests on `setupWorktree` and `runtime.create`
  being genuinely idempotent (steps 1–2). If either regresses, retries loop or brick the worktree.
  Covered by the manual verification's forced-failure case.
- **Auto-start / dependency-launch path.** `maybeLaunchTaskJob` calls `createConversation` from a
  worker; the refactor keeps the signature and return, and the emit still fires — but this path
  must be exercised (verification below) since it is the non-interactive caller.
- **Config fork race.** `void forkConfig(id)` stays fire-and-forget; unchanged risk.

## Manual verification plan

Confirm BOTH halves: launch feels instant AND the agent still ends up correctly running.

1. **Instant response.** With the app deployed on the worktree, click Launch on a task and measure
   `POST /api/conversations` (DevTools network / `get_runtime_profile`). Expect **tens of ms**
   (single-row INSERTs), down from ~3.8 s. The conversation pane opens immediately showing
   "Starting…".
2. **Agent actually runs.** Watch the same conversation flip `starting → working` within ~1–2 s
   (poller tick after the spawn job completes); confirm a real tmux session
   (`tmux ls | grep <convId>`), a live worktree dir on disk (`.claude/worktrees/<attemptId>`), and
   the JSONL transcript streaming into the pane. Open the terminal pane and confirm it attaches to
   a live PTY (no lingering `can't find session`).
3. **DB fork still lands.** Confirm the worktree DB fork completes (query_db against the worktree,
   or `/api/jobs` shows `database.fork` success) — proving the two jobs ran in parallel.
4. **Contended launch (the 13 s case).** Fire a launch while `worktree-cleanup.reap-stale` is
   running (or several launches at once). The POST must still return in ~tens of ms; only the
   background spawn job absorbs the git-lock queueing. This is the core counterfactual.
5. **Forced-failure idempotency.** Temporarily make `setupWorktree` throw on first attempt (or kill
   the backend mid-spawn), then let graphile retry: confirm the retry completes the spawn exactly
   once (no duplicate tmux session, no bricked worktree) and the deduped notification appears.
   Confirm retry-exhaustion leaves the row `starting` → poller flips it `gone` at 30 s → a late
   manual success resurrects it.
6. **Reuse path unchanged.** Use +Sonnet / fork-session on a live conversation; confirm it still
   spawns synchronously into the existing worktree with no regression.
7. **Auto-start path.** Arm a task's auto-start behind a dependency; settle the dependency; confirm
   `maybeLaunchTaskJob → createConversation` launches the queued conversation correctly.

## Could NOT be resolved from code alone (needs runtime measurement)

- **Graphile spawn-job pickup latency under realistic backlog** — whether the pane-instant win is
  paid back by a slow actual spawn when the queue is busy. Needs a live measurement on
  `singularity` (verification steps 1–2 + 4).
- **The 13 s→instant claim end-to-end** — must be re-validated on `singularity` (not just the
  worktree) per the doc-currency rule before the issue is promoted to `(Completed)`.
- **The index-lock amplifier's real magnitude** (the deferred issue) — still needs the Phase-2
  launch-during-reap trace the issue doc's Next steps calls for; unaffected by this fix.
