# App health, 24 h after the fixes: before → after, what still fires, and why

Task: task-1794149503 (replaces task-1793869665-zgven5, folds in task-1793847634-0disv8).
Supervisor audit: task-1793826400-nd8if7 (conv-1793826401-qkoz6t). Its record is on the pages
"App health audit (session)" and "App health progresses".

**Window:** 2026-11-07T14:50Z → 2026-11-08T14:50Z, on main (namespace `singularity`).
**Sources:**
- main's DB: `reports`, `notifications`, `traces`, `build_runs`, `attempts`, `job_runs`, `dead_jobs`;
- main's logs: `~/.equin/worktrees/singularity/logs/*.jsonl`;
- the gateway's logs: `~/.equin/logs/gateway/{gateway,singularity}.log`.

## 0. Read this first: the window was quiet

| activity | 11-04 (before) | 11-06 (busy, after most fixes) | window |
| --- | --- | --- | --- |
| pushes to main | 104 | 82 | 10 |
| attempts started | 151 | 128 | ~20 |

The 24 h window is a weekend with about 10× less agent traffic than the baseline day. So a raw
drop in a rate that scales with traffic (boots, installs, slow ops) overstates the fix. Where
11-06 has the data, it is given as a second, busy "after" column. Classes that do not scale with
traffic (Bun crashes, the runs-dir bug, check stalls per check run) are judged per occurrence.

**How to count:**
- `reports.count` is cumulative since the report was first seen.
- In-window occurrences come from `reports.recent` (the newest 10), the `traces` rows, and the logs.
- A notification's `×N` is **the report's lifetime count when it fired**, not what happened in the
  window. `×2717 wait background-acquire` is the lifetime total, re-shown at a boot; the window
  had ~31 (§2.3).

## 1. Exit criteria: before → after

| criterion (2026-11-04 baseline) | before | 11-06 | **window** | verdict |
| --- | --- | --- | --- | --- |
| backend-never-ready (`boot-wedge` reports) | ~11,300/day | 0 (last report 11-05 16:52Z) | **0**; 22 boots across 136 worktrees, none never-ready | ✅ fixed |
| event-loop stalls > 3 s (main) | 53 traces / 13 reports (target < 5) | 1 / 0 | **0 / 0** | ✅ met |
| short stalls 0.5–3 s (share of 10 s windows) | 10 % (5.1 % after 11-05) | 114 traces | **1 trace (1 of 6,498 windows, 0.015 %)** | ✅ |
| unanswered-sub (live-state wedge) | 10–27/h | — | **1 in 24 h** | ✅ fixed (§2.9) |
| live-state missed updates | 2.4/day | last one 11-06 | **0** | ✅ |
| ResizeObserver loop | 85/day | ~1 | **1** | ✅ fixed (one residual site, §2.9) |
| slow-db traces | 231/h (2,642 on the UTC day) | 221/day | **3/day** | ✅ (low traffic helps) |
| check-thread-stall | ~150/day | — (cumulative rows only) | **~160/day pace** (20 in 3 h on 11-08) | ❌ unchanged (§2.5) |
| main boots | 74/day | 51 | **6** = 4 deploys + **2 Bun segfaults** | ✅ deploy side; ❌ crashes (§2.1) |
| deploys that skipped the restart | 0 (21 of 74 were wasted) | — | **4 of 8** main deploys kept the running backend | ✅ works |
| report notifications/day (what the user sees) | 687 (216 errors) | 371 (32) | **156** (59 errors) | ↓, but per push it is worse: ~16 per push vs 6.6 |

**Summary:** every criterion the audit targeted held, except check-thread stalls. Per unit of
work, though, the user still gets as many notifications as before: 156 for 10 pushes. They come
from a different, smaller set of causes, listed in §2. Two of those causes are new since 11-06
and account for most of the **error**-level notifications.

## 2. What fired in the window, by root cause

There were 156 report notifications in the window (`type = 'report'`, by `created_at`):

