# Debug → Tests: harvested test verdicts, idle reruns

Prototype: `proto-1794359466-z7rugl` (`~/.equin/apps/prototypes/proto-1794359466-z7rugl/index.html`).

## Context

Tests are never run automatically, so nobody knows which of the ~2,600 test files (≈2,140 bun, ≈430 vitest/jsdom) are green on main. We want a Debug page showing every test file's last known status, as a plugin tree coloured by worst status.

Constraints set by the user:

- **No added test-running cost.** Nothing runs on push. Verdicts are *harvested* from the `./equin test` runs agents already do, in any worktree. Lag is acceptable.
- **The page is the report.** No reports and no notifications for failing tests. Investigate mints a task only when clicked.
- **Extra runs happen only when the host is idle**: no agent working, no op running, no duress, sustained for 10 min. They are preempted as soon as that ends.

Core idea: a verdict is keyed by **(test path, digest of its import closure + runner inputs)**. Main's status for a file is the set of verdicts whose digest equals *main's current* digest for that file. A worktree run on code that later lands unchanged lights up automatically; no "does this match main" logic is needed.

## Decisions

### 1. Placement

```
plugins/framework/plugins/cli/plugins/test/            (exists) harvest producer
  core/internal/junit.ts         parseJunit → also per-file {cases, failed, timeMs} + failure {message, detail}
  core/internal/run-record.ts    TestRunRecord zod (v1), write/read/list
  data-dirs/                     testRunRecordsDir = ~/.equin/state/test-runs/  (host-global)
  cli/run.ts                     digests → run → write record (leader only)
  plugins/digest/                NEW, the ONE digest implementation (core/ + cli/ only, never server/)
    core/  testDigests(), runnerInputsKey(), TEST_DIGEST_VERSION
    cli/   `./equin test-digest --out <file>`  (whole checkout)

plugins/debug/plugins/tests/                           NEW: Debug → Tests
  core/    collections, values, runNow endpoint, deriveStatus() (pure)
  server/  tables, record ingest, recomputeFileStatus, checkout-digest + run-now jobs
  web/     tree pane + file detail pane, sidebar entry
  plugins/idle-runner/   (phase 2)

plugins/infra/plugins/host/plugins/idle/               NEW (phase 2): host idle signal
  core/    hostIdle liveValue, IDLE_SUSTAIN_MS, nextIdleState() (pure)
  server/  IdleBlocker contribution kind, evaluate job, host.idleBegan / host.idleEnded events
  plugins/ops/     blocker: live-op markers (excluding opportunistic ops)
  plugins/duress/  blocker: duress latch + lease-expiry recheck
plugins/conversations/plugins/idle-blocker/            blocker: agents busy
```

Why this placement:

- Debug depends on framework, never the reverse.
- The digest has no `server/` folder, so plugin-records (build tooling) never enters a backend closure (`boot:closure-digestable`).
- Idle blockers are an open contribution collection: the idle core names no contributor.

### 2. The digest (one implementation, shared by the CLI and main)

Built on plugin-records' module graph (`plugins/plugin-meta/plugins/plugin-records/core/internal/module-graph.ts`). It has one Merkle key per module and per-file facts cached by blob id in the host-shared store, so overlapping closures cost one walk. `source-digest`'s `computeDigest` was rejected: ~65 ms per file (~3 min for all of them), and it refuses 11% of tests. Precedent: `plugins/framework/plugins/cli/plugins/migrations/cli/drizzle-verdict.ts`.

```ts
digest(f) = recordKey(TEST_DIGEST_VERSION, store.environment /* bun version + platform */,
  await npmResolutionsKey(snapshot), runnerInputsKey(runnerOf(f)), f, graph.keyOf(f))

runnerInputsKey("bun:test") = bunfig.toml + staticClosure("test/bun-preload.ts")   // dynamic edges cut
runnerInputsKey("vitest")   = staticClosure("vitest.config.ts") ∪ staticClosure("test/setup.ts")
```

