# 2026-07-11 slowdown: compressor thrash (not swap-in) × chronic full-sub replay storms

**Track:** [Host saturation — agent build/check fleets starve the main backend](./2026-07-08-host-saturation-agent-checks-starve-main.md) (Ongoing).
**Predecessor:** [`2026-07-10-host-saturation-post-fix-swap-amplifier-findings.md`](./2026-07-10-host-saturation-post-fix-swap-amplifier-findings.md).
**Session:** 2026-07-11 ~00:49–01:00, live during the episode (worktree `claude-1783723665`).

## Episode timeline (all times local, 2026-07-11)

| When | Event |
|---|---|
| 23:57 (07-10) | main backend boots (auto build of main). Healthy through 00:40: loop p50 1 ms. |
| ~00:30–00:43 | load 15→20; compressor 10 GB → 16–20 GB; free mem pinned ~150–280 MB. |
| ~00:43–00:52 | build bursts in ≥4 agent worktrees (`ynxe`, `qghf`, `ti28`, `u1mn`); 6 concurrent `./equin build` processes + ~12 live claude sessions; load 20→28→34→40. |
| **00:45:40** | main freezes: `flushNotifies` span of **355 s** begins; `deliver:*` spans 246–326 s; `page-load /sonata` **384 s** (00:47:38). |
| 00:49–00:51 | main loop p50 300–1,100 ms, p99 1.5–4.6 s; heap sawtooths +60–70 MB/10 s (188→608 MB, GC reclaims, re-climbs). |
| 01:00 | still degraded (p50 ~600 ms), load 37, compressor churn ongoing. |

## Finding 1 — the memory-pressure channel is the COMPRESSOR; the swap-in metric is blind to it

Measured live at 01:00 (load 37): **240,086 decompressions/s + 252,072 compressions/s**
(`vm_stat` delta over 5 s; 16 KB pages ⇒ ≈3.8 GB/s compressed AND decompressed concurrently),
while `health-host.jsonl` `swapInPagesPerSec` read **0.0–0.4 the entire episode**. Compressor
pool grew 10 GB → 22 GB in ~20 min; free memory pinned at ~200 MB of 64 GB.

Consequences for the prior session's cross-tab (§4 of the 07-10 findings doc):

- The "(load × swap-in)" dose–response used `swapInPagesPerSec` as the memory-pressure proxy.
  **That proxy misses the dominant pressure channel** — macOS compresses long before it touches
  the swapfile. The "load 24–40 with swapIn≈0 costs 2 ms" cell is NOT contradicted by this
  episode; the *interpretation* ("no swap-in ⇒ no memory amplifier") is: this episode sat in
  that exact cell (load 36–40, swapIn 0) with p50 300–1,100 ms — because the compressor column
  is missing from the table.
- The mechanism conclusion **survives and strengthens**: a page fault (decompression counts)
  blocks the QoS-boosted thread synchronously. First live corroboration of the 🔬
  cold-page-victim hypothesis: main (large churning heap — the observed ±60 MB/10 s sawtooth
  spreads its pages wide) is the ideal compression victim; at 240 k faults/s its loop runs in
  the observed 0.3–1.5 s quanta.
- **Instrumentation fix required:** `health-host` must sample `vm_stat` compressions /
  decompressions per second (and compressor pool size — it already records `compressorMb`).
  Any future dose–response must cross-tab on (load × decompressions/s).

## Finding 2 — the client replays its FULL subscription set every few minutes, even when healthy (chronic, not freeze-triggered)

`live-state.jsonl` (23:30 → 00:58, one 128 MB rotation window, 3 tabs):

- **`sendSub` 19,954 · `sub-ack` 18,009 · `drop` 65,425 · `replaySubs` 232 · `observe` only 2,057.**
  ~90 % of all subs sent are replays, not new observations.
- Replay bursts of 700–2,000 sendSubs/min recur every 2–8 minutes **during perfectly healthy
  periods** (23:30–23:57 while p50 was 1 ms: bursts at 23:30/33/36/40/42/44 — 1,960 at 23:44).
  Each `replaySubs` event resends one socket's whole sub set (observed subCount 149–244).
- Triggers (client code, `notifications-client.ts`): `ws.onopen` → `replaySubs`, and
  `probeMissedUpdates()` (61 events) → `replaySubs(stagger:false)` on the visibility watchdog.
  With 3 tabs × frequent tab switches, the "cheap self-heal" runs constantly.
- The sub set is large because two resources are keyed per-fine-grained-unit:
  **`config-v2.values` = 153 live pks (one per config FILE)** and **`page-block-doc` = 87 pks
  (one per block)**. One tab replay ≈ 250 subs.