| bucket | notifications | cause |
| --- | --- | --- |
| supervised job failures + `error watching …/runs` | 37 | §2.2 |
| op-rate spikes / redundant pushes | 34 | §2.6 |
| gate waits (`wait read-admit / background-acquire / fs-*`) | 18 | §2.3, §2.4 |
| other slow ops (`element edited-files`, `db`, `http`) | 18 | §2.8 |
| restart fallout (job reclaimed/dropped, slot hog, backlog) | 10 | §2.1 |
| boot hooks / boot warm-up catch-ups | 10 | §2.7 |
| type-check divergence | 9 | §2.9 |
| check-thread stall | 4 (×20 occurrences) | §2.5 |
| singles (check-ignore, EPIPE, tab freeze, adaptive bar, render loop, backup, fs-latency daemon, ResizeObserver, wedge) | 17 | §2.9 |

### 2.1 NEW — main's backend crashes inside Bun, and nothing reports it

**Evidence:**
- `gateway.log` shows `backend exited unexpectedly worktree=singularity err="signal: segmentation fault"` at:
  - 2026-11-06 17:20:03Z;
  - 2026-11-07 22:46:03Z — the new backend of a hot restart, 4.2 s after it started;
  - 2026-11-08 14:20:56Z — after 65 min of uptime.
- Before that, the last main segfaults were 10-15 and 09-17. Three in four days is a cluster; it is not proven to be a regression.
- `singularity.log` has Bun's own panic each time:
  - `panic: Segmentation fault at address 0x28` / `0x7BC138` / `0x2483B634B1688037`;
  - `oh no: Bun has crashed`, Bun v1.4.4 (38afee6c8);
  - a `bun.report/1.4.4/…` link that encodes the stack. We have not decoded it.
- `reports` has **no row** for any of them (no `segmentation`, `Bun has crashed` or
  `exited unexpectedly` message). The gateway restarts the backend, and the only visible traces
  are the fallout:
  - jobs `reclaimed` / `dropped` 62 s later (the advisory-lock timeout);
  - the `wait …` herd of the reconnecting tabs (§2.3);
  - the queue backlog and slot-hog reports.

**Why it matters:** each crash kills every in-flight job and cuts every tab's socket, like the
74/day restarts this audit removed. Nothing tells anyone it was a crash.

**Suspect (unproven):** the native `@parcel/watcher` addon.
- research/2026-11-06-infra-parcel-kqueue-fd-leak.md documents a use-after-free in its kqueue
  backend ("works by luck"). It was patched in aec983b780 (11-06 19:56). The 11-06 18:20 crash
  happened before that patch and the other two after.
- The 11-06 17:20Z crash is preceded in stderr by
  `[file-watcher] error on …/singularity/runs … No such file or directory`.
- The 11-07 crash came 2 s after a burst of supervised-run watch failures on the same directory (§2.2).
- The 0x28 address is a null-struct field read, typical of a freed or never-set native object.
- Bun's message ("a bug in Bun") is generic: it prints it for any native-addon crash too.

**Fix tasks:**
- (a) Ingest it. The gateway already sees the exit signal and the backend's stderr. A backend
  that dies on a signal must file a crash report with the panic block and the `bun.report` link
  (the front-door invariant).
- (b) Root-cause it. Decode the three `bun.report` traces (symbolized stacks), and check whether
  the frames are in `watcher.node`. Correlate with watcher subscribe/unsubscribe churn on `runs/`.

### 2.2 NEW (11-06) — a watcher failure after spawn kills supervised jobs; the work itself succeeded

**What fires:**
- `[jobs] <job> failed (attempt 5): [jobs.step "spawn:1"] [supervised-run] <name>: run <uuid> failed to start AFTER its child was spawned: error watching …/singularity/runs: <No such file or directory | File exists | Undefined error: 0>`;
- the matching attempt-1 and `Dead jobs in queue` reports;
- the raw `error watching …/runs` crash row (670 lifetime since May; 6 in the window).