- One `buildModuleGraph` call covers all files, using `repoSnapshotNow(root)`, which includes dirty and untracked files.
- The preload's static closure only: its `await import(machine.generated)` would otherwise fold ~3.4k files into every bun digest.
- **Blind spots**, documented in the plugin's CLAUDE.md:
  - machine providers the preload loads dynamically
  - `import.meta.glob`
  - fixtures read from disk
  - spawned processes
  - env vars
  - migrations
  - the `@composition-web-registry` alias
- These are bounded by the idle runner's weekly re-verification (§7).

### 3. Capture in `./equin test` (`test/cli/run.ts`)

1. **Before `withDirectOp`:** `snapshot` → `testDigests(found)`. This runs sequentially, before the runners start, so no file changes mid-graph. It prints its time (target < 0.5 s for one plugin, < 3 s for the whole tree when the store is warm). If digesting fails, the run prints one loud line, the harvest is skipped, and the tests still run. The agent's run never fails because of the harvest.
2. **`runnerOutcome`** extracts per-file results from the enriched JUnit *before* it deletes the XML. A pure `fileResults()` attributes them:
   - a file in the report → `passed` or `failed`, with case counts and duration;
   - a file missing from the report while the runner exited non-zero → `not-loaded`;
   - a runner that wedged or wrote no report → **no rows** for its files. Runner-level failures stay on the run.
3. **After the verdict, leader only.** The single-flight `adopt` path writes nothing. If the tree hash changed during the run, nothing is harvested. Otherwise an atomic write to `~/.equin/state/test-runs/<opId>.json`:
   - fields: `{v, opId, repo, slug, origin, head, treeHash, startedAt, finishedAt, digestVersion, runners[], files[{path, runner, digest, outcome, cases, failedCases, durationMs}], failures[{path, caseId, message, detail≤4KB}]}`
   - `origin` comes from env `EQUIN_TEST_ORIGIN` (`agent` by default, `idle`, `run-now`), declared in `infra/launcher` env-names, so the command still takes paths only.
   - Records older than 14 days are pruned.

### 4. Data model (`debug/tests/server/internal/tables.ts`, `defineEntity`)

| table | key | columns |
|---|---|---|
| `test_runs` | `op_id` | slug, origin, repo, head_sha, tree_hash, started_at, finished_at, digest_version, runners jsonb, file_count, failed_count |
| `test_file_results` | (`op_id`, `path`); idx (`path`, `digest`), (`path`, `finished_at` desc) | runner, digest, outcome, cases, failed_cases, duration_ms, finished_at |
| `test_case_failures` | (`op_id`, `path`, `case_id`) | message, detail |
| `test_checkout_digests` | `path` | digest, runner, plugin_id, generation |
| `test_digest_generation` | single row | generation (tree hash), head_sha, state (`computing`/`ready`/`failed`), computed_at, file_count, error |
| `test_file_status` (derived) | `path` | plugin_id, runner, status, last_outcome, last_ran_at, last_op_id, last_origin, last_slug, cases, failed_cases, duration_ms, history jsonb (last 16) |

- **`test_file_status`** is written only by `recomputeFileStatus(db, paths | "all")`: one `INSERT … SELECT … ON CONFLICT` plus a delete of paths no longer in the checkout. It is a plain table, so `serveCollection` stays on the change feed.
- **Status rule.** `deriveStatus` is pure, lives in `core/` and has its own tests. Among results on the current digest:
  - both a pass and a fail → `flaky`
  - only failures → `failing`
  - only passes → `passing`
  - no result on the current digest but older results exist → `stale`, carrying `last_outcome`
  - no result at all → `never`
- **`plugin_id`** comes from `pluginIdOfRepoPath(rel)`. This promotes plugin-records' internal `relOwner` to `framework/plugin-id/core`; don't copy it.
- **Retention:** a daily `tests.results-cap` job keeps the newest 32 results per path. It is not a TTL, because a TTL would delete a stable file's only verdict.

