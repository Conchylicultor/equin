# Performance investigations

Living index of the performance work. **We keep fixing the wrong path** — so the
rule here is: *measure and confirm the root cause without doubt before changing any
code.* Each session re-validates the prior session's conclusion against fresh data
rather than inheriting it.

> **MANDATORY:** before any perf investigation, profiling pass, or perf fix, agents
> **MUST** follow the [`perfs-investigation`](../../.claude/skills/perfs-investigation/SKILL.md)
> skill. It encodes the method below as enforced phases + stopping gates (rate×cost,
> trace-to-origin-not-hotspot, sufficiency/legitimacy/counterfactual gates,
> containment-vs-cure altitudes). The summary below is the index; the skill is the procedure.

> **KEEP THESE DOCS CURRENT — non-negotiable.** This index **and** the per-issue docs are *living*
> documents. Every time you make a new discovery — name a hotspot, kill a hypothesis (with the gate
> that killed it), confirm/refute a suspect, peel a deeper layer, or re-validate a number — update the
> relevant issue doc **and** this index's one-paragraph summary **in the same turn**, before you stop.
> A superseded suspect list left in place is how the next session re-derives the wrong path.

> **STATUS STAYS `(Ongoing)` — do not promote prematurely.** Naming the *hotspot* is **not** finding
> the *root cause*: you are almost always one layer short (the hotspot is where the cost *shows up*,
> not why the work happens). Keep an issue `(Ongoing)` while live — never "named / fix-planned /
> solved" — and only mark `(Completed)` once a fix has **landed AND been re-validated on data** (the
> numbers moved on `singularity`). Record discoveries in the body; leave the status conservative.

## Goal

**Make the app feel instant: any page loads in < 1 s, including cold start.**

## Method (non-negotiable) — see the [`perfs-investigation`](../../.claude/skills/perfs-investigation/SKILL.md) skill for the full procedure

1. **Front door first — situate the incident before you quantify.** Open
   **Debug → Reports** (is a report already filed, with a linked *View-trace*?)
   and the **Timeline** (`get_timeline` MCP, or Debug → Slow Events → Timeline)
   for the window around the symptom — it shows the *whole* event: never-ready
   boots, deploy restarts, build/check fleets, health heat and duress bands — so
   you quantify the real incident, not a fragment of it. THEN reproduce and
   quantify with the `benchmark_boot` MCP tool **and** the live
   `get_runtime_profile` (aggregate `waits`, not just `avgMs`). See the
   [`debug`](../../.claude/skills/debug/SKILL.md) skill's STEP 0.
2. Separate **work** from **wait** — a high `avgMs` with a high `waitMs` / low `selfMs`
   is queueing, not a slow op. Every entry (composite `flush`/`push` included) now
   decomposes into `waitMs`/`childMs`/`selfMs`; find the *dominant* wait layer before
   theorizing, and read `recentMaxMs` (not the since-boot `maxMs`) for "slow now".
3. **Decompose every cost into `rate × cost-per-occurrence` and trace to the origin, not
   the hotspot.** The biggest number is usually a downstream *amplifier*; amplitude is not
   causality. A `no-op`/`redundant`/`unchanged` signal means look *upstream*. Stop only at an
   event that *legitimately* should occur at that rate (the legitimacy gate) — not at the first
   sufficient cause.
4. Only after the root cause is confirmed beyond doubt (three converging lines of evidence),
   write a fix plan — and name its altitude (containment = make it cheap / cure = make it not
   happen).

## Sessions

> Each issue below keeps only a high-level paragraph; its own doc holds that issue's full session
> log **and its own Causes — checklist** (✅ confirmed · ❌ discarded · 🔬 open). One doc per issue
> (not a global log) so the history scales as issues accrue.

### Host saturation — agent build/check fleets starve the main backend (Ongoing)