**Count:** 20 dead jobs in the window (`dead_jobs.died_at`; 24 by 11-08 ~15:10Z):

| job | dead |
| --- | --- |
| `worktree.prepare` | 9 |
| `database.fork` | 2 |
| `web-artifacts.prune` | 3 |
| `worktree.spare-refill` | 2 |
| `checks.cache-prune` | 2 |
| `worktree-cleanup.reap-stale` | 1 |
| `checks.host-audit` | 1 |

On 11-08 14:21–14:53Z (partly after the window) there were 32 failed attempts. **None recovered:** the attempt-1 and attempt-5 reports name the same run id (e.g. `4c31b025…`), i.e. the memoized step's error replayed.

**Mechanism:**
1. `startSupervisedRun` spawns the child, then runs `await syncWatcher()`
   (`plugins/infra/plugins/jobs/plugins/supervised-job/server/internal/run/supervisor.ts` ~l.642).
2. That (re)opens a native follow on `runs/` through
   `infra/file-watcher/shared/follow-files.ts` (~l.132–143 rethrows the open error).
3. The catch (~l.575) turns the error into "failed to start AFTER its child was spawned".
4. The throw sits inside the memoized step `spawn:1`, so attempts 2–5 **replay the same error**
   with the same run id. The retries are deterministic no-ops.
5. Meanwhile the child does its work: the checkout is prepared and the fork done (per
   `worktree-prepare.jsonl` and `database-fork.jsonl`). Only the parent's tracking failed.

**Why the open fails:**
- `runs/` (~1,189 entries) has up to three native subscriptions in one process, with different
  ignore sets:
  - the supervisor follow (`supervisor.ts:397`);
  - build-logs `acquireDirWatch(runsDir, "children")` (`build-logs/machine/internal/run-logs-value.ts:47`);
  - build `buildRunTerminalWatcher` (`build/machine/internal/run-terminal.ts:115`).
- `follow-files.ts` itself documents that @parcel/watcher 2.6 shares one cached tree per
  directory across subscriptions.
- Since 167d94c556 (11-06 16:31Z, "follow NAMED files, one subscription per directory"), the
  supervisor follow closes and re-opens that subscription on every change of the live-run set.
  Each re-open lists and stats the whole directory, while `pruneWorktreeRunArtifacts` deletes
  entries at every run start (`supervisor.ts:636`, and unserialized from the CLI,
  `supervised-job/cli/internal/attached-run.ts:47`).
- The first failure is 11-06 16:53Z, 22 min after that commit. Bursts of concurrent supervised
  runs (5 starts in 16 s) trigger it.

**Fix task:**
- Watching is an observation of a child that is already running, so its failure must not be the
  spawn's result. It becomes its own reported, reconciled state: the run is tracked and the watch
  failure is reported as such, not swallowed. The `onLost` → `reconcileSupervisedRuns` path already
  covers an untracked run.
- `runs/` needs one long-lived subscription per process, with names added and removed, instead
  of a close/re-open per live-set change, and no second subscription with other ignores.

Fixing this also removes the strongest crash suspect in §2.1.

### 2.3 Fixed class still firing — the reconnect herd on the read gates after every restart

**What fires:** `wait read-admit` 2.0–2.4 s (~810 in the window), `wait background-acquire` ~2.1 s
(~31), `wait flush-queue` 1.1–1.3 s, `wait heavy-read-local`, and one aggregate breach
(`wait read-admit — 95 s/window across 2,022 waits`).

**Evidence:**
- They cluster at main's boots (22:46Z, 13:06Z, 13:09Z, 13:16Z, 14:20Z).
- The traces show `read-admit` at 6 of 6 seats with 124 queued, and `background-acquire` with 16 queued.
- Host load stayed at 3.5–5 on 18 cores and event-loop max at 144 ms or less, so the waits are not
  victims of host pressure or a frozen thread. They are the queue itself, draining in ~2 s while
  every reconnecting tab resubscribes at once:
  - mostly `tasks.v2:rows`, one subscription per task id;
  - plus `reports.list:rows` and `code.commit-info`.