### 5. Ingest (op-store style, on every backend)

- A `defineFileWatcher("tests.run-records")` on the records dir, plus one pass in `onReady`, triggers a coalesced pass (`createCoalescer`).
- A pass skips `opId`s already ingested and parses each new record. Per record, one transaction inserts the run, its results and its failures (`ON CONFLICT DO NOTHING`), then calls `recomputeFileStatus(paths)`.
- A malformed record is reported once via `reportServerError`. This is an infrastructure error, not a test failure. An unknown `v` is left in place.
- Ingesting on every backend, rather than a single drainer, means a worktree's page shows real data while it is being developed, with no drainer lock and no delete race.

### 6. Main's digests: only when the page is open

- The `tests.digest-generation` liveValue's `serveValue` uses `whileSubscribed`. On subscribe, and on `onRefHead` while subscribed, it compares `computeTreeHash(REPO_ROOT)` to the stored generation. If they differ, it marks the row `computing` and enqueues the supervised job `tests.checkout-digests`.
  - The job runs `./equin test-digest --out <state file>`, the same pattern as `type-check/backstop/server/internal/backstop-job.ts`.
  - Its `onEnded` replaces `test_checkout_digests` and the generation row in one transaction, then runs `recomputeFileStatus("all")`.
- Repeated opens on the same tree are free. **Nothing is computed on push** unless the page is open.
- Not-known-yet:
  - no generation yet → DataView `loading`, "Computing test digests for main @ abc…";
  - recomputing → previous statuses plus "as of main @ def · recomputing for abc".

### 7. Idle signal and idle runner (phase 2)

**Idle signal (`infra/host/idle`):**