Legitimacy (gate 2): the *watchdog* is legitimate; a full-set replay at this frequency whose
acks are ~100 % "same version" is textbook no-op work — the fix altitude is to make a replayed
sub that is already current cost ~0 (see Finding 3), and/or batch the replay into one frame.

## Finding 3 — every replayed sub runs the FULL loader behind the 6-slot `read-admit` gate; under load this is the freeze amplifier

Runtime profile of `singularity` during the episode (top entry by total contribution, ×47 the
next one):

```
sub config-v2.values   count=5,242  avg 9,822 ms  waitMs 9,820 (read-admit: 51,473,923 ms cumulative)
```

Code path (`resource-runtime/core/runtime.ts` `handleSub`): the `up-to-date` short-circuit
exists **only for resources that declare `revalidate`** (ETag). `config-v2.values` — and almost
every push-mode resource — has none, so **every replayed sub runs the loader**, and the
read-admission gate is acquired **before** the single-flight dedup (`gatedRead`: gate outside
`inflight.run`) — the exact "joiners burn read-admit slots" containment the
[read-admit wedge doc](./2026-07-10-read-admit-wedge-stuck-git-loaders.md) named and did NOT build.

Under compressor thrash the git-derived loaders (`edited-files` sub avg 4.7 s,
`commits-graph.delta`) hold the 6 slots for seconds each; the ~250-sub replays queue behind
them; **acks collapse while sends continue** (00:48–00:49: 650 sendSubs vs 19 acks/min) — the
convoy: 5,242 queued sub spans at ~9.8 s average wait.

Feedback loops observed live:

1. **Ack starvation → more replays.** Sub-acks starve ≥60 s ⇒ the WS goes silent ⇒ Bun's
   `idleTimeout: 60` (the 07-08 fix moved it 10 s→60 s — containment, not cure) cuts the
   socket ⇒ `ws.onopen` replays the full set ⇒ deeper convoy.
2. **Delivery backlog → fatter paging victim.** `flushNotifies` wedged 355 s (dominant wait:
   `background-acquire` 230 s cumulative); `deliver:*` spans 246–326 s
   (`deliver:conversations-system` 52 s **selfMs** per occurrence). Main's heap sawtooths
   +60–70 MB/10 s while wedged — more cold pages — more compressor faults on the next touch.

## Finding 4 — the server holds subscriptions for panes/tabs that no longer want them; delivery fans out to them and clients drop the frames

`/api/resources/_debug` during the episode: `config-v2.values` 153 subscriber pks,
`page-block-doc` 87 — while the 3 live tabs logged **65,425 `drop` lines in 88 min**, dominated
by `reason=no-sub` (frames delivered for keys the receiving tab holds no local sub for — e.g.
sonata keys pushed at a tab whose sonata pane closed) and `reason=stale-version`. Note the
leader-socket broadcast design means *some* no-sub drops are expected (every tab sees every
frame); the volume — with the same frame dropped 6+ times per second per tab — plus the
30 s `SUB_KEEPALIVE_MS` window and replay-reinstated refcount-0 subs, says the server-side sub
set is materially larger than what any tab is rendering. Wasted `deliver` work is on-loop work.

## Finding 5 — the exogenous rate driver: ≥6 concurrent worktree builds + ~12 claude sessions; the build-slot gate did not bound them

At 00:49: 6 live `cli/bin/index.ts build` processes (5 plain + 1 `--skip-checks`) vs the
intended `floor(cpus/4)=4` build slots — the slot is acquired mid-build around the heavy
phase (and `branch === "main"` is exempt), so 6 processes co-exist with their vite / tsc /
drizzle / bun-install phases unbounded; type-check workers were 5 ≤ 9 budget (that fix holds).
Plus `fseventsd` at 78 % CPU (still unattributed) and ~12 claude sessions at 5–35 % each.
Memory, not CPU, is what broke: each build's vite+tsc peaks ~2–4 GB; 6 at once + 12 agents +
Chrome filled 64 GB and lit the compressor.

## Causes checklist (this episode)

- ✅ **Origin (host layer): aggregate fleet memory footprint → compressor thrash** (240 k
  decompressions/s measured; swapIn≈0 the whole time). The 07-10 "(load × swap-in)" proxy is
  **blind to this channel** — instrumentation gap, not a wrong mechanism.