- The earlier gate fixes (f270edcdf1 fairness, ca4d62a29e deadlock) removed head-of-line
  blocking. They did not remove the herd.

**Fix task:** a reconnecting tab's per-row reads are served from the window it already holds,
or one batched read per resource. The point is not N single-row subscriptions racing for 6 seats.
Fewer restarts (§2.1) shrink it too.

### 2.4 Not fixed — the machine-usage sampler readdirs every worktree's ops dir every 30 s

**What fires:** `wait fs-readdir` 2.1–2.3 s, steady and not tied to boots.

**Evidence:**
- `listActiveWorktreeOps()` (`worktree-op.ts:224`) runs ~213 readdirs in parallel.
- Main's machine-usage sampler (`sample.ts:76`) calls it every 30 s. `stop-hook.ts` and
  `root-migration` call it too.
- `fs-wait.jsonl` shows 125–173 concurrent calls on libuv's 4 threads.

**Fix task:** keep the set of active ops current from a change signal (the op files are written
by our own CLI), so a read costs O(changes), not O(worktrees).

### 2.5 Not fixed — the `web-artifacts` check blocks its thread for 4–5 s per run

**What fires:** `A check run stalled its thread — check framework/tooling/web-artifacts
(blocking-io)` at 4.7–5.5 s. That is ~160/day at the 11-08 pace against the ~150/day baseline.

**Evidence:**
- The stack is `existsSync` ← `timed-fs.ts:211` ← `fleet.targets.filter((t) => hasArtifact(t.dirName))`
  in `web-artifacts/check/index.ts:433` (`store.ts:97` → `<store>/<dir>/meta.json`).
- `planExpectedFleet` (`core/internal/expected.ts:111–136`) repeats the same calls.
- The store `~/.equin/web-artifacts/store` holds 77,773 entries, and `existsSync` there measured
  230–316 µs per call, 20–30× a normal stat.
- ~3,000 targets × several hits each gives 2–3 s of kernel time per pass, run synchronously on
  the check thread.

**Same class (sync CPU on the check thread):**
- `shared buildContext` in `codegen/core/plugin-registry-gen.ts:204` (`classifyEdges`): pure CPU,
  2.1 s, ~46/day;
- `check infra/paths`: 2.3 s, once, a sync module load stalled by the disk.

**Fix task:** the planner and the check share one artifact index, read once per pass and
asynchronously (or kept by the store itself: it knows what it wrote). No per-target sync
`existsSync` against a 77k-entry directory.

### 2.6 Op-rate spikes and redundant pushes — four independent causes

1. **A streaming agent drives a Postgres watermark capture on every push.**
   - `conversations.partial-message` is a pure in-memory value, throttled to 50 ms
     (`conversations/machine/internal/partial-message.ts:21`).
   - It declares `reads: { tables: [], lookups: […] }` without `readCost: "memory"`. So
     `readsDb()` (resource-runtime `runtime.ts:3763`) is **likely** true, and every push captures a
     DB watermark (`runtime.ts:4171`). `readsDb` has other branches (a guarded external with no
     routing); which one applies has not been confirmed at runtime. If the lookup really reads
     the DB, the watermark is for that lookup, and the fix is to make it cheap or memory-backed.
   - Inferred, not traced: this one cause would explain partial-message ~2,340 per 5 min (≈ 7.8/s), `flushNotifies`
     2,383–4,258 and most of `db [acquire]` 10,404.
   - Fix: an external value that reads no table never captures a watermark. This should follow
     from what it reads, not from a flag one can forget.