The user-facing "main app slow + data doesn't refresh" bursts (most working days since ~Jun 18) are
**host-level scheduler starvation**, not main's code: concurrent agent build/check runs (4 admitted
by design — `floor(cpus/4)` build slots, each fanning ~4–7 full-TS-program type-check workers +
eslint + vite) push an 18-core host to load 25–35 with GBs of swap; the single-threaded main backend
(default QoS, same tier as the storm) stalls to event-loop p99 950–1700 ms (healthy: 3–15 ms), the
WS cuts every ~10–12 s, and each reconnect replays ~116 subscriptions into the starved backend —
lost pushes read as "stale data". Confirmed by cross-backend control (an idle unrelated worktree
backend stalls at the same minutes), deploy/onset separation, dose–response recovery with no change
on main, and a live mid-burst intervention. **⚠ Instrumentation trap recorded in the doc:** `ps ni`
does NOT reflect darwinbg (zsh `bgnice` forged the ni=5 "demoted" readings; `pri` decays for
sleepers AND hogs) — `taskpolicy -b` failures are loud on stderr; silence means it took.
**Fixes landed on main 2026-07-08 (`2a7660401`), NOT yet re-validated under a live burst:**
(1) type-check workers self-demote at their spawn site unless on branch `main` (no inheritance
reliance); (2) `boostInteractiveQos()` — the main backend raises its event-loop thread to
user-interactive QoS at boot, strictly `isMain()`-gated (verified 0x11→0x21 readback; gate tested
±). **Second pass landed on main 2026-07-08 (`e70d327f7`, containment):** (3) the ~10–12 s WS-cut is Bun's default 10 s **top-level `Bun.serve` `idleTimeout`**
(runtime-confirmed: it cuts in-flight *unix* requests whose handler writes no bytes, sweep
grid-quantized ~N+4 s → nominal 10 s = the observed cadence) — set to `idleTimeout: 60`, killing the
reconnect/resubscribe amplifier; (4) log rotation on the log-channels substrate (128 MB cap / keep 3,
in-memory byte-counter gate) bounds the 4 GB unrotated `live-state.jsonl`; push-check E-core latency
**measured & cleared** (within noise on a quiet warm host — the representative push case; undemoting
would defeat the isolation, so no change). **Admission-control tightening landed on main 2026-07-10
(`e24e6040a`):** the type-check fleet is bounded host-wide by a lane-keyed flock budget
(`min(cpus/2, 0.5·mem/2.7 GB)` via host-semaphore `acquireShare`) — see
[`research/2026-07-09-global-interactive-lane-under-load.md`](../2026-07-09-global-interactive-lane-under-load.md);
related boot-time work bounding (warmup/corpus-index/retention primitives, `4fb4b9d32` 2026-07-09) →
[`research/2026-07-08-global-bounding-boot-time-work.md`](../2026-07-08-global-bounding-boot-time-work.md).
**⚠ 2026-07-10 burst (09:03–09:21Z) — the symptom reproduced at FULL severity with the stack landed:**
471 s `/agents` page load, spanning a main deploy restart + 13 concurrent build/check processes at
load ~9.6–16; per live profiling the slow layer this time was **Postgres-side query latency under
host contention + the boot burst — NOT backend event-loop stall and NOT pool-acquire wait** (both
measured quiet; main health p99 ≤ 466 ms during the burst). The remediation stack is therefore NOT
validated, and the dominant starvation channel may have shifted from the scheduler to Postgres/IO.
Open: A/B the landed stack under the next burst (now including the Postgres-latency channel); sweep
pre-Jul-7 undemoted agent sessions; rate-limit the always-on live-state trace tier (the ~4 lines/s
origin behind the log growth). Full evidence + counterfactuals + implementation →
**[`2026-07-08-host-saturation-agent-checks-starve-main.md`](./2026-07-08-host-saturation-agent-checks-starve-main.md)**
(+ finish plan **[`2026-07-08-host-saturation-remediation-PLAN.md`](./2026-07-08-host-saturation-remediation-PLAN.md)**).
**2026-07-09/10 continuation — pool collapse cured at its layer, swap-in named as the lag amplifier:**
four more freezes fully forensicated (two distinct DB-collapse variants: the `read-admit` convoy
1,377-deep and the pool eaten by ungated transactions/jobs 339-deep — incident report + fix direction
→ [`../2026-07-09-global-interactive-lane-under-load.md`](../2026-07-09-global-interactive-lane-under-load.md)).
Fixes landed on main: `fbcaec47c` (interactive lane — pool partitioned by origin class, transactions
leased, jobs gated) and `e24e6040a` (type-check worker fleet bounded host-wide, covering
`build`/`push`/`check` spawners) — both **verified working at their own layer during a live 07-10
03:29 freeze** (9 workers = budget; pg healthy) that froze the app anyway: the binding constraint
moved to **hop-count × a 1.3–1.5 s loop-lag quantum** under *aggregate* fleet load (≈6 claude
processes + subprocesses + `fseventsd` at 80 %). NEW dose–response cross-tab (9,608 samples): the
lag driver is **(load × swap-in)**, not load alone — load 24–40 with zero swap-in costs just 2 ms
(the QoS boost demonstrably works against pure CPU; "boost ineffective" killed on data), while
swap-in turns the same band into 19–433 ms+ (page faults block a boosted thread synchronously).
🔬 open: cold-page-victim hypothesis (backend = ideal paging victim; twin-probe + cold-switch
discriminators designed, unrun), `fseventsd` attribution, T1 acceptance test still unrun. Findings
only (remediation deliberately not yet proposed) →
**[`2026-07-10-host-saturation-post-fix-swap-amplifier-findings.md`](./2026-07-10-host-saturation-post-fix-swap-amplifier-findings.md)**.
**2026-07-11 00:45 episode — the swap-in proxy is refuted as the pressure metric; the amplifier at
main's layer is named:** live during a full freeze (load 36–40, flush wedged 355 s, `/sonata`
page-load 384 s), `swapInPagesPerSec` read **0** the whole time while the **compressor** thrashed at
a measured **240 k decompressions/s + 252 k compressions/s (~3.8 GB/s each way)**, pool 10→22 GB —
the 07-10 cross-tab's "swap-in" column misses the dominant channel (instrumentation gap; mechanism
— page faults block the boosted thread — survives, first live corroboration of the cold-page-victim
hypothesis). On main the freeze amplitude is the live-state sub path: clients chronically replay
their FULL sub set (~250 subs/tab: `config-v2.values` keyed per config FILE = 153 pks,
`page-block-doc` per block = 87) every few minutes even when healthy (~90 % of 20 k sendSubs/88 min
are replays); each replayed push-mode sub runs the FULL loader behind the 6-slot `read-admit` gate
(no version/ETag short-circuit; admission still precedes dedup) ⇒ a 5,242-deep sub convoy at 9.8 s
avg wait, ack starvation (650 sends vs 19 acks/min) tripping Bun `idleTimeout:60` ⇒ reconnect ⇒
replay — the feedback loop. Postgres healthy throughout; ≥6 concurrent builds (slot gate acquired
mid-build, main exempt) + ~12 claude sessions filled 64 GB. **Fixes BUILT same session (worktree
`claude-1783723665`, awaiting merge + live re-validation):** (1) bootEpoch version short-circuit —
an already-current sub is answered `up-to-date` from `entry.versions` with zero loader/gate slots
(`subShortCircuits` counter in `_debug`); (2) gate-after-dedup — the read-admit slot moved inside
the single-flight, N same-pk reads = 1 slot; (5) replay = ONE `sub-batch` frame answered by ONE
`up-to-date-batch`, per-tab sub tagging + `complete:true` reconciliation + `pagehide` `unsub-tab`
(stale-sub cure), stagger deleted; (4) `health-host` now samples compressions/decompressions per
sec + Health-pane chart. Plus two latent bugs found by plan verification and fixed: the drift/no-base
recovery resub whose healing ack was `<=`-dropped (forceFullResub resets baselines), and every
follower tab full-replaying on ANY tab join (shared-websocket open-dedup) — a chronic driver of the
healthy-period replay bursts. 111/111 runtime + 36/36 DOM hazard tests green. NOT built: fleet
*memory* admission (fix 3 — user deferred). Full evidence + checklist →
**[`2026-07-11-compressor-thrash-subscription-replay-storm.md`](./2026-07-11-compressor-thrash-subscription-replay-storm.md)**.
**2026-07-17 recurrence (~10:00–10:30) — full severity with the 07-11 stack landed; the stack is
partially validated and the origin confirmed untreated:** compressor 23.5 GB @ ~240 k
compressions+decompressions/s, free ~155 MB, load 46/18; main = measurable paging victim
(`residentMb` 88–140 of 710 MB footprint, loop p50 0.5–1.2 s); pages take minutes because the
delivery/flush wedge reproduces bigger (`deliver:*` 127–197 s avg, `flushNotifies` recentMax 427 s).
The sub short-circuit ENGAGES (397 `subShortCircuits`) but is bypassed by design on fresh page
loads (no client version state) and by the one mid-storm main restart (13:44 deploy → boot
**wedged 11.5 min without ever reaching `ready`** = main down 13:44→13:56, then the replacement
epoch-reset cold-boot into peak thrash — 🔬 NEW: nothing duress-gates a main deploy or alerts on a
never-ready boot). Exogenous fill: 6 build/push + 3 check runs, 78
claude processes, Chrome 26 GB; `fseventsd` 82 % again. 🔬 NEW: `corpus-index:ensure-fresh` 882
calls · avg 85.7 s · recentMax 573 s (~0.5 reads/s — rate unexplained, not duress-shed). Remaining
altitudes: fix 3 (fleet *memory* admission) + duress-gating deploys/restarts of main. Episode data →
§"2026-07-17 recurrence" in the 07-11 doc.
**2026-07-16 continuation — the paging-victim investigation gets its harness + main-layer churn fixes
(worktree `att-1784197364-no0m`, awaiting merge):** A3 heap attribution RUN on live main — JS heap is
only ~97 MB self of a 352–469 MB phys_footprint (keyed-snapshot strings ~5–6 MB, cost corpus-index
2.5 MB and not even loaded ⇒ its retention bound SKIPPED by gate); the standing footprint is mostly
code + off-heap native, and the 1.26 GB episode peaks were transient churn backlog ⇒ **axis (b) churn
is the fixable axis**. BUILT: `residentMb` (ri_resident_size) in every health sample —
`physFootprint − resident` is the per-backend squeeze trend; the `debug/paging-probe` twin-probe
discriminator (lean / fat-idle / fat-touch child processes, config-gated OFF, `lateByMs` headline);
serialize-once broadcast (one stringify per frame, was per-subscriber); hash-based keyed snapshots
(64-bit wyhash instead of retained full-row JSON; `scopedMembership` keeps strings for its persist
reconstruction). 🔬 still unrun: the A4 controlled-pressure run (user-gated) = the discriminator
verdicts + the 07-11 stack's live re-validation. Plan + session log →
**[`2026-07-16-main-paging-victim-investigation-PLAN.md`](./2026-07-16-main-paging-victim-investigation-PLAN.md)**.

