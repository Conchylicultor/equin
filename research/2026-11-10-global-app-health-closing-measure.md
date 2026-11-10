# App health, closing 24 h re-measure (after fseventsd "recovered")

Task: task-1794319850-v6eeoj. Supervisor session: task-1793826400-nd8if7 (page "App health audit
(session)", block-d9db5fe2-021b-4868-86aa-ec300efc8f06). Previous measure:
research/2026-11-08-global-app-health-24h-after.md (called "11-08" below).

**Window:** 2026-11-09T13:58:36Z → 2026-11-10T13:58:36Z, on main (namespace `singularity`).
The full 24 h exists. Per-report counts come from `reports.hourly`, whose buckets are whole UTC
hours, so they cover 11-09 14:00Z → 11-10 14:00Z (shifted 1.4 min from the window).

**Sources:**
- main's DB: `reports` (`hourly`, `recent`), `notifications`, `traces`, `dead_jobs`, `job_runs`,
  `build_runs`, `report_fixes`, `attempts`;
- main's logs: `~/.equin/worktrees/singularity/logs/*.jsonl` and `runs/build-build-*.log`;
- the gateway's log: `~/.equin/logs/gateway/gateway.log`;
- the fs-latency monitor: `~/.equin/logs/monitors/fs-latency.jsonl` and its archive;
- `ps` / `lsof` / `sample` on live processes (read-only).

Nothing was fixed and no report was taken (decision D23). No `@parcel/watcher` crash
reproduction was run.

## 0. Read this first: the window was not clean

The brief assumed fseventsd recovered once the orphaned `node -e` loops were killed at 13:58:36Z.
**The monitor says it did not stay recovered:**

| | |
| --- | --- |
| fseventsd CPU, hourly median | ~190 % in 15 of 24 hours (16:00–00:00Z, 04:00–08:00Z, 11:00–12:00Z); 30–130 % in most others |
| fseventsd restarted | twice: 11-10 01:27Z (event id 8.38 billion → 690) and 09:06Z; it went back to ~190 % within ~2 h each time |
| fseventsd memory | up to 29.6 GB RSS (11-10 11:00Z hour); a running investigation names a 49 GB footprint |
| volume event-id floods (> 1 M ids/min; normal is 60–250 k/min) | 7 episodes, ~6.4 billion ids in total: 11-09 13:55–15:52Z (~760 M), 18:38–20:40Z (~2.5 B), 11-10 01:27–03:18Z (~930 M), 09:06–10:19Z (~460 M), **13:01–13:58Z (~1.6 B; 13:01–13:24Z ran at ~1.1 M ids/s, ~500× normal)** |
| no `node -e` / repro process left | confirmed with `ps` |

The floods after 13:58Z cannot be traced to the killed loops: those processes are gone, and two
of the episodes follow an fseventsd restart (possibly id re-allocation, not file activity). I could
not attribute them. They are **not excluded** below. Instead, where it matters, a metric is split
into the 11 "flood hours" (any part of the hour inside an episode) and the 13 "clean hours".
An investigation of the relapse is already running (conv-1794317642-ha2b68, the slow-ops side).

**Traffic was ~4.6× the 11-08 window:**

| activity | 11-04 (before) | 11-06 (busy) | 11-08 window (quiet) | **this window** |
| --- | --- | --- | --- | --- |
| pushes to main | 104 | 82 | 10 | **46** |
| attempts started | 151 | 128 | ~20 | **43** |
| main deploys (auto builds) | 74 | 51 | 8 | **39** |

So where a rate scales with traffic, it is also given per push.

**One more host load not owned by the app:** an orphaned `equin · test` process (pid 55054,
`plugins/infra/plugins/file-watcher/shared/engine.test.ts` from worktree att-1794198291-8wg81k,
task-1794190702-eld769) has spun one core at ~99 % since 11-09 07:43Z (31 h). Its parent is
launchd. `sample` shows one thread spinning inside `@parcel/watcher`'s
`KqueueBackend::watchDir` (from `compareDir` ← `start`) and the JS thread blocked in
`~KqueueBackend()`. It loads the **prebuilt** `@parcel+watcher-darwin-arm64@2.6.0/watcher.node`
from that worktree's `node_modules`. Its watched files have not changed since 07:43Z, so it does
not drive fseventsd. It was not killed (no fixes in this task).

## 1. Exit criteria: before → after

| criterion | before (11-04) | 11-06 | 11-08 window | **this window** | verdict |
| --- | --- | --- | --- | --- | --- |
| backend-never-ready on main | ~11,300/day | 0 | 0 | **0** | ✅ held |
| backend-never-ready, any worktree | — | — | 0 of 22 boots | **1 worktree** (website.att-1794271516-gvbyvv, a pre-merge dev build: 2 boots exited with code 1 after 1 s, 3 `boot-wedge` occurrences) of 200 boots across 41 worktrees | ✅ not a wedge: a boot-time crash, §2.2 |
| main event-loop stalls > 3 s (`stall` traces) | 53 traces | 1 | 0 | **0** | ✅ held (other trace kinds over 3 s are slow work, not a frozen loop: `bg` 304, `loader` 38, `sub` 32) |
| main short stalls 0.5–3 s | 10 % of windows | 114 traces | 1 | **4 traces** (max 751 ms) | ✅ |
| slow-db traces (main) | 231/h | 221/day (2.7/push) | 3/day | **107/day (2.3/push)**, 1 over 3 s | ✅ per push; ~1 s each, mostly in busy hours |
| check-thread stalls | ~150/day | — | ~160/day pace | **57/day** | ✅ improved; all 57 are from this session's own new code (§3.3) |
| dead jobs | — | — | 20 | **0** (last dead job 11-09 04:30Z) | ✅ fixed |
| main crashes (segfaults) | — | 1 | 2 | **0**; 0 unexpected exits of main | ✅ held |
| other backend crashes | — | — | not reported (no baseline) | **1 worktree SIGSEGV**, reported as a `backend-crash` row with Bun's panic | ingestion works ✅; the crash is not root-caused (§2.3) |
| main restarts / deploys that kept the backend | 74 / 0 | — | 6 / 4 of 8 | **39 / 0 of 39** | ⚠ restart-skip could not judge 19 of the 39 (§3.1) |
| report notifications/day | 687 (216 red) | 371 (32 red) | 156 (59 red) | **768 (43 red)** | red ✅ (0.9/push vs 2.1 baseline); total ✗ (16.7/push, same as 11-08's ~16) |

**Summary.** Every red criterion the audit chased held under 4.6× the traffic and a relapsed
fseventsd: main never failed to boot, its event loop never stalled over 3 s, it never crashed, and no job died. Red
notifications are down to 43 a day. What did not improve is the yellow volume: 725 warnings,
almost all "slow operation" from waits that pile up after main's 39 restarts and from the host's
file-event floods.

## 2. Red notifications (43) — what they were

| notifications (×occurrences) | what | owner |
| --- | --- | --- |
| Crash recorded: 27 notifications (their `×N` sums to 72) | ResizeObserver loop: 97 occurrences in the window (from `hourly`), 79 of them in one hour (11-09 14:00Z); the rest ~18 across the day on surfaces the old fix did not cover (desktop, website, demo, conversation, page) | standing worklist |
| | live-state wedge `unanswered-sub` 16 occurrences (11-08: 1) | standing worklist — see §2.4 |
| | server-caught singles (7): git-status loader failure, `ENOTDIR` on `files.computer.stat`, sprite version mismatch after deploy, Claude CLI SIGTERM, a fix claim not an ancestor, an SDK agent SIGKILLed after 15 s, a refused raw fetch | standing worklist |
| Backend exited 5 (×7) | promo-film.att-1792947727-5k4w8f ×5: exits with code 1 two minutes after ready, its DB missing a table (`42P01` in the stuck-lock sweep) — that worktree's own DB; website ×2: §2.2 | standing worklist / §2.2 |
| Backend never became ready 2 (×3) | the website worktree, §2.2 | **this session — fixed already** |
| Type-check divergence 2 | the same two deterministic `signature` pairs as 11-07/11-08 | task-1794151616-omc11e (manual) |
| Job attempt failed 2 | both "Recovered on attempt 2" (`prototypes.render-thumbnail`, `task-title.short`) | standing worklist |
| Crash recorded / tab froze (stale tab) 3 | old tabs on old code | — |
| Backend crashed 1 | §2.3 | standing worklist |
| A database session is holding others back 1 (×2) | an untagged background session held a `job_run_stats` upsert for 60 s | standing worklist |

### 2.1 Dead jobs: 0

- `job_runs` keeps only the newest 20 runs per job, so its totals shrink as rows are pruned (I read
  1,197 succeeded / 107 suspended; the reviewer, minutes later, 950 / 99). Read them as a floor.
- 1 run failed (`sidequest-autopilot.triage-backfill`: its config was not registered yet at boot;
  attempt 1 of 5). `dead_jobs` (never pruned) has no row after 11-09 04:30:09Z.
- Supervised runs show as `suspended`, then resume as a new job id that succeeded.
- The 11-08 window had 20 dead jobs, all from the `runs/` watcher failing after spawn. That cause
  (patched watcher 5e68dd16ca, task-1794150818-gbnxlm) has not fired since.

### 2.2 A latent bug in this session's fix — exposed and fixed before it landed

- **What:** the website composition worktree's backend crashed at boot:
  `serveValue("icons.saved-sprites"): \`follows\` names no follow — omit it.`
- **Why:** this session's sprites fix (c524b0ff86, task-1794162027-tx8d13) made the value follow
  each "followed" saved-icon source via `followsAtBind`. A composition with no such source (the
  standalone website has no `page/callout`) produced an empty list, which `compileFollows` refused.
- **Fixed by:** 234c1accaa (11-10 12:54Z, conv-1794271516): an empty `followsAtBind` registry
  now follows nothing instead of throwing.
- **Where it showed:** only on that attempt's own dev worktree. Until 234c1accaa, the website
  composition excluded the demo plugins, so no built composition reached the empty case. The
  change that exposed it also fixed it, in the same commit, before it landed.
- **So:** a latent bug in our commit, never on a deployed build. Nothing to file. It is the only
  defect I found that traces to our fixes.

### 2.3 The one segfault in the window was not main

- `att-1794229798-f3ahn9` died by SIGSEGV 2 m 11 s after start (11-09 15:23Z):
  `panic(main thread): Segmentation fault at address 0xA4A`, Bun 1.4.4, with a `bun.report` link.
- It was filed at once as a `backend-crash` report with its stderr (the crash-ingestion fix, c7fd86b34c).
- Its stderr names no file watcher. The `bun.report` trace was not decoded.
- Main had none, against 2 in the 11-08 window.

### 2.4 Live-state wedges went from 1 to 16

- They cluster in busy hours (11-09 19Z ×5, 22–00Z ×7, 11-10 13Z ×3).
- Most are short (15–54 s; `plugin-view.tree`, `reports.list:rows`) and fit a loaded host.
- Two do not: a `build.deployment` sub unanswered for **12,871 s** (3.6 h) and a `reports.list:rows`
  sub for **2,298 s**, each on a socket with one tab.
- Not root-caused here. I found nothing that ties them to this session's fixes, but I also could
  not rule it out. They are on the standing worklist, and the two long ones are worth a look.

## 3. Yellow notifications (725) and what still fires

Occurrences by kind (from `hourly`):

| kind | occurrences | reports |
| --- | --- | --- |
| server slow-op | 6,287 | 144 |
| client slow-op | 233 | 80 |
| boot-budget | 159 | 15 |
| op-rate | 95 | 15 |
| check-thread-stall | 57 | 4 |
| op-time (aggregate budget) | 43 | 4 |
| host-io-degraded (fseventsd) | 41 | 1 |
| report-storm | 19 | 19 |
| duress episodes / sheds | 19 | 7 |

Split by hour type: **5,204 occurrences in the 11 flood hours, 1,898 in the 13 clean hours**
(the night hours 03–11Z, mostly clean, had almost no traffic).

### 3.1 The post-restart herd: still the largest source

| report | window | notes |
| --- | --- | --- |
| `wait read-admit` | 2,673 | 11-08: ~810 over 6 restarts (~135 each); now 39 restarts (~69 each) |
| `wait fs-stat` | 1,608 | 1,465 in one hour (11-09 15Z: 6 restarts, inside a flood episode) |
| `wait background-acquire` | 580 | |
| `wait fs-read` / `fs-readdir` / `flush-queue` | 58 / 20 / 13 | |

- Traces of these waits fall at main's restart times. One trace shows `read-admit` at 6 of 6 with
  109 queued (holders: `prototypes.list`, `build.deployment` revalidates, `attempt-work`).
- The herd fix (task-1794150825-4vtmfn) roughly halved the cost per restart. The count tripled
  because main restarted 6.5× more often.
- **Main restarted on every deploy.** For the 39 main builds in the window (their logs in
  `runs/build-build-*.log`, all exit 0), the restart-skip judge said:
  - "a loaded module changed": 18 (a real restart);
  - "the migration SQL changed": 2 (a real restart);
  - **"the closure cannot be measured: [source-digest] no node_modules entry for
    `@browser-host/apps/plugins/website/plugins/demos/plugins/workspace` above
    `…/website/plugins/demos/plugins/workspace/core/browser-host.generated.ts`": 19.**
- So restart-skip, this session's fix (task-1793839289-m85z46), could not judge 19 of 39 (49 %)
  of main's deploys since the website demo's generated `@browser-host/…` import appeared. It fails
  safe (it restarts), so no report fires. How many of the 19 could have skipped is unknown: all
  20 measured deploys did change main's code.
- **Owner:** this session (our fix stopped working), though another change caused it.
  Not filed (D23 allows only a regression we caused); see the question in §7.

### 3.2 The host's file events (slow-ops session)

- `bg watch-delivery:fs-events` 541 occurrences + 22 `op-time` breaches. The worst delivery was
  1,370,711 ms: a change heard **22.8 minutes late** (11-10 13:24Z, the end of the largest flood).
- `bg watch-delivery:kqueue` 44 + 4 `op-time`.
- `host-io-degraded` 41: "fseventsd has used 166–198 % CPU (median) for the last hour".
- **Owner:** slow-ops session (conv-1793965643-wr9rnk); relapse investigation conv-1794317642-ha2b68.

### 3.3 Check-thread stalls: 57/day, all from this session's own new code

| fingerprint | window | origin |
| --- | --- | --- |
| `shared scanFilesCached` (plugin-records `file-scans.ts`, native) 2.8 s | 25 | D8: check passes read the plugin-records store (bf4b4fd8d6, 11-05) |
| `shared walkLevels` (plugin-records `module-graph.ts`, native) 3.9 s | 24 | same |
| `check database/sql-writes` (blocking-io) 2.0 s | 7 | the hand-written SQL check (2caa0e3469, task-1794160096-scodpn) |
| `shared extractFacetRecords` 2.2 s | 1 | facet records |

- The `web-artifacts` stall (the ~150/day of the baseline) is gone (task-1794150828-q1vgez).
- The criterion improved from ~160 to 57 a day, and the check pass itself got faster
  (18.4 → 8–11 s with D8). So these are not a regression of anything measured, but they are our
  code. Not filed (D23); listed as this session's.

### 3.4 Other steady classes (standing worklist unless noted)

- **Boot budgets:** 159 occurrences over 39 boots. Top: `onAllReady:reports.engine` 4.6 s ×39,
  `onReadyBlocking:database` 577 ms ×39, `onReady:conversations` 3.8 s ×19, `onReady:release` ×13,
  `onReadyBlocking:config_v2` ×10.
- **Op-rate:** `conversations.partial-message` loader/push/deliver at ~535 calls per window, ×17
  each, plus `flushNotifies` ×17. A streaming agent's rate, just over the 500 threshold.
  `pages.tree.v2` loader/push ×9 and 4 `live-state-noop` (~1.2 no-op pushes/s): slow-ops (it
  owned the earlier pages.tree no-op fix).
- **transcript-watcher** `resolve` 99 / `process` 58; `edited-files` ~75 client + 59 server;
  `file-explorer.git-status` loader 53: worklist / slow-ops.
- **Slow DB** (107 traces, ~1 s): `notifications` select 23, `reports` select 21,
  `live_state_snapshot` insert 21, `live_state_handoff` 14 — busy hours only.

## 4. The fix ledger (`report_fixes`)

- **48 entries: 43 Fixed, 5 Came back.**
- **Fixed:** the watcher patch 5e68dd16ca alone holds 24, and none came back. 0 entries are still
  waiting for main to deploy.

**Came back (all 5 are this session's fixes):**

| report | in window | before the fix | after | real regression? |
| --- | --- | --- | --- | --- |
| `warmup:sonata.midi-folders.reconcile` | 13 | 24–44 s per boot | mostly 2.4–7.5 s; one 63.6 s (11-10 13:20Z) | **No.** A partial fix. The 63.6 s, and the 30.7 s / 14.3 s of `stats.cost.usage` below, fell in the 11-10 13:01Z and 11-09 18:38Z floods. The fix (3dbbcedd2d) bounds the replay to ~10 min of volume history, and its cost is per event id (~1 M ids/s then, vs ~4 k/s normally). The checkpoint job runs every 5 min (20 of 20 kept runs succeeded). The 2–7 s left at every boot is still over the 2 s threshold. |
| `warmup:stats.cost.usage` | 11 | 15.8 s | 2.1–3.6 s; 14.3 s and 30.7 s in floods | No, same as above |
| `corpus-index:ensure-fresh` | 1 | 9.6 s | 3.5 s | No, same as above |
| `push deliver:icons.saved-sprites` | 9 | 1–3.4 s | 1.0–3.0 s, at main's restarts (15:01, 15:08, 15:16, 15:18Z…) | **No.** The fix (c524b0ff86) stopped the recompute on every non-callout write. What fires is the persisted value's whole ~200 KB frame resent at each restart. That is the known residual task-1794163460-a8h5xe (manual). |
| `update icons.saved-sprites` | 0 | 1–3 s | last at 11-09 13:49Z, before the window | No, same as above |

**All 5 are partial fixes, not new breakage.**
- By the ledger's own rule ("fires again from code that has the fix"), they are correctly marked
  Came back, and each still needs follow-up.
- None got worse than before its fix, though. Each report had two causes, and the fix removed one:
  - for the warm-ups, the per-boot replay of everything since the last boot is gone. A replay of
    the last ~10 minutes is left, and it costs 2–7 s on this volume.
  - for the sprites, the recompute on every write is gone. The full-frame resend at restart is left.
- The flood attribution of the 30–64 s outliers is a timing match, not a measured cause.

## 5. Dependency-store pool and plugin-records reclaim

**Pool (7-day retention, D20):**

| | 11-04 | 11-06 | 11-08 window | **this window** |
| --- | --- | --- | --- | --- |
| cold installs | ~108 | 73 | 9 | **0** |
| checkouts from a ready spare | 64 | 45 | 7 | **32** |
| fresh checkouts that adopted a pooled store (and a recycled tree) | — | 15 | 6 | **4** |
| spares written (all with an adopted store) | — | — | — | **32** |
| reaps that kept their store | 0 | 35 | 143 | **57** |
| stores deleted at reap | 75 | — | — | **2** (changed after install: the `@parcel/watcher` patch) |
| pool now | — | — | empty | **20 stores, 22 trees**, oldest 11-09 12:00Z |

The pool is **not filling**. It holds 20 stores, against the ~170 projected at the 7-day cap,
because spare refills consume what reaps produce. No cold install happened in 24 h.

**Plugin-records reclaim (04:43Z, daily):**
- It has run twice: 11-09 04:43Z, and 11-10 04:43Z (the run asked about).
- 11-10: `18,574,545 key rows read, 0 deleted, 0 values deleted, 0 pages freed in 9.6s`.
- 11-09: 13.9 M rows read, 0 deleted, in 21.6 s.
- 0 deleted is correct: the v2 store dates from 11-07 01:23Z, so no row is 7 days unread yet.
  The first deletions can come on the 11-15 04:43Z run at the earliest (a row must be unread for
  more than 7 whole days, `used < today − 7`).
- The daily verify (11-10 05:17Z) agrees: 132,618 records match the store, 0 disagree.
- **But the store is large and growing:**
  - `records.v2.sqlite` is **6.73 GB**, against the 140 MB D8 reported;
  - keys grew 13.9 M → 18.6 M in a day (+4.7 M/day), for ~133 k live records;
  - the file grew ~35 MB in the 12 minutes I watched it;
  - at that rate, the 7-day steady state would be ~33 M keys, roughly 12 GB.
- No report fires on it. It is D8's design (every worktree's code versions keyed and kept 7
  days), so it is this session's to judge; not filed. See §7.

## 6. Still firing, by owner

| owner | what (window count) |
| --- | --- |
| **this session — latent bug in our fix, fixed before landing** | website dev-build boot crash on `icons.saved-sprites` follows (2 exits + 3 boot-wedge; fixed by 234c1accaa) |
| **this session — our fix stopped working (another change caused it)** | restart-skip "closure cannot be measured" on 19 of 39 main deploys (no report; feeds §3.1) |
| **this session — our code, not a regression of the criterion** | check-thread stalls 57 (§3.3); 5 "Came back" ledger entries (partial fixes, §4); plugin-records store 6.7 GB and growing (no report, §5) |
| slow-ops session (conv-1793965643-wr9rnk) | fseventsd relapse (`host-io-degraded` 41); `watch-delivery:fs-events` 541 / kqueue 44; `wait fs-*` ~1,690; `pages.tree.v2` no-op pushes; the orphaned engine test spinning a core (task-1794190702-eld769) |
| standing worklist | `wait read-admit` 2,673 / `background-acquire` 580 (the herd; would shrink with restart-skip working); boot budgets 159; ResizeObserver 97; partial-message op-rate 68; live-state wedges 16 (two of 3.6 h and 38 min); transcript-watcher 157; promo-film worktree exits 5; worktree SIGSEGV 1; type-check divergence 2 (task-1794151616-omc11e); db-lock-holder 2 |

## 7. Decisions for the user

1. **Restart-skip blind spot (§3.1):** file a task so `source-digest` resolves the generated
   `@browser-host/…` specifiers, and so a closure that cannot be measured is reported, not silent?
   It is our fix that stopped working, but D23 lets me file only a regression we caused.
2. **Plugin-records store size (§5):** accept ~12 GB at steady state, or file a task to bound it
   (fewer keys per code version, or a shorter retention for worktree-only keys)?
3. **The orphaned test process (§0):** kill pid 55054 (safe: a test run from a finished task)?
   The kqueue hang it shows belongs to the slow-ops session.

## 8. Mental model

- **The things that used to break main are fixed, and stayed fixed under a hard day.** The day
  had 4.6× more work than the last measure, and the computer's file-change service was overloaded
  for most of it. Still:
  - main never failed to start, its event loop never stalled for more than 3 s, and it never crashed;
  - no background job died;
  - the error-level notifications fell to 43, under one per push.
- **What you still see is mostly yellow "it was slow" warnings, and most of those are queueing.**
  - Every time main restarts, every open tab reconnects at once. Their requests wait about 2 s
    in a line, and each wait files a warning.
  - Main restarted on all 39 deploys, partly because the check that should skip a needless
    restart can no longer measure main's code since the website's demo was added.
  - The rest comes from macOS's file-change service flooding again (up to 500× the normal event
    rate), which made the app hear some file changes up to 23 minutes late.
- **Our own fixes left three loose ends, none of them visible as errors:**
  - a crash of the website's development build, fixed in the same change that exposed it, before it landed;
  - check-run stalls that come from our faster check path;
  - a shared cache file of build facts that is 6.7 GB and still growing.
- **The 5 "Came back" entries in the fix ledger are partial fixes.** Each removed one of two
  causes, and is no worse than before. The cause left is a ~10-minute file-history replay at boot
  (made much worse by the flood), or a known, filed leftover.

**Nothing is hidden.**
- No metric was dropped or re-thresholded, and no report was muted, fixed or filed.
- Two limits of the sources are stated:
  - the hourly buckets are shifted 1.4 min from the window;
  - `job_runs` is pruned to 20 rows per job, so its totals are a floor.
- The flood hours are counted, not excluded, because I could not trace them to the killed loops.
- The one regression our fixes caused is named (§2.2), with the commit that fixed it.
- The one fix that stopped working is named (§3.1).
- Three things I did not root-cause are said to be unknown:
  - the 3.6 h and 38 min wedges;
  - the worktree segfault;
  - why fseventsd relapsed.