2. **`host-fs.stat` makes no-op pushes at 5.7/s, plus its loader/push spikes.**
   - Every path-like code span subscribes to the full stat through `use-folder-claim.ts:24`,
     though it only needs "is it a folder".
   - `watchHostPathOver` (`machine/internal/version.ts`) opens up to three watches per path.
   - `watch-entry.ts:112` wakes on the parent's own update, and `/tmp` changes every second.
   - Fix: a narrow kind-only value, one stamp-filtered watch per path, and no wake on an
     ancestor's own update.
3. **`page-backlinks` makes no-op pushes at ~1.3/s while typing.**
   - `page/plugins/links/server/internal/resources.ts:50` declares whole-table reads
     (`page_blocks`, `page_links`, the referent tables), so every keystroke's write re-runs the
     join and returns identical bytes.
   - Fix: the reindexer materializes each edge's snippet, so a text write moves nothing that
     backlinks read.
4. **`config-v2.values` pushes in bursts (66 in 60 s).**
   - `notifyDocument` (`config_v2/server/internal/registry.ts:358`) notifies the base tuple and
     every known scope, gated by a file stamp, not by whether the resolved values changed.
   - Fix: diff the resolved document per tuple.

**Also, proportional to activity but writing through the change feed:**
- the runtime-sdk events consumer writes its cursor row on every batch (`consumer.ts:343`), which
  drives `watch:runtime-sdk.events` ~730, `catch-up` ~738 and route `conversations_ext_sdk_agent` ~631;
- one page edit fans out to six `dedup: "none"` jobs, which drives route `job_runs` /
  `job_run_stats` ~530.

Both are "work per event" that should be "work per change".

**Fixed and not seen in the window:** File Explorer `host-fs.peek`, the O(changed) listing, and
the no-op pushes on transcript-stats, op-store, pages.tree and task-cluster.

### 2.7 Boot warm-ups catching up after a long gap

**What fires:**
- `bg warmup:sonata.midi-folders.reconcile` took 24.4 s and 44.7 s;
- `warmup:stats.cost.usage` took 15.8 s;
- `corpus-index:ensure-fresh` took 9.5 s;
- the `Slow boot hook` reports: `onReady:conversations` 742 ms, `live-state-snapshot` 1,227 ms,
  `database` 780 ms.

**Evidence:** they fire only on the first boot after a long quiet gap. The 13:09, 13:16 and
14:21 boots did not trip. Their traces show no gate waits and no loop block, so it is the work
itself. The suspect is a journal replay or a full walk in `ensureFresh`. We have not measured
which call is slow.

**Fix task:** measure the cold path of these three warm-ups, then make each one O(changes since
last run).

### 2.8 Other steady slow ops

**`element edited-files` / `bg watch-edited-files:pass`:**
- 1.1–2.1 s each, ~16/day, steady;
- the cost is git work per pass;
- not fixed, and not part of the audit.

**Other DB slow ops:**
- `INSERT INTO live_state_snapshot` 0.5–4 s at boot flush, Postgres self time on large JSONB;
- the daily `retention.traces` delete 0.6–2.3 s;
- not root-caused here.

**`main-thread … page-detail` ~1.0 s:** browser-side; the threshold is the only thing near it.

### 2.9 Singles and small classes

**Wedge `unanswered-sub build.history:rows`** (×168 on the notification = lifetime):
- 1 occurrence in the window, and it was not the server. At 19:00:10 the gates were empty and
  event-loop p99 was 2 ms.
- The client sent the sub at 19:00:00.112; the ack and the watchdog both fired at 19:00:32.26.
- So the tab or transport delivered it late; a throttled tab is the suspect, unproven.
- Audit fix held.

**`git check-ignore` exited 128 (NEW, 7 in the window):**
- The real message is `fatal: empty string is not a valid pathspec`.
- `relativeTo(root, root)` returns `""` in `hub.ts` (~l.97 / ~l.227), so a change event on the
  checkout root dir itself feeds `""` to `check-ignore` (`ignored-paths.ts:27`).
- First seen 11-08 12:19Z. The code is from 10-14, so something now emits root-dir events (not traced).
- Fix: a root-dir event is not a path inside the tree.