### Bounded working sets — architecture direction (2026-07-18)

Distilled from the 07-17 compressor-thrash recurrence: the reason one interaction takes *minutes*
under memory pressure is the **thrashing cliff** — a single navigation's working set is O(total app
state) (read-time loader aggregation, heap-warehoused resource values, full-heap GC marks, shared
gates convoying everything behind the collapsed op), so when the kernel squeezes main's residency
below that working set, throughput collapses 100–500× (measured: `deliver:conversation-categories`
sub-second → 393 s; page load 506 s; resident 66–150 MB of ~700 MB footprint). Apps whose
interactions touch O(one screen) (VS Code server) degrade to seconds on the same host. The recorded
direction: **an interaction's working set must be O(visible/changed), never O(total state)** — four
rules (stateless server / state in partial-residency storage; write-time incremental derivation;
small managed heap; windowed reads) and a per-resource migration sequence whose contract
(row-shaped, delta-synced) is deliberately Zero-compatible. Also records the 07-17 correction: the
gateway's blue-green hot restart **worked** (the "main down 11.5 min" claim is refuted by
`gateway.log`); a failed hot restart is silent in the gateway log (observability gap, owned by the
debug-surface consolidation workstream). Full doc →
**[`2026-07-18-bounded-working-set-architecture.md`](./2026-07-18-bounded-working-set-architecture.md)**.
**2026-07-18 — the contract is DESIGNED + Phases 0/1 BUILT (worktree `att-1784331173-klc4`,
awaiting merge + live re-validation):** the bounded-membership keyed resource (window `{limit}` /
point `{ids}` selectors on the existing keyed wire; M5 generalized to a bounded `windowIdsOf` +
an order-signature seam so order-column updates re-derive the window), `windowQueryResource`
compiler, `primitives/keyset` leaf, and the pilot trio — `pushes` (per-attempt resource +
de-persisted cascade carrier), `notifications` (window 200/500 — kills the measured ~2 GB/day
FULL-recompute+persist churn from 14 k count-bump updates/day, the top rate×cost offender),
`conversation-categories` (point; the O(n) per-row `.find` gone). Migrated resources are no
longer persisted (generic boot sweep deletes stale snapshot rows); boot-snapshot serves bounded
default windows. Design corrections vs the architecture doc (the offenders are unbounded flat
collections, NOT read-time aggregations; the wire was already row-shaped; rank by SERIALIZED
boot-payload size, not `pg_column_size`) + implementation log + phased end-state (delete
live-state-snapshot + the changelog write once trees migrate) →
**[`../2026-07-18-global-bounded-working-set-resource-contract.md`](../2026-07-18-global-bounded-working-set-resource-contract.md)**.
Follow-up task chain filed (flat sweep → trees → commits-graph id-routing → legacy deletion →
squeezed-backend acceptance run). NEW resources must use the bounded contract — rule recorded in
the root `CLAUDE.md` Coding Style section; a burndown-style enforcement check is a filed task.