- ✅ **Amplifier (main's layer): chronic full-sub replay storms** (~20 k sendSubs/88 min, ~90 %
  replays, bursts of 2 k/min while healthy) **× no cached-value/ETag short-circuit for
  push-mode subs × read-admit-before-dedup** ⇒ 5,242-deep sub convoy at 9.8 s avg (gate 1
  arithmetic closes: acks 19/min vs sends 650/min during collapse).
- ✅ **WS cut → replay feedback loop**: ack starvation ≥60 s trips Bun `idleTimeout: 60` — the
  10 s→60 s change was containment; under a 355 s flush wedge it re-arms the same reconnect
  amplifier.
- ✅ flushNotifies wedged 355 s on `background-acquire`; deliver spans 246–326 s; `page-load
  /sonata` 384 s — the user-visible freeze.
- ❌ Postgres/DB layer — healthy throughout (11 idle, 0 waiting, no lock queue; plain HTTP fast).
- ❌ Deploy/restart onset — main booted 23:57, healthy 45 min before the 00:45:40 freeze.
- ❌ "Leak in main" — heap sawtooths and GC reclaims (608→256 MB); it is allocation churn from
  the wedged delivery/replay backlog, not a leak (but the churn worsens paging victimhood).
- 🔬 `fseventsd` 78–80 % CPU attribution (recurring, still open).
- 🔬 Why `probeMissedUpdates`/visibility replays fire as often as observed (61 probes/88 min,
  3 tabs) — enumerate the exact triggers before fixing the rate.
- 🔬 Build-slot gate scope: which build phases run outside the slot, and is 6-concurrent
  intended post-`e24e6040a` (worker-level budget may have made the build-level gate moot by
  design — verify before "fixing").

## 2026-07-17 recurrence (~10:00–10:30) — the landed stack partially engages; minutes-scale page loads persist because the origin is unfixed

Full-severity re-occurrence observed live (session in worktree `claude-1784290448`); the 07-11
fixes (`408837e9c`, confirmed on main) are **partially validated but insufficient**:

- **Origin identical, worse:** compressor 23.5 GB churning ~240 k compressions AND ~240 k
  decompressions/s, free mem ~155 MB / 64 GB, load 46 on 18 cores. The sentinel's
  `decompressionsPerSec` onset (fix 4 — landed) trips/clears repeatedly — the instrumentation
  works. Exogenous fill: 5 concurrent `build` + 1 `push` + 3 `check` CLI runs with type-check
  worker fleets, **78 claude processes (~7.2 GB rss)**, Chrome ~26 GB rss (86 procs), Warp
  1.4 GB; `fseventsd` again 82 % CPU (still unattributed). Fleet *memory* admission (fix 3)
  remains the unbuilt altitude.
- **Paging-victim signature now directly measurable** (the 07-16 `residentMb` instrumentation):
  main at physFootprint ~710 MB but **resident 88–140 MB** — ~80 % of its pages compressed out;
  loop p50 550–1,180 ms, p99 ~2 s.
- **Short-circuit (fix 1) ENGAGES but is structurally bypassed at minutes-scale:**
  `subShortCircuits` total 397 (327 on `config-v2.values`) — the counter works — yet the
  profiler still shows `sub config-v2.values` count 1,321 · avg 11.9 s · 98 % `read-admit` wait.
  Two bypass channels, both by design: (a) **fresh page loads / new tabs have no `(version,
  epoch)` state** — every navigation pays the full ~120-sub loader path behind the 6-slot gate;
  (b) **one mid-storm restart of main** — a build's deploy at 13:44:54 CEST produced a boot that
  **never logged `ready` (wedged ~11.5 min — main effectively DOWN 13:44→13:56)** and was
  replaced at 13:56:29; the replacement reset `bootEpoch` and cold-booted straight into peak
  thrash (duress re-tripped 53 s after ready) ⇒ cold-boot fan-out + every tab re-taking the full
  sub path. (Earlier boots 11:47/12:01 predate the duress cycling, which began 12:40 —
  trip/clear every 5–20 min until a final clear 14:28 as the build burst drained.)
- **The user-visible minutes are the delivery/flush wedge, same shape as 07-11 but larger:**
  `deliver:conversation-categories` avg **197 s** selfMs, `deliver:conversations-gone` 172 s,
  `deliver:tasks` 127 s (recentMax 350–458 s); `flushNotifies` recentMax **427 s** (was 355 s).
  A page cannot paint data until its boot-critical resources deliver ⇒ minutes per page.