**`Runtime "sdk" list failed: write EPIPE`** (1, 6 lifetime):
- `socket-client.ts` `connectFailure()` knows ENOENT/ECONNREFUSED/ECONNRESET-before-connect only.
- An agent that exits between connect and write therefore fails the whole list pass.
- Fix: EPIPE, or a reset after connect, means "this agent is gone".

**Browser tab frozen 243.9 s** (`/prototypes/proto/proto-1792836852-pvwo12`, "Miller pane motion"):
- Real: the tab was focused and visible and its log went silent.
- No long-animation-frame entry was recorded, so it is unattributable.
- The suspect is the prototype iframe, which runs user HTML in the same process.
- Instrumentation gap: a renderer hang leaves no evidence.

**ResizeObserver** (1):
- The remaining site is the task page with a dependency graph: xyflow `GraphCanvas`, the floating
  action bar band (`global-action-bar.tsx:291`) and the adaptive bar.

**Adaptive bar row-overflow by 1 px** (`apps.prototypes.canvas#pane`, "Frame actions"):
- The fit's measured widths are 1 px off the rendered row (the same fault shows on website/vision).

**Render loop `pane:conversation` ← `StreamingProse`:**
- `useSteadyReveal` sets state every frame and re-renders the whole growing markdown.
- It is a real per-frame cost, by design today.

**Type-check divergence ×9** (04:34Z backstop):
- 7 `walk-contract`: the incremental walk's `.d.ts` contract drifts from the full walk on files
  unchanged for days.
- 2 `signature`: `tasks-core` and `page/editor` `resources.ts`, the same hashes as on 11-07, so
  deterministic.
- Needs a `walk-replay`.

**Other singles:**
- `backup partial: google-drive` (1);
- fs-latency root daemon "installed but not running" (1).
- These are an operations state, not a code cause: not investigated.

### 2.10 Job-retry noise (quantified only; a separate task owns it)

Every dead job files three reports: attempt 1, attempt 5 and `Dead jobs in queue`. For §2.2 the
retries can never succeed, because they replay a memoized error. So those reports are not noise
from a transient failure: they are a real failure reported three times.

## 3. Main's remaining short stalls: attribution

**In the window** there was 1 short stall (1.17 s at 11:49:22Z) and 0 over 3 s.
- All 307 of its samples sit in the native `close()` of `closeNativeWatcher`, reached from
  `file-watcher/shared/engine.ts:590` (`closeAll` ← `unsubscribe :622` ← `stop :422`, span
  `file-watcher.dir-entries:stop`).
- A directory `fs.watch` handle's close(2) took over 1 s in the kernel.
- There was no JS work and no GC, and no boot near it.

**Since 4c424dd68e** (11-05..11-08: 148 short-stall traces, 215 s in total), ranked by total
blocked time:

| first repo frame | traces | blocked | status |
| --- | --- | --- | --- |
| `countAgents` → `liveAgents` → sync `readdirSync` + `readFileSync` of the agent-pid root (~289 namespaces), `conversations/plugins/runtime-sdk/machine/internal/agent-processes.ts` | 116 | ~186 s (87 %) | fixed by d15528ecd2 (async); none since 11-06 15:56Z |
| icons `resolve-icon.ts:23,61,94` (`hasIcon` / symbol body parse) | 5 | 6.4 s | open: CPU per call |
| sync fs one-offs (`existsSync` in `scopeHasOwnConfig`, `readPidFile`, `readTail`, `cloneNamedBinary`) | ~12 | ~8 s | banned by the no-sync-fs lint since 11-06 |
| theme-engine `readsVar` / serialize-vars (`theme-engine/core/sub-theme.ts:136`) | 3 | 2.6 s | open: CPU per call |
| log-files JSON parse (`log-files/server/internal/persist.ts:231`) | — | — | open |
| no repo frame (module load, unknown) | ~4 | 3.2 s (1.5 %) | — |

No stall in the whole period was GC: `gcPreciseTotalMs` was 0 in every health row.