- `IdleBlocker({ id, read(): Promise<{busy, label(n), recheckAt?}> })`. A blocker calls `requestIdleEvaluation()` when its input changes:
  - **ops:** `defineFileWatcher` on `~/.equin/locks/live-ops/`. It reads the flocked markers (infra/worktree's host-wide listing) and excludes `opportunistic` ones. It does not read `op_log_ops`, a ledger whose emptiness is not evidence of no ops.
  - **duress:** a watcher on the latch dir. `readFreshDuress()` with `recheckAt = mtime + FRESHNESS_LEASE_MS`, because a lease lapse emits no event.
  - **agents** (`conversations/idle-blocker`): a `conversation.statusChanged` trigger, and `read` counts conversations in `starting`/`working` (`isAgentBusy`).
- The main-only singleton job `host-idle.evaluate` runs the pure `nextIdleState(prev, blockers, now)`:
  - busy → `busy`
  - all quiet → `settling`, recording `quietSince`
  - quiet for 10 min → `idle`
- It writes `host_idle_state` and re-enqueues itself with `runAt: wakeAt` (the sustain end, or a duress recheck). That is the jobs' single timer, not polling. **Verify** that a keyed `runAt` re-enqueue moves the pending row; if not, use a separate keyed sustain job.
- It emits `host.idleBegan` / `host.idleEnded` on transitions.
- The `hostIdle` value carries `{state, quietSince, idleSince, blockers[{id, busy, label}]}`, which feeds the header pill ("Idle run waiting · 3 agents working").

**Opportunistic op tag:**

- With env `EQUIN_OP_OPPORTUNISTIC=1`, `withDirectOp` (`op-runtime/cli/direct-op.ts`) uses the `background` lane at `low` priority. It writes `opportunistic: true` into the op marker (`WorktreeOpInfo`) and into `OpIdentity`.
- Main's banner reads "Idle test run · yields to work" instead of "Test in progress".
- The ops blocker ignores opportunistic ops, so the runner's own op doesn't end idle.

**Idle runner (`debug/tests/plugins/idle-runner`):**

- On `host.idleBegan`, it first makes the digest generation current (idle CPU), then enqueues a supervised `tests.idle-batch`:
  - argv `./equin test <paths…>`, run in main's checkout
  - env `EQUIN_OP_OPPORTUNISTIC=1`, `EQUIN_TEST_ORIGIN=idle`
  - `lock: "idle"`, `runAttempts: 1`
- **Batch selection** (pure): stale-and-last-failing first, then never-run, then stale by oldest run. When none are left, verdicts older than 7 days (the blind-spot sweep). A batch stops at 60 s of last-known duration or 25 files.
- `onEnded` waits for ingest, then enqueues the next batch only while still `idle`.
- **Preemption:** on `host.idleEnded`, `cancelSupervisedJobByLock(idleBatch, "idle")`. SIGTERM makes the test CLI exit cleanly and reap the runner groups. A cancelled run writes no record, so at most one batch is lost.

### 8. Run now and Investigate (phase 1)

- The owner-only endpoint `tests.runNow({ paths })` starts the supervised job `tests.run-now` (`./equin test …`, origin `run-now`, normal priority). It runs from the file pane and from Run stale / Run all.
- Progress is indeterminate ("Running N files"): JUnit only exists at the end, so this departs from the prototype's per-file progress.
- `<InvestigateAction>` (`primitives/launch/investigate`) with a `test-file` subject (`tasks/task-subject`) is shown for failing and flaky files only. It mints a task on click.

### 9. Web UI (`debug/tests/web`, following the prototype)

- **Panes:** `testsPane` at `/debug/tests` and child `testFilePane` at `file/:path`, registered with `Pane.define`, `defineRoute` and `DebugApp.Sidebar`, like `plugins/debug/plugins/mcp-tools/web/panes.tsx`.
- **Header:** "N files on main @ sha", the verdicts on current code, the digest-generation line, the idle pill (phase 2), and Run stale / Run all.
- **Summary cards and stacked bar:** counts per status from `useLive(testFileStatus)`, an `all` collection with `unbounded: { reason, budget: 4000 }`. The cards double as the status filter, stored as a route param.
- **Tree:** an in-memory `DataView` with `views={["table"]}` and `hierarchy`, over `PluginRow | FileRow` built by a pure `buildTestTree()` (template: `plugins/apps/plugins/studio/plugins/explorer/web/internal/flatten-plugin-tree.ts`).
  - Plugin rows carry subtree counts, the worst status (failing > flaky > stale > passing > never), a mini bar and the file count. Child plugins come before files.
  - File columns: status dot (stale = ring around the last-known verdict), file, runner, failed/total cases, duration, a 16-run history (dimmed when stale), and ran-ago.
- **Detail pane:**
  - status, runner, path, cases, duration, digest, last run
  - Run now / Open file / Investigate
  - failing cases with message (`testCaseFailures`)
  - why flaky
  - recent runs: a DataView over a `testFileRuns` window filtered by path, showing who ran each run (attempt / idle run / Run now) and whether it ran current or older code
- "Broke in" is phase 3.

## Phases

1. **Harvest and page:** JUnit enrichment, run records, the digest plugin and verb, capture in `run.ts`, tables, ingest, recompute, checkout digests, Run now, Investigate, the UI.
2. **Idle:** the opportunistic op tag (op-runtime, worktree marker, op-log, banner), `infra/host/idle` with its three blockers, the idle runner with preemption.
3. **Later:** "Broke in" (the push between the last green and first red runs that touched the file's closure), and tuning the flaky window.

## Risks

- **Digest time is the only cost added to agents' runs.** If it goes over target, run a perf investigation; don't hide it.
- **JUnit path attributes (bun `file`, vitest suite `name`)** must be normalized against the `found` set, with a loud failure on mismatch.
- **A supervised `./equin test` child.** Check that the foreground-handoff and orphan guards behave; `type-check-backstop` is the precedent.
- **False `flaky`** can come from blind spots. The detail pane shows which origins disagreed.

## Verification

- **Unit and DB tests:**
  - junit fixtures (bun and vitest, with passing cases, time and messages)
  - `fileResults`
  - digest stability: the same content across snapshots is equal; a dependency edit moves it; an unrelated edit doesn't; `bunfig.toml` moves only bun digests; a dynamic-only preload edit doesn't
  - `deriveStatus` and `recomputeFileStatus`, all five statuses plus removed files
  - ingest idempotency and malformed records
  - `buildTestTree`
  - `nextIdleState`
  - batch selection
- **Commands:**
  - `./equin test plugins/framework/plugins/cli/plugins/test plugins/debug/plugins/tests plugins/infra/plugins/host/plugins/idle`
  - `./equin check`
  - `./equin build --migration-name tests-status`
- **Live:** `./equin test plugins/packages/plugins/coalesce`, then:
  1. the record exists in `~/.equin/state/test-runs/`;
  2. `query_db` shows a `test_runs` row;
  3. `/debug/tests` with the `browser_*` tools shows the generation computing, then coalesce `passing` and the rest `never`.
- **Screenshots:** the `screenshot.ts --path /debug/tests` script, plus the detail pane, then `compare-diff.ts --name proto-1794359466-z7rugl` after adding `mocks` = `route:/debug/tests` to the prototype.
- **Phase 2:** stop agents and confirm `settling` then `idle` after 10 min; an idle batch shows as opportunistic in Ops; starting `./equin check` cancels it (`cancelled_at` set).

## Implementation notes (phase 1)

Deviations from the decisions above, and why:

- **Record schemas live in a leaf sub-plugin, `framework/cli/test/plugins/record`** (core only), not `test/core/internal/run-record.ts`: `test/cli` imports the digest and the digest's CLI writes the checkout-digests file, so a schema in `test/core` made `test ↔ digest` a plugin cycle. Writers (`test/cli/harvest.ts`, `digest/cli`) and the reader (`debug/tests`) all import the leaf. Read/write/list are not in `core/` (it may not reach `data-dirs`): the CLI writes, `debug/tests/machine` reads.
- **The tree hash is computed by the child, not the backend.** `computeTreeHash` lives in `checks/core`, which would put the check runner in every backend's closure. The `tests.digest-generation` value's `whileSubscribed` (and an in-process ref reaction on `refs/heads/main`, while subscribed) enqueues `tests.checkout-digests` with `--unless-tree <stored generation>`; `./equin test-digest` hashes the tree and writes `unchanged` when it matches. So a page open on an unchanged tree costs one child + one tree hash, not zero.
- **`debug/tests` has a `machine/` half** (desktop-only): the ingest watcher, the checkout-digests job + the generation value, and the run-now job + endpoint (`needsMachine`). `server/` is portable: tables, `recomputeFileStatus`, `ingestRunRecord`, the collections, the cap job, the Tests task category.
- **Single-column keys.** `test_file_results.id = <opId>:<path>`, `test_case_failures.id = sha256(opId, path, caseId)` (both `externalIdField`, derived), so `testFileRuns` can be a window collection and `testCaseFailures` a scoped `all` set by `(opId, path)`. `test_file_status` also carries `digest`, `current_passed` / `current_failed` (for "why flaky").
- **`deriveStatus` runs in JS**, not SQL: `recomputeFileStatus` reads the checkout digests and results and upserts in chunks, so the rule exists once.
- **`plugin_id`**: `pluginDirOfRepoPath` / `pluginIdOfRepoPath` added to `framework/plugin-id/core`; plugin-records' `relOwner` now delegates to it.
- **Run now**: one supervised job per set of files (`lock` = hash of the sorted paths); the UI shows a toast "Running N files", no in-page progress. "Open file" was not added (no checkout file pane addressable from Debug without a workspace context).
- **Detail route** is `test-file/:path*` (a `file/…` child collided with another pane's grammar).
- Harvest failure is loud, non-fatal, and typed (`startHarvest` → `{ ok }`); a file that cannot be scanned (a syntax error) skips the harvest of that run.

Measured (warm host-shared record store, this worktree): one plugin (coalesce) ≈ 0.5–0.6 s added to a run (snapshot ~0.37 s, digest ~0.2 s); whole tree (2,577 files) ≈ 1.8 s (snapshot 0.4 s + digest 1.4 s), `./equin test-digest`. Cold store (files never scanned) is several seconds. The one-plugin cost is over the 0.5 s target, dominated by `repoSnapshotNow` (a second git pass after `computeTreeHash`) — a follow-up.

## Implementation notes (phase 2)

- **Sustain timer is a separate job.** Verified: a singleton/keyed enqueue with `runAt` does move the pending row (graphile `add_job` default `replace` mode, `jobs/machine/internal/graphile-queue.ts`). But a running row releases its key, so a blocker's request landing mid-evaluation is a fresh row due now, and the evaluation re-enqueueing itself with `runAt = sustain end` would push it minutes out. So `host-idle.evaluate` (singleton, serial) never schedules itself; `host-idle.wake` (singleton, `runAt`) is the one timer and only enqueues an evaluation.
- **`hostIdle` (`host.idle`)** is refused `main-only` off the host singleton (`isHostSingleton`, not `isMain`), and `host_idle_state` is `ExcludeFromFork` (a fork's copy would claim idle forever). Its schema has an `unevaluated` arm for "no evaluation yet".
- **A blocker read that throws** counts as busy; the evaluation writes the state, emits, then throws (`AggregateError`), so it is reported and safe.
- **Duress blocker** uses `recheckAt = read time + FRESHNESS_LEASE_MS` (an upper bound on the lapse, no latch API change); its watcher asks for an evaluation only when freshness flips (the sentinel bumps the mtime every tick).
- **Agents blocker** counts `starting`/`working` conversations in main's DB — every app-launched conversation on main. Not seen: conversations a worktree backend launched (they live in its fork) and Claude Code sessions started outside the app. Their builds/tests are seen by the ops blocker. A host-wide agent-process signal would close the gap; not built.
- **Opportunistic tag**: `withDirectOp` reads `EQUIN_OP_OPPORTUNISTIC=1` (never for a nested op) → lane `background`, priority `low`, `opportunistic` on the marker (`markWorktreeOpStart(…, { opportunistic })`), on `OpIdentity` (wire field optional: older lines read `false`) and on `op_log_ops.opportunistic`. The op-status banner reads `Idle test run — yields to work` (`opWording`).
- **Failing tests are not job failures.** `./equin test` now exits **2** (`TESTS_FAILED_EXIT`, in `test/plugins/record` so backends don't load `test/core`'s sync fs) when the tests ran and some failed, and 1 when the run could not be done. `defineSupervisedJob` gained `verdictExits` (built-in ledger: such an exit ends `done`, no dead-letter); `tests.run-now` (phase 1, which had this bug) and `tests.idle-batch` declare it.
- **Digests before batches**: `tests.checkout-digests`' `onEnded` emits a new `tests.digestsSettled` event (computed / unchanged / failed); the idle runner's `idleBegan` job asks for digests and `digestsSettled` starts the next batch. Phase 1's event-less `events.ts` was renamed `tables-events.ts` (the drizzle schema glob is `tables*.ts`).
- **Loop guard**: files a batch already took in the current idle period are not re-picked (process memory, cleared on `idleBegan`), so a file whose run yields no record (tree moved mid-run) cannot loop.
- **Pill**: loading → `Loading`; refused → "Idle runs: on main only"; otherwise `idlePillText` (busy → "Idle run waiting · <busy blockers' labels>", settling, idle → "Machine idle · running stale tests"). The refused read shows a 422 in the browser console (the live protocol's refusal status), not an error state.
