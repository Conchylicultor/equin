# Host saturation: undemoted agent build/check fleets starve the main backend

**Status:** Root cause confirmed (~95%+): natural experiment from the 2026-07-08 incident window, re-validated live at 17:12 the same day, plus a direct intervention experiment (demoting stray workers mid-burst — see "Live intervention experiment"). Remediations 1 (worker-site demotion) and 3 (main-only QoS boost) **implemented 2026-07-08** on branch `claude-web/att-1783523464-14pz` — see "Implemented" at the bottom.

> **⚠ Observability correction (2026-07-08, post-implementation):** `ps -o ni` is NOT a valid darwinbg observable. A `taskpolicy -b` child does not change its nice value; the ni=5 "demoted" readings in this doc came from **zsh's default `bgnice` option** (renices `&` background jobs to 5), and ni=0 says nothing about darwinbg state. `ps -o pri` is also unusable (dynamic priority decays to ~4 for both sleepers and CPU hogs). Consequently the "10 of 11 workers undemoted" priority evidence below is **unreliable** — some of those fleets may have been darwinbg via post-Jul-7 session inheritance. The saturation → starvation causal chain stands on the health/dose-response/cross-backend evidence, which is priority-agnostic. What `taskpolicy -b` failures actually look like: a loud stderr line (`setpriority(): …`); silence means the demotion took. There is no good unprivileged spot-check observable; `sudo launchctl procinfo <pid>` (darwin role) is the authoritative one.

**Symptom (user-reported):** the main app (`singularity.localhost:9000`) is very slow to load and data does not refresh. Occurs in bursts multiple times a day, most working days, since at least Jun 18. Other Mac apps stay responsive during episodes (see "Why other Mac apps are unaffected" — this observation is itself diagnostic).

Investigated from: main worktree during the live 2026-07-08 incident (~16:14–16:40 local), re-verified from worktree `att-1783523464-14pz` at 17:12–17:20 local while a second burst was active.

---

## Root cause (causal chain)

1. **Concurrent agent build/check runs saturate the host.** Each run spawns up to 4 heavy type-check workers (one per tsconfig target: `web-core`, `server-core`, `central-core`, `test` — `type-check/check/index.ts:165-179`, concurrency = `min(targets, cpus-1, totalmem*0.5/2.7GB)`), each a bun process building a full TS program. During the incident, 4 runs overlapped → 11 workers + eslint + vite on an 18-core machine → load average 35, ~65 MB free RAM, 3.4 GB swap used, `fseventsd` at 80% CPU.
2. **Most workers run at full (default) priority.** The priority-isolation counter-measure (`spawn-priority`, darwinbg via `taskpolicy -b`) landed only 2026-07-07 (`62130bae6`) and its coverage is partial — of 3 concurrent fleets observed, 1 ran demoted, 2 undemoted. At 17:12 on Jul 8: **10 of 11 live workers at nice=0**. Coverage gaps (verified in code today, see below).
3. **The starved single-threaded backend stalls.** Main backend event-loop lag hit p50 ~175 ms / p99 ~950 ms (fresh 17:12 sample: p99 1,715 ms; healthy baseline p50 <1 ms / p99 3–15 ms). Every HTTP response and live-state push queues behind these stalls → slow loads, late data.
4. **Self-amplifying feedback loop → "data doesn't refresh".** The stall cuts the WebSockets: gateway logged `reverse proxy error: EOF` every ~10–12 s during the window (`~/.singularity/logs/gateway.log`). Each client reconnect replays ~116 live-state subscriptions (teardown → ws-open → replaySubs → sendSub×116 → `drop reason=stale-version` cycles in `~/.singularity/worktrees/singularity/logs/live-state.jsonl`), adding load to the starved backend. While sockets are down, pushes are lost → UI sits stale.

## Evidence (all read-only, reproducible)