**Takeaway:** the steady-state cause, sync fs on the event loop, is gone. What is left:
- native watcher open/close on the loop thread. Fix direction: hold watchers long-lived and
  refcounted, instead of churning one per folder peek.
- icon and theme work recomputed per call. Fix direction: one index per build.

## 4. Dependency-store pool, three days on (task-1793847634-0disv8)

| per UTC day | 11-04 (before) | 11-05 | 11-06 | 11-07 | 11-08 (part) | window |
| --- | --- | --- | --- | --- | --- | --- |
| cold installs (spare refill + task add) | ~108 | 63 | 73 | 0 | 14 | 9 |
| installs that adopted a store | — | 10 | 15 | 3 | 3 | 6 |
| spares claimed | 64 | 60 | 45 | 2 | 6 | 7 |
| stores harvested at reap | 0 (75 `rm -rf`) | 47 | 35 | 95 | 83 | 143 |
| harvest skipped | — | 0 | 1 ("no dependency store") | 0 | 0 | 0 |
| fs read stalls ≥ 2 s (calls) | 143 | 23 | 30 | 0 | 6 | 6 |

**Harvest and adoption work:** no adopt errors, one legitimate skip, and adopted installs as measured.

**But supply outruns demand by ~7×:**
- 260 stores were harvested since 11-05, against ~36 adoptions.
- The pool keeps only the newest `POOL_MAX = 2` (`infra/worktree/server/internal/dep-store-pool.ts:56`).
  `harvest()` deletes the rest with `rm -rf` straight away, so **~85 % of stores are still
  deleted**, at harvest instead of at reap.
- The pool is empty right now.

**Rename stalls are not measured directly:**
- There is no rename probe, and no `slow_ops` row for renames. `fs-wait.jsonl` covers only
  read/stat/readdir/glob.
- fs read stalls of 2 s or more fell from 143 (11-04) to 23–30 a day (busy 11-05/06), with max
  57 s → ~10 s.
- About half of what is left lands within 5 min of a cold install (16 of 30 on 11-06).
- Cold installs still happen on busy days: 63–73/day. Most are concurrent launches that miss the
  single spare (`SPARE_TARGET = 1`, `spare-pool/server/internal/refill-job.ts:18`).

**Spares are not oversized:**
- Created ≈ claimed every day.
- Only 3 spares were ever pruned unused; one was in the window, replaced after ~24 h by the
  daily 04:40 refresh.
- The "57 spares vs 67 reaps" of the open question are not pairs. The reaps are finished task
  checkouts.

**Failure:** four `rm -rf` runs of pooled stores timed out after 30 min (11-07 20:49Z ×3,
22:08Z ×1). The retry finished them. A 30-minute delete of one `node_modules/.bun` is its own
stall to explain.

**Fix task:** keep what will be adopted, and delete nothing that a busy hour will reinstall cold.
- Today a burst of concurrent launches cold-installs while a burst of reaps `rm -rf`s 80 % of the
  stores.
- Direction: size the pool from the launch rate (or by age, inside the 7-day cap), not a constant 2.
- Find why one pooled-store `rm -rf` takes 30 min.

## 5. Mental model

- **The audit's fixes held.** Every symptom it chased is at or near zero:
  - backends booting and being killed in a loop;
  - main freezing for seconds;
  - live updates wedging;
  - every tab downloading every task;
  - main restarting for each push.

  Main now restarts only when its code changed (half of the deploys in the window kept the
  running backend), and its event loop had one 1.2 s hiccup in 24 h.
- **What the user still sees comes mostly from two new problems, not the old ones.**
  - Since 11-06, watching the `runs/` folder breaks when many background jobs start together.
    The job is then marked dead, though its work is done, and it files three error
    notifications. That is the largest share of the red ones.
  - Main's server process itself crashed inside Bun twice in the window (three times since
    11-06), and nothing reported it. Each crash looks, to everything else, like a sudden restart:
    jobs are reclaimed, and tabs reconnect at once and queue for ~2 s on the read gates. That
    queue files the "wait … took 2 s" warnings.

  The two are possibly linked, through the native file watcher; that is a hypothesis, not a finding.