### Read-admission wedge — nested heavy-read slots deadlock the warmup drain (Completed)

2026-07-10, 13:10 and again ~3 min after a 15:53 restart — **recurs on every main boot** since
`0d50139c7`: the app renders but **no live-state data ever arrives**, on a quiet host (NOT the
saturation shape). Root cause CONFIRMED: the warmup executor wraps every warmup in
`withHeavyReadSlot` (`WARMUP_CONCURRENCY=2`) and the corpus-index refresh acquires ANOTHER
`withHeavyReadSlot` **per file inside it**; with a **second** corpus index added today
(`sonata.midi-folders.reconcile`, `0d50139c7`) both nesting warmups run concurrently, their outer
wrappers hold both `heavy-read-local` slots (size 2), and their inner per-file acquisitions queue on
themselves — **circular wait, forever** (lsof: backend parks holding `slot-2/3.lock`, no children,
no open data file; both corpus indexes never persist). Every heavy-read consumer
(`edited-files`/`commits-graph.delta`) then starves at the local gate, and those starved loaders pin
the 6-slot `read-admit` gate (admission precedes single-flight dedup ⇒ resubscribe-replay joiners
burn the remaining slots, 3,833 queued) → `handleSub` never acks ANY sub while plain HTTP stays fast.
An earlier "Bun lost spawn-exit" hypothesis is ❌ (killed by lsof). **Origin cure landed
(`f3a35a905`) AND re-validated live 2026-07-10 ~16:20: `withHeavyReadSlot` is now reentrant**
(ambient AsyncLocalStorage holding-flag; regression test pins the deadlock shape both ways) — on the
16:17 boot both corpus warmups completed for the first time (midi index persisted, cost-usage
refreshed), gates drained to 0-queued, and sub-acks flow again. Open containments (not built):
gate-after-dedup (joiners must not burn read-admit slots), slot-age watchdog. Full evidence +
checklist →
**[`2026-07-10-read-admit-wedge-stuck-git-loaders.md`](./2026-07-10-read-admit-wedge-stuck-git-loaders.md)**.