- **🔬 NEW suspect, not in prior episodes:** `bg corpus-index:ensure-fresh` — **882 calls ·
  avg 85.7 s selfMs · recentMax 573 s** in a ~27-min window (~0.5 calls/s). The lazy on-read
  freshness fallback runs per read of corpus-index-backed resources; under thrash each span
  runs minutes. Rate axis unexplained (why 882 reads?) and it is not duress-shed. Needs its own
  rate×cost pass before any fix.

Verdict for the track: fixes 1/2/4/5 landed and behave as designed; the episode reproduces
anyway because **the origin (aggregate fleet memory) is untreated** — fix 3 (fleet memory
admission) is the remaining altitude, plus duress-gating for restarts-into-thrash (a deploy of
main mid-episode re-arms the cold-boot fan-out at the worst possible moment).

- **🔬 NEW (user-visible outage channel): a main deploy under duress can produce a boot that
  wedges without ever reaching `ready`** (observed: 13:44:54 start, no ready line, replaced
  13:56:29 — ~11.5 min of main down while the gateway dials a never-ready socket; page loads in
  that window hang for minutes independent of any convoy). Nothing gates a main deploy on the
  duress latch, fast-fails a wedged boot, or surfaces "boot in progress > N min" as a report
  (boot-events records the open-ended bar; no alert consumes it).

## Fix directions (altitudes labelled) — 1, 2, 5 BUILT 2026-07-11 (worktree `claude-1783723665`), awaiting live re-validation

1. **Cure, main's layer — make a replayed already-current sub cost ~0.** ✅ **Built, awaiting
   live re-validation.** The server mints a `bootEpoch` UUID and stamps it on every
   sub-ack/up-to-date; the client echoes each sub's `(version, epoch)` on replay; a same-boot,
   same-version, non-`revalidate` sub is answered `up-to-date` from the in-memory per-pk version
   counter — **no loader, no read-admit slot** (the invariant: for a non-revalidate resource the
   per-pk version counter is its complete change signal). Epoch-gated because `entry.versions`
   is per-boot in-memory state; post-restart replays take the full path and re-baseline. Per-key
   short-circuit counter in `/api/resources/_debug` (`subShortCircuits`) for re-validation.
2. **Containment, main's layer — gate-after-dedup** ✅ **Built, awaiting live re-validation:**
   the read-admission slot is acquired INSIDE the read path's single-flight, so N replays of one
   pk consume 1 slot (joiners ride the `read-coalesce` wait). Pinned by
   `runtime-gate-dedup.test.ts`.
3. **Cure, host layer — bound fleet *memory*, not just CPU/workers:** admission by predicted
   footprint (builds × phase), e.g. extend the lane-keyed flock budget with a memory share, so
   6 builds serialize into what 64 GB actually holds. (NOT built.)
4. **Instrumentation:** add compressions/decompressions per second to `health-host` sampling;
   alert/report on sustained compressor thrash (the sentinel's duress latch may want this as an
   input signal too). (Separate worktree.)
5. **Rate axis, client — replay hygiene.** ✅ **Built, awaiting live re-validation:** the replay
   is now ONE `{op:"sub-batch", tabId, epoch, complete:true}` frame per socket (the per-sub
   stagger deleted — herd control belongs to the server's read gate + dedup); the server's
   per-socket sub set is tagged per tab, `complete:true` reconciles away subs the tab no longer
   holds, and a `pagehide` listener sends a best-effort `unsub-tab` — so delivery fan-out matches
   reality (Finding 4's stale-sub leak: a closed follower tab's subs used to release only when
   the whole socket cycled).

### Two latent client bugs found while building (both fixed + pinned by tests)

- **BUG A — recovery resubs could never heal.** `handleServerMessage` adopts `entry.version =
  msg.version` BEFORE dispatching, so the delta-no-base / delta-drift recovery resubs got their
  recovery sub-ack (same server version) dropped by the `<=` version guard — the cache stayed
  broken until an unrelated version bump. Fixed structurally: `forceFullResub` clears the etag
  AND resets `version`/`lastAckVersion` to -1 before sending a version-less sub, so recovery
  never echoes state. Pinned in `notifications-subs.test.ts`.
- **BUG B — every tab join re-replayed every follower.** `onFollowerJoined` broadcasts
  `{kind:"open"}` to ALL followers (BroadcastChannel has no unicast) and the follower "open"
  handler called `dispatchOpen()` unconditionally → every existing follower ran a full
  `replaySubs` whenever ANY tab joined — a chronic replay trigger beyond the reconnect/probe
  ones named in Finding 2. Fixed: a follower already at OPEN no longer re-dispatches onopen (a
  genuine reconnect still does — the leader's "close" broadcast resets followers to CONNECTING
  first). Pinned in `shared-websocket.test.ts`.