- **The yellow warnings are mostly work that changes nothing:**
  - pushes of values that came out identical;
  - a DB round-trip per streamed token;
  - a readdir of every worktree every 30 s;
  - a check that stats 77,000 files synchronously.

  Each is "cost per event" where it should be "cost per change", the same lesson as the audit.
- **The numbers on notifications mislead.** "×2717" is a lifetime total, not what just happened.
  The window had ~31 of those.

## 6. Root causes needing a fix task

Each has its evidence in the section noted. None is a mute, threshold, retry or reclassification.

1. **Main backend segfaults are not reported** (§2.1a): a backend killed by a signal must file a
   crash report with its panic block and `bun.report` link.
2. **Root-cause main's Bun segfaults** (§2.1b): 3 since 11-06. Decode the `bun.report` stacks and
   test the native-watcher hypothesis.
3. **A supervised run's watcher failure after spawn kills the job** (§2.2), and `runs/` carries
   several native subscriptions re-opened per live-set change: 20 dead jobs in the window whose work succeeded.
4. **The reconnect herd on read-admit after a restart** (§2.3): per-row subscriptions racing for
   6 seats → ~810 two-second waits.
5. **`listActiveWorktreeOps` readdirs ~213 dirs every 30 s** from the machine-usage sampler (§2.4).
6. **The `web-artifacts` check runs a sync `existsSync` loop over a 77k-entry store** on the check
   thread (§2.5): check-thread-stall unchanged at ~150/day. The same class covers `buildContext`
   `classifyEdges` CPU.
7. **The partial-message value (likely) captures a DB watermark per push** (§2.6.1): confirm the
   `readsDb` branch, then derive "reads no DB" from the declaration.
8. **`host-fs.stat` no-op pushes** (§2.6.2): full-stat subscriptions for a kind check, triple
   watches, ancestor wakes.
9. **`page-backlinks` whole-table read set** re-runs on every keystroke (§2.6.3).
10. **`config-v2` notifies every scope without diffing the resolved values** (§2.6.4).
11. **The runtime-sdk events cursor row is written per batch**, and page edits fan out to six
    undeduped jobs (§2.6, both through the change feed).
12. **Warm-up catch-ups after a quiet gap** (§2.7): sonata midi reconcile 24–44 s, cost usage
    15.8 s, corpus index 9.5 s. Measure the cold path first.
13. **`git check-ignore` gets an empty pathspec from a root-dir event** (§2.9, `hub.ts`).
14. **The sdk runtime list fails on EPIPE from an agent that just exited** (§2.9, `socket-client.ts`).
15. **The type-check backstop diverges** (§2.9): 7 walk-contract drifts plus a deterministic
    signature pair. Needs a `walk-replay`.
16. **The dep-store pool keeps 2 and `rm -rf`s ~85 %** of harvested stores, and one pooled-store
    delete took 30 min (§4).
17. **Native watcher close on main's event loop** (1.17 s, §3), and icon/theme work recomputed
    per call (§3).
18. **A renderer hang leaves no evidence** (the 243.9 s prototype tab freeze, §2.9): an
    instrumentation gap.
19. **Notification `×N` shows the report's lifetime count** (§0, §5), so a re-raised quiet report
    looks like a fresh burst. Show the occurrences since the last notification.

Smaller ones, file only if wanted:
- the ResizeObserver site on the dependency-graph task page;
- the adaptive bar measuring 1 px off;
- `StreamingProse` re-rendering the whole markdown per frame;
- `edited-files` git work ~16/day at 1–2 s;
- the other 7 browser `main-thread` slow-op traces in the window (~1 s page-detail renders), not investigated.

The window's one `op-time` trace is the `read-admit` 95 s aggregate breach, covered by #4.