- **Health history:** `~/.singularity/worktrees/singularity/logs/health.jsonl` — hourly p99 buckets show single-digit ms on normal days (Jul 5–7 even with heavy agent activity), spikes only in burst windows (Jul 7 21:00–23:00 UTC, Jul 8 14:14+ UTC). Timestamps are UTC; huge maxP99 values (100k–1M ms) at low sample counts are laptop-sleep artifacts, not incidents.
- **Cross-backend control:** `~/.singularity/worktrees/att-1783518477-ga68/logs/health.jsonl` — an unrelated worktree backend (different code, zero traffic) stalled at the exact same minutes as main (16:23–16:25: 854/3339/3167 ms vs main's 991/2496/2137 ms) → host-level cause, not main's code.
- **Deploy/onset separation:** main was hot-restarted 16:14 (new code deployed via push); ran at p99 11–290 ms until 16:22 when additional check fleets started.
- **Dose–response (natural):** as workers drained (11→7→3) and load fell (35→22→18), main recovered to p50 0.8 ms / p99 9–28 ms with no change or restart on main.
- **Not internal:** `gcPreciseCount=0` in all samples; main process at ~16% of one core (not pegged) while lagging → waiting on the scheduler, not on itself.
- **Symptom duration:** slow-op markers (`~/.singularity/worktrees/singularity/logs/slow-op-markers.jsonl`) fired 8k–57k/day nearly every working day since Jun 18 (log start); near-zero Jul 4–6 (idle days) → symptom tracks agent build activity. Host over 18-core capacity in 15–45% of samples on most days since Jun 18 (`health-host.jsonl`).
- **Priority evidence:** `ps -eo pid,ni,stat,%cpu,command | grep '[t]ype-check.*worker.ts'` shows workers from different worktrees at nice=0 (undemoted) and nice=5 (spawned demoted) simultaneously. At 17:12 Jul 8: 10× ni=0, 1× ni=5.

### Live intervention experiment (2026-07-08 ~17:17)

During the second burst, the stray undemoted workers were demoted in place (`taskpolicy -b -p <pid>` on the 5 still-running ni=0 workers; 2 had already exited).

- Before (17:14–17:17, 7 undemoted workers; p99 had hit 1,715 ms at 17:12): p50 2.6–128 ms, p99 87–1,715 ms across the preceding minutes; load avg 25.
- Demoted the 5 still-running ni=0 workers at ~17:17 (2 had already exited).
- After (17:18–17:19, six consecutive 10 s samples): **p50 1.01–1.04 ms, p99 3.5–14.7 ms** — the exact healthy baseline; 1-min load 25 → 11.3.
- **Confound:** the fleet also drained to zero within the same 75 s window (final `ps` matched no workers), so demotion and natural drain can't be separated in this run. Taken together with the earlier natural dose–response (11→7→3 workers tracking recovery with no change on main), the causal picture is consistent; a clean A/B (demote a long-lived fleet mid-run and watch p99 collapse *while workers keep running*) remains the definitive version.

## Answered: why did 4 fleets run at once? (was open question 4)

By design. `cli/bin/host-semaphore.ts` sizes the build pool as `floor(cpus/4)` → **4 slots on an 18-core machine** (`buildSlotCount()`, host-semaphore.ts:27-34). On top of that:

- `push` has its own reserved slot ("effectively never contended" — a push's checks run *in addition to* 4 builds).
- main-branch builds are `exempt` (never queued).
- Standalone `./equin check` takes a `build` slot (`commands/check.ts:45`) unless `SINGULARITY_HOST_SLOT_HELD` marks it nested.

So the admission math allows 4 fleets × ~4 tsc workers + eslint + vite ≈ 20+ heavy processes — the semaphore assumed each job costs ~4 cores, but a fleet peaks well above that. Concurrency bounding alone can't fix this without making agents queue badly; priority isolation is the designed answer (one build legitimately fans across every core — see `spawn-priority/CLAUDE.md`).

## Demotion coverage gaps (verified in code, 2026-07-08)

1. **Type-check workers never demote at their own spawn site.** `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/index.ts:115` — `Bun.spawn([process.execPath, WORKER, jobPath], …)` with no `backgroundArgv`. Relies entirely on parent inheritance.
2. **`build.ts` demotes only tsc/vite, not the checks path.** `plugins/framework/plugins/cli/bin/commands/build.ts:951` — `const demote = slotKind === "build" ? backgroundArgv : …` is applied to the runtime-tsc/vite spawns; the in-process `runChecks()` call (which fans out the type-check workers) is not wrapped. The residual is even documented in the comment at build.ts:948-950 ("the checks runner's internal tsc/eslint workers are only demoted via session inheritance, not here").
3. **Standalone `./equin check` applies no demotion at all** (`commands/check.ts` imports the semaphore only).
4. **Agent sessions spawned before the Jul 7 deploy inherit nothing** — long-lived pre-Jul-7 tmux sessions still launch undemoted builds/checks. (This is the fleet observed undemoted today.)
5. Gateway-side is already correct: agent-worktree *backends* spawn darwinbg and get promoted to default on readiness (`gateway/worktree.go:868-879`, `:835-852`).

## Why other Mac apps are unaffected — and what "high priority like a GUI app" actually means

macOS schedules by QoS tier, roughly: **user-interactive** (UI threads of apps, boosted further for the frontmost app by RunningBoard) > **user-initiated** > **default** > **utility** > **background/darwinbg** (pinned to E-cores on Apple Silicon + IO-throttled).

- GUI apps' main threads run in the top tiers → they sit **above** the storm of default-tier bun workers. That's why the rest of the Mac feels fine.
- The main Singularity backend is a headless daemon whose event-loop thread runs at **default** — the *same* tier as every undemoted type-check worker. It doesn't get starved because it's special; it gets starved because it's *ordinary*.

So there are two symmetric moves, and they multiply:

1. **Push the bulk work below default** (darwinbg). Already the project's designed mechanism; the gaps above are the bug. Measured on this host (research/2026-07-07-global-background-work-priority-isolation.md): a default-priority probe ran ~idle-fast against 20 `-b` spinners. No privileges needed.
2. **Lift the main backend above default** — the direct answer to "make it high priority like a GUI app":
   - **In-process QoS self-boost (recommended, no root):** call `pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0)` from the backend's main thread at boot (bun:ffi `dlopen("libSystem.dylib")`, mirroring the flock FFI in host-semaphore.ts). Bun's event loop, HTTP handlers, and live-state pushes all run on that one thread — boosting it is precisely the mechanism that keeps GUI apps responsive (their UI thread's QoS class). Gate it to the main-branch backend (or let the gateway opt backends in). Caveats: boosts only the calling thread (GC/worker threads stay default — acceptable; the symptom is event-loop lag), and it needs an A/B measurement during a burst before trusting it.
   - **`sudo renice -n -10 -p <gateway pid> <main backend pid>`:** works process-wide and is inherited by children, but negative nice requires root and must be reapplied on every restart → needs a sudoers entry or a privileged helper. Fine as a manual stopgap, poor as plumbing.
   - **launchd LaunchAgent with `ProcessType: Interactive`** for the gateway (per-user, no root): sanctioned macOS way to mark a daemon interactive. But the gateway isn't the starved process — backends are its children and don't automatically inherit the boost — so this alone doesn't fix main.
   - **True RunningBoard/frontmost-app boost: not available** to a headless daemon. Confirmed; the QoS self-boost above is the closest equivalent and targets the exact thread that matters.

**Honest limit of any priority fix:** CPU priority does not cure memory pressure. During the incident the host had ~65 MB free and 3.4–5 GB swap in use — if main's pages are swapped out, it stalls on page-in regardless of QoS. Priority isolation is the main fix for the *scheduler* starvation; the concurrency bound and log-churn housekeeping below address the *memory/IO* component.

## Remediation (proposed, in priority order)

1. **Close the demotion gaps (the immediate fix — small, no privileges):**
   - Demote type-check workers at their own spawn site: `Bun.spawn(backgroundArgv([...]))` at `type-check/check/index.ts:115`. Since the check runner doesn't know the branch, plumb the decision from the callers (build.ts / check.ts know `branch === "main"`) — e.g. an env flag or `RunChecksOptions` field — so main-branch runs (user is waiting) stay undemoted and everything else demotes at the source, not via inheritance.
   - Extend the build.ts demotion to the checks path (kill the documented residual at build.ts:948-951).
   - Demote standalone agent-worktree `./equin check` runs the same way.
2. **Sweep pre-Jul-7 agent sessions:** restart long-lived tmux agent sessions (or one-shot `taskpolicy -b -p` their PIDs) so inheritance-based demotion actually covers them. This is what made 10/11 workers undemoted on Jul 8 despite the Jul 7 fix.
3. **QoS self-boost the main backend** (`pthread_set_qos_class_self_np` via bun:ffi at boot, main worktree only) — defense in depth: protects main from *any* future undemoted straggler instead of requiring every spawn site to be perfect forever. Optionally give the gateway a launchd `ProcessType: Interactive` plist. Measure A/B during a burst before declaring victory.
4. **Re-examine admission control:** 4 build slots (`floor(18/4)`) each fanning ~4–6 heavy children over-admits. Either count slots per *worker* rather than per *job*, or cut `buildSlotCount` (env `SINGULARITY_BUILD_CONCURRENCY` exists already). With demotion complete this becomes a memory bound more than a CPU bound (each worker ≈ 2.7 GB — the per-fleet memory guard at type-check/check/index.ts:166-170 does not account for *other* fleets).
5. **Housekeeping:** `~/.singularity/worktrees/singularity/logs/live-state.jsonl` is 4.2 GB with no rotation (~4 lines/s steady accumulation). Add rotation/caps to the log-channels substrate — also feeds fseventsd churn.

## Counterfactuals tested and rejected

| Hypothesis | Test | Verdict |
| --- | --- | --- |
| New code deployed 16:14 broke main | Cross-backend control + onset timing + recovery on same code | Rejected |
| Backend internally stuck (GC / hot loop) | GC counters zero; ~16% CPU while lagging; simultaneous cross-backend stall | Rejected |
| WS-cut/stale-data story coincidental | Proxy-error minutes coincide exactly with lag minutes; resubscribe cycles in live-state trace at same cadence | Supported (~75–80% — exact cut mechanism unproven, see open questions) |

## Remaining open questions

1. **~~Which timeout cuts the WS at ~10–12 s under stall?~~ ANSWERED (2026-07-08):**
   Bun's **top-level `Bun.serve` `idleTimeout`, default 10 s** — *not* the WS
   heartbeat (20 s, `runtime.ts:895` — a ping scheduler that closes nothing), the
   nested `websocket.idleTimeout` (120 s default, unset — empirically confirmed
   NOT to trip an already-upgraded WS in 10–12 s), the client (no no-ping
   watchdog; purely reactive reconnect), or the gateway (raw `io.Copy` on the WS
   relay, no deadline). Bun's docs: a connection is idle when *"no data is being
   sent or received, **including in-flight requests where your handler is still
   running but hasn't written any bytes**"* — the exact stalled-event-loop shape.
   The `reverse proxy error: EOF` lines come from `newReverseProxy`'s
   `ErrorHandler` (`gateway/worktree.go:1226`), wired to the **HTTP** path only;
   WS reconnect attempts are new HTTP upgrade requests subject to the same 10 s
   timer, so they track the same cadence. **Runtime-confirmed** with a direct
   probe on the installed Bun 1.3.13: an in-flight request on a `unix:` listener
   whose handler was pending 5 s (writing no bytes) under `idleTimeout: 2` was cut
   at **4.1 s** (Bun's idle sweep is grid-quantized ~4 s, so nominal N fires in
   ~(N, N+4] — nominal 10 s → ~10–14 s, matching the observed ~10–12 s). A
   fully-idle socket that never sends a request byte is NOT cut (the HTTP idle
   timer arms per in-flight request), so only proxied requests are affected — but
   every gateway request is exactly that. **Fixed** (see second-pass implemented
   block below).
2. **Precise onset date** — Jun 11 (`ed1c73fa9`, type-check parallel worker fleet, ~4× instantaneous CPU per run) is the best dated candidate, but surviving telemetry starts after it; a gradual ramp crossing the CPU ceiling mid-June fits equally well. Doesn't change remediation.
3. **Was every past episode this signature?** If an episode exists with an idle host, there's a second cause not covered here.

## Quick re-verification commands

```bash
# live lag now (UTC timestamps, 10 s samples)
tail -3 ~/.singularity/worktrees/singularity/logs/health.jsonl
# host pressure
uptime; sysctl vm.swapusage
# active check fleets (NOTE: the ni column does NOT indicate darwinbg — see the
# observability correction at the top; use `sudo launchctl procinfo <pid>` for truth)
ps -eo pid,ni,stat,%cpu,command | grep '[t]ype-check.*worker.ts'
# WS cuts during a burst
grep 'reverse proxy error' ~/.singularity/logs/gateway.log | tail
# definitive experiment during a burst (demotes other agents' checks — mild):
#   /usr/sbin/taskpolicy -b -p <worker pids>; main's p99 should collapse within 1–2 health samples
```

## Implemented (2026-07-08, branch `claude-web/att-1783523464-14pz`)

1. **Worker-site demotion** — `type-check/check/index.ts` now spawns every worker
   through `backgroundArgv` unless the checkout's branch is `main`
   (`workerDemotion()`), removing all reliance on session inheritance. Covers
   build-run, standalone-check, and push-run fleets, including ones launched
   from pre-Jul-7 (undemoted) agent sessions. The residual comment at
   `build.ts` (~:948) was updated accordingly.
2. **Main-only QoS boost** — `spawn-priority` exports `boostInteractiveQos()`
   (`pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE)` via bun:ffi);
   `server-core/bin/index.ts` calls it at the very top of boot, gated on
   `isMain()`. The gateway sets `SINGULARITY_WORKTREE=<name>` on every backend
   it spawns, so the gate is true only for the main backend — an agent-worktree
   backend runs the same code under its own name and never qualifies. Verified:
   FFI smoke test moved the calling thread's QoS 0x11 → 0x21
   (`qos_class_self()` readback); gate tested positive for
   `SINGULARITY_WORKTREE=singularity` and negative for an agent name / unset.
   The boost's real-world effect on main's p99 under a burst still needs an
   A/B measurement after it reaches main.

## Implemented (2026-07-08, second pass — branch `claude-web/att-1783531920-69mu`)

Companion plan: [`2026-07-08-host-saturation-remediation-PLAN.md`](./2026-07-08-host-saturation-remediation-PLAN.md).
All three below are **containment** (remove the amplifier / bound the growth), not
cures for the host saturation itself (that is the priority-isolation work above +
the still-deferred admission-control tightening).

3. **WS-cut containment — explicit `Bun.serve` `idleTimeout`** (open question 1's
   fix). `plugins/framework/plugins/server-core/bin/index.ts:230` now sets
   `idleTimeout: 60` (was Bun's 10 s default). A transient event-loop stall no
   longer drops in-flight HTTP handlers and WS-upgrade attempts at ~10 s →
   removes the reconnect/resubscribe storm (each reconnect replayed ~116 subs
   into the starved backend). A gateway-fronted unix-socket listener, so 60 s
   still reaps genuinely dead HTTP conns within a minute; the live WS stays on
   the unset 120 s `websocket.idleTimeout`. Needed a one-line `@types/bun` module
   augmentation (`bin/bun-serve-augment.d.ts`) because the type declares the
   top-level `idleTimeout` only on the TCP branch, not `unix` — the type is too
   narrow; runtime honors it on unix (proven by the probe above).
4. **Log rotation on the log-channels substrate.**
   `plugins/primitives/plugins/log-channels/server/internal/persist.ts` — every
   persisted line funnels through `appendEntry`, which had zero size management
   (`live-state.jsonl` reached ~4 GB). Now size-gated by an in-memory per-file
   byte counter (no `statSync` per append on this synchronous hot path): rotate at
   a 128 MB cap, keep 3 files named `channel.jsonl.N` (suffix after `.jsonl` so
   `listChannels`' `endsWith(".jsonl")` filter excludes them). ENOENT-tolerant,
   rethrows anything else. Hermetic `bun:test` (`persist.test.ts`, 4/4 pass).
   **Boundary invariant** (no channel grows unbounded, for any writer). The
   *origin* — the always-on live-state transition/drop tracing (`trace()` →
   `clientLog("live-state", …)`, `notifications-client.ts:24`) emitting ~4 lines/s
   at fleet scale (the high-volume per-apply line IS correctly gated behind
   `localStorage["liveState.verboseTrace"]`; the transition tier is not) — is a
   noted follow-up (rate-limit/summarize `sendSub`/`sub-ack`/`drop` per
   `replaySubs` batch), NOT addressed here; rotation is the disk-growth fix.

**Push-check latency on E-cores — measured, NO fix needed (was a remediation-list
concern).** `workerDemotion()` demotes type-check workers for any non-main branch,
which includes user-waited `push` checks. A/B (demoted vs
`SINGULARITY_NO_SPAWN_PRIORITY=1`, the built-in harness): on a **quiet host, warm
cache (the representative push case — a push always follows a build), demoted vs
undemoted is within noise (~0–9 %, ~3.1–3.5 s)** across 4+ interleaved pairs.
Runs that showed a large delta (54.7 s / 45.5 s demoted vs ~5–17 s undemoted) were
**confounded** — the demoted run happened to start mid-burst (load 14–18, 4
competing worker fleets) while its undemoted pair ran quiet; the gap is ambient
contention, not a clean demotion penalty. Conclusion: push-check latency is
acceptable; the rare burst-time slowdown is the deliberate isolation trade-off,
and undemoting push checks would re-introduce main-backend starvation from the
push's own 4-worker fleet — the exact thing the priority isolation fixes. The
lever for burst-time push latency is admission-control tightening (deferred item
4), not undemotion. No code change.

Still not done: pre-Jul-7 session sweep (item 2), admission-control tightening
(item 4), and the A/B validation of the two first-pass fixes under a live burst
(needs a saturation burst; deferred — see the plan doc's "Out of scope").

## Continuation (2026-07-09/10) — see the follow-up findings doc

Four more freezes (07-09 11:07 / 14:25 / 16:18, 07-10 03:29) were fully forensicated; the DB-layer
collapse variants were fixed on main (`fbcaec47c` interactive lane, `e24e6040a` host-wide worker
fleet — the latter closes deferred item 4, admission-control tightening, at worker granularity) and
verified at their own layer during a live freeze. The A/B question this doc deferred ("main's p99
under the next burst") is partially answered by a 9,608-sample cross-tab: **the boost holds against
pure CPU (load 24–40, no swap → 2 ms p50) — the residual lag amplifier is swap-in / memory
pressure**, which no QoS tier can absorb. Forensics + fix direction →
[`../2026-07-09-global-interactive-lane-under-load.md`](../2026-07-09-global-interactive-lane-under-load.md);
post-fix findings + open hypotheses (cold-page victim, `fseventsd` attribution) →
[`2026-07-10-host-saturation-post-fix-swap-amplifier-findings.md`](./2026-07-10-host-saturation-post-fix-swap-amplifier-findings.md).