### Git-derived loaders — `edited-files` / `commits-graph` (Ongoing)

The dominant remaining real cost now that the churn is fixed — and the *original* cause (A), masked
while the big-blob churn dominated. Fresh decomposition on `singularity`: `edited-files` is
**work-bound** (~1.3–1.5 s of real git work per memo miss — 4 serial git spawns under the **4-slot**
host heavy-read gate, `floor(cpus/4)` on an 18-CPU box); `commits-graph.delta` is **wait-bound**
(workMs 82 vs ~843 ms waiting on that gate behind `edited-files` — a victim, not slow itself). Open
rate-axis suspicion before any cost-axis fix: the @parcel watcher recomputes on *every* fs event and
only early-returns the unchanged result **after** paying the full git compute — the same no-op shape
as the fixed churn, on the fs-watch axis. **2026-07-01 re-validation:** still live on `singularity`
(loaders `last_ms` 14–18 s / peak ~12 min; `heavy-read-local` last 48 s). **2026-07-01 (2) Phase-2
flush trace — the flush stall is NOT this issue (refuted, gate 2 + counterfactual):** the git loaders
are `sub`-origin only and `external`/non-`bootCritical`, so they never enter `flushNotifies`; a
coherent window shows the flush stays **≤1.3 s (6 ms during the herd)** while 31.9 s `edited-files`
subs run concurrently ⇒ that 31.9 s is async I/O wait that yields the loop, not an event-loop/flush
block. The minutes-scale `flushNotifies` peak is the **bootCritical DB set** FULL-recomputing under
the **DB-pool** `loader-acquire` tail (40–75 s) at boot/catch-up (`live-state-snapshot.onReady` →
`recomputeResource` + `runCatchUp`) — the **cold-boot fan-out root below**; the "new conversation slow
in sidebar" symptom is the WS-reconnect herd, reattributed there. This issue is now scoped to the
`sub`/first-subscribe + fs-watch axis. **Next:** Phase-2 trace of watcher recompute rate vs real
change rate (unchanged). Full detail + sessions + checklist →
**[`issue-git-derived-loaders.md`](./issue-git-derived-loaders.md)**.

### Launching a task/conversation is slow (Ongoing)

Clicking **Launch** blocks the UI until `POST /api/conversations` resolves — the endpoint is
**synchronous end-to-end** (no job between click and response; `launch-control.tsx:74` awaits it,
`handleCreate` → `createConversation` awaits its whole body). Observed **12.97 s** in one live
sample on `singularity`; uncontended floor **~3.8 s**. The one expensive blocking step on the
critical path is **`git worktree add`** — a full working-tree checkout of **8385 tracked files**
(`setupWorktree`, `worktree.ts:57-77`, awaited at `lifecycle.ts:139`), measured at ~3.8 s in
isolation. The DB fork, config fork, and Claude-CLI boot are all correctly **off** the path
(async job / detached tmux). The amplifier that lifts 3.8 s → 13 s is **machine IO/CPU contention**,
NOT a git lock — **index-lock serialization refuted** (2026-07-02 Phase-2 controlled trace): the
checkout is `git reset --hard` against the new worktree's *own* index (`GIT_DIR=<newpath>/.git`),
holds no repo-global lock, and K concurrent adds run in **parallel** (K=6 wall 5.7 s, not the 19.2 s
a lock would force; zero lock errors). Instead a foreground add slows **3.2 s → 7.7 s median / 10.7 s
max (+141 %)** under a 6-way remove/add churn (mirroring the 58 s `worktree-cleanup.reap-stale`'s
`pMap(limit=6)` full-tree removes), which stacked with the same-window 2× `database.fork` `pg_restore`
+ Haiku classify closes the gap to ~13 s.
**Not an event-loop block** — the cost is awaited-subprocess wall-clock that yields the loop;
`workMs` is a profiler-labeling artifact here (do not re-diagnose as CPU starvation like
`buildPluginTree`). **Cure BUILT — 2026-07-10 verification: landed on main as `40ef2ae9f`
(2026-07-02):** worktree setup + spawn moved off the interactive response into the durable
`conversations.spawn` job, returning a `starting` row immediately; worktree-validated at ~390 ms
POST (was 3.8–13 s), **not yet re-measured on `singularity` post-merge**. The `worktree-mutate`
host gate landed as `a23732d29` (2026-07-02); its launch-during-reap validation trace has still not
run. Open questions (row-reorder safety, the still-forking-DB race) tracked in the doc. Full evidence + Causes checklist
+ next steps → **[`issue-launch-conversation-slow.md`](./issue-launch-conversation-slow.md)**.
**Throughput follow-up (add/remove contention under load)** bounded by the host `worktree-mutate`
semaphore (containment) → **[`2026-07-02-worktree-mutation-host-gate-DESIGN.md`](./2026-07-02-worktree-mutation-host-gate-DESIGN.md)**.
**Cost-axis origin RESOLVED 2026-07-02 — the "checkout is irreducible" assumption is REFUTED:** agents
edit < 1 % of the tree but the mandatory whole-tree `./equin build` kills *sparse* checkout;
the real lever is APFS directory `clonefile(2)` — materialize the (still-full) tree copy-on-write in
**~0.24 s vs ~3.8 s (16×, 80× under load)**, dissolving the add-vs-reap contention the gate only
bounds. Design + measurements (3 probes) + clean git integration → **[`2026-07-02-worktree-checkout-clonefile-DESIGN.md`](./2026-07-02-worktree-checkout-clonefile-DESIGN.md)**
(**still design-only as of 2026-07-10** — no clonefile code in the tree).

### Conversation load 40+ s → main-thread event-loop block → `buildPluginTree` over-extraction (Ongoing)

"Loading a conversation takes 40+ s" was traced **past** DB-pool exhaustion, the git gate, and the
fan-out herd (all victims/triggers) to its real layer: the main backend's **single event loop
monopolized by one synchronous op for 10–46 s**. The on-stall JSC flight recorder
(`debug/health-monitor`, `logs/stall-profiles.jsonl`) named the **hotspot: `buildPluginTree`** —
`plugin-meta/plugin-tree` Step 4b, a synchronous `node × facet` `readFileSync` walk over **4408
source files / 10.6 MB**, run **uncached** on `GET /api/plugin-view/tree`. Three converging lines:
profile (`readFileSync` 59.6 %, `sampleRateHz 176` ⇒ real in-process block, not CPU starvation) +
system data (`/api/plugin-view/tree` max 10.3 s with `allow-files`/`viewed` queued at the consecutive
timestamps right behind it ⇒ loaders are **victims**) + code. **Suspects killed by data:** `stats/cost/*`
(handoff #2) chunks per-file (18 ms max block, measured) — victim; no resource value > 444 kB; CPU
starvation killed by `sampleRateHz`; a pre-capture speculative suspect-map (`persist.ts` `JSON.stringify`,
`tableToResources`, …) **falsified** — none in the captured stack.
**⚠️ Deeper layer (still being designed — do NOT stop at the hotspot):** the per-call cost is **NOT
irreducible**, so caching it would be containment hiding waste. `handleTree` eagerly builds **all 9
facets** (4 of which `readFileSync`-walk every source file) **plus `classifyEdges`/`disabledClosure`,
to populate `facets`/`disabled` that its own hot consumers throw away** — `explorer` renders no
`disabled`, `config-nav` builds `facets:{}` itself, `plugin-link` uses only `description`. They need
only the cheap async structural skeleton (steps 1–3, `collectCoreFields`); only the Studio
**Contributions** tab (all-plugins facets) and the **detail pane** (one plugin's facets) genuinely
read facets. **Real cure (origin, not cache):** make the tree **structure-only** for the hot path,
and source facets lazily (a single cached, fast aggregate shared by Contributions + the detail pane —
**not** per-plugin, since the detail pane shows `importedBy`, a relate reverse-index needing all plugins).
**Altitude 2 (fast aggregate algorithm) LANDED & validated on the worktree (2026-06-30):** async
read-once in-memory FS snapshot → facet `extract` touches zero disk → **max event-loop block 50 s → ~1.5 s
cold / ~0.3 s warm**, output byte-identical; end-to-end, a concurrent cheap endpoint stays <75 ms *during*
an 8 s tree build (no longer a victim). **Altitude 1 (structure-only hot path + cached accessors +
client-served `disabled` cascade) LANDED & validated on the worktree (2026-07-01, `att-1782924979-2mnf`):**
`GET /api/plugin-view/tree` in-process workMs **382 (max 1.1 s cold / 3.3 ms warm)** — structure-only, no
`extract`/`relate`; **`stall-profiles.jsonl` empty since boot** (the `←buildPluginTree` stall is gone);
facets moved to a new cached `GET /api/plugin-view/facets-tree` (rare Studio/detail path, cached +
single-flight) whose build stays non-blocking (`/api/health/ready` max **0.32 ms** *during* a 13.9 s cold
faceted build); `/api/composition/data` now **84 ms** (`git-memo-hit` on the shared faceted build — no
duplicate walk). Both corrections confirmed against live data: the explorer `disabled` cascade is served as
`disabledIds` on `/api/composition/data` (**12** = `review.plugin-changes` seed + subtree + `render-diff`
importers) and derived client-side; the detail pane reads `importedBy` off the full faceted aggregate (339
nodes populated). All 60 `./equin check`s pass. **2026-07-10 verification: landed on main as
`978a1d621` (2026-07-02).** Post-merge re-validation on `singularity` not yet recorded (corroboration:
the latest stall capture, 2026-07-09, no longer names `buildPluginTree`).
Residual: the rare faceted endpoint's cold build is still multi-second and can 502 under load (cached after;
non-blocking). Full arc → newest implement doc
**[`2026-06-30-buildplugintree-structure-only-IMPLEMENT.md`](./2026-06-30-buildplugintree-structure-only-IMPLEMENT.md)**;
design **[`2026-06-29-perfs-buildplugintree-eventloop-block-FIX.md`](./2026-06-29-perfs-buildplugintree-eventloop-block-FIX.md)**;
predecessor [`…-HANDOFF.md`](./2026-06-29-conversation-load-40s-eventloop-block-HANDOFF.md).

### Cold-boot fan-out (Ongoing)

The remaining `< 1 s including cold start` violator — and the cause of **"loading a conversation
takes 40+ s"** (2026-06-29). At backend boot *and on every WS reconnect* all live-state resources
re-subscribe at once; the scarce resource is the **per-backend 10-slot DB loader gate + the single
event loop** (NOT the host git gate — loaders are fast in isolation even under host-gate saturation:
`edited-files` 1.4 s, `commits-graph.delta` 0.7 s). The ~30-resource simultaneous fan-out saturates
those 10 slots, queueing every loader's query into the 40–75 s tails (`[acquire]` max 75.9 s);
the conversation's own loaders are downstream **victims**. Confirmed beyond doubt (live profile +
`slow_ops` + `benchmark_boot`); the no-op churn fix re-validated as holding. Full detail + sessions
+ checklist → **[`issue-cold-boot-fanout.md`](./issue-cold-boot-fanout.md)**.

### Live-state no-op churn & unbounded `push` resources (Completed)

The headline symptom — multi-second flush stalls, "simple pages take seconds" — traced past two
amplified hotspots (the `notifications` 1.88 MB mega-blob; the 181 MB `live_state_snapshot` TOAST
bloat) to its origin: the conversations poller re-issuing a **zero-row write every 1 s**, which the
STATEMENT-level change-feed trigger amplified into FULL-table invalidations → a ~12/s no-op recompute
+ full-blob snapshot-UPSERT storm. Both altitudes landed on main — the **boundary invariant** (trigger
never notifies on a zero-row statement) and the **origin cure** (stop re-adopting `done`-but-live
sessions), `1f6b27092`; plus the earlier notifications-growth fix `a8f9da4b6`. **Validated on
`singularity`:** flush **22.4 s → 571 ms**, `conversations` INSERT **4.0/s → 0.003/s**,
`live_state_snapshot` **155 MB → 14 MB**, `live-state-noop` accumulation stopped. Full arc + sessions
+ checklist → **[`issue-live-state-noop-churn.md`](./issue-live-state-noop-churn.md)**.
