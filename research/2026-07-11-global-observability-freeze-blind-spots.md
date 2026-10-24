# Track O — observability/timeline blind-spot fixes

**Status:** plan (2026-07-11). **Prompted by:** structural audit of Debug → Timeline + live forensics of the 2026-07-11 03:29–03:43 freeze.
**Context docs:** [`research/perfs/CLAUDE.md`](perfs/CLAUDE.md), [`research/perfs/2026-07-11-compressor-thrash-subscription-replay-storm.md`](perfs/2026-07-11-compressor-thrash-subscription-replay-storm.md), [`research/2026-07-10-global-congestion-observability.md`](2026-07-10-global-congestion-observability.md) (the sentinel/timeline parent plan).

## Context

The Debug → Timeline is the incident-reconstruction surface, but it systematically under-reports **exactly during freezes** — the one time it matters. Forensics of today's 03:29–03:43 freeze found five failure classes, all verified against code:

1. **Sentinel crash-loop (ACTIVE BUG, 34+ h).** `readBackendP99Rollup` (`plugins/debug/plugins/sentinel/server/internal/sampler.ts:125-160`) walks `readdirSync(WORKTREES_DIR)` and stats `<name>/logs/health.jsonl`, tolerating only `ENOENT` (:141). A Finder `.DS_Store` in `~/.singularity/worktrees/` (confirmed present, dated May 22) yields `ENOTDIR`, which re-throws and kills the **whole tick** — the rollup runs on every 3rd tick (`ROLLUP_EVERY_N_TICKS = 3`, cadence 5 s ⇒ the observed ~15 s failure cadence, 1,393 consecutive). Effect: 1/3 of cluster samples lost entirely (ring + detector feed), fleet-health rollup dead 34 h. The other 2/3 of ticks succeed, which is why duress still engaged. The two sibling walks — `timeline/server/internal/log-dirs.ts:9-30` and `health-monitor/server/internal/read-health-files.ts:60-69` — already filter to directories; only the sentinel copy lacks the filter. Classic fix-the-class case: three hand-rolled copies of the same walk, one wrong.
2. **Duress latch lapses when main's loop is blocked.** Sentinel sampling AND latch renewal run on main's own event loop (`sampler.ts:205-214` setInterval; `onset.ts:31-34` calls `refreshDuress()` per tripped tick; lease `FRESHNESS_LEASE_MS = 60_000` at `duress/server/internal/latch.ts:17`). During today's freeze the latch **cleared mid-thrash** (03:34–36, decompressions ~350 k/s) because the blocked loop couldn't renew — un-gating the shed buffers, whose flush replayed buffered observability writes into the saturated host. Protection lapses precisely when needed.
3. **Compressor pressure sampled but never rendered.** `health-host` samples `compressionsPerSec`/`decompressionsPerSec`/`compressorMb` (`health-monitor/shared/schema.ts:54-65`, sampler `host-sampler.ts:36-48`) but the timeline host lane keeps only `loadAvg1` + swap (`timeline/server/internal/sources/health-map.ts:49-68`) and heat severity is load-only (`timeline/web/internal/heat.ts:36-42`). Both recent freezes had swapIn≈0 with 240 k–442 k decompressions/s — the dominant amplifier renders as "memory pressure ≈ 0".
4. **Duress shedding time-shifts the record.** Shed slow-ops are re-recorded at REPLAY time (`recentSamples` gets `atTime: new Date()` — `slow-ops/server/internal/record-slow-op.ts:118`, skew admitted at :139-141) and replayed reports bump `lastSeenAt: new Date()` (`reports/server/internal/record-report.ts:207`). The shed buffer stores raw inputs with **no timestamp field at all** (`RecordSlowOpInput`, `ReportInput`), so in-freeze events materialize on the timeline AFTER the freeze. And the duress episode itself has no timeline lane — a thinned window is invisible. (What IS persisted today: `ShedSummary.episodeSetAt` in duress-shed reports — episode start only, end implied by report time + flushDelay, and only for episodes that shed something.)
5. **Sampler gaps render as healthy.** `heatSegments` (`heat.ts:57-102`) gives each sample the span to neighbor midpoints and drops calm points — a wedged/dead sampler paints transparent, indistinguishable from healthy. Machine sleep (Jul 10 18:34–23:25: ~1,000 s gaps, huge `eventLoopMaxMs` from the histogram spanning the sleep, p50 2 ms) renders as fake incidents.

Goal: the timeline tells the truth during and after a freeze — pressure visible on the right channel, shed/thinned windows marked, events at their true times, and the duress protection itself holding while main is wedged.

## Stages

Each stage is independently landable. Stage 1 is a trivial active-bug fix — land it immediately, alone.

---

### Stage 1 — Fix the fleet walk structurally (land now)

**Plugins touched:** `infra/paths`, `debug/sentinel`, `debug/timeline`, `debug/health-monitor` (one-line call-site swaps).

- Add **`listWorktreeDirs(): string[]`** to `plugins/infra/plugins/infra/paths`'s server barrel (paths already owns `WORKTREES_DIR`): `readdirSync(WORKTREES_DIR)` with `ENOENT → []`, then keep only entries whose `statSync(join(WORKTREES_DIR, name)).isDirectory()` (tolerating `ENOENT` mid-scan for concurrent reaps) — byte-for-byte the logic already in `timeline/server/internal/log-dirs.ts:9-30`.
- Replace all three walks with it: `sentinel/server/internal/sampler.ts` `readBackendP99Rollup` (the fix), `timeline/server/internal/log-dirs.ts` (delegate or delete the local copy), `health-monitor/server/internal/read-health-files.ts:51-69`.
- Co-located bun test: temp dir with a regular file (`.DS_Store` shape), a dir, and a vanishing entry.

**Verify:** `tail ~/.singularity/worktrees/singularity/logs/sentinel.jsonl` — "tick failed: ENOTDIR" lines stop after deploy; a `cluster` trace ring sample carries a non-empty `backendP99`.

---

### Stage 2 — Timeline renders the compressor channel (with Stage 6, "timeline fidelity")

**Plugins touched:** `debug/timeline` only (the sampling side landed 2026-07-11 as fix 4 of the compressor-thrash session).

- `shared/frames.ts` `TimelineHealthPointSchema`: add optional host-lane fields `decompPerSec`, `compPerSec`, `compressorMb`.
- `server/internal/sources/health-map.ts` `hostHealthPoints`: carry the three fields through. **Downsampling must not hide the new signal:** bucket-max currently keys on `loadAvg1` alone, so a compressor spike inside a calm-load bucket would be dropped. Introduce one shared `hostPressureScore(sample)` — `max(loadRatio-normalized, decompressions-normalized)` — used as the `valueOf` for `downsampleBucketMax` AND (web-side) as the heat severity input, so the points kept are exactly the points the strip would color worst. (`cpuCount` isn't on `HostSample`; normalize load by the ramp thresholds themselves, not cpu count, or pass cpuCount forward — implementer's choice, keep the score in one exported helper with a bun test.)
- `web/internal/heat.ts` host branch: severity = max of the load ramp (unchanged) and a decompressions ramp. Proposed initial thresholds from the two forensicated freezes (healthy baseline ~0–1 k/s; freezes 240 k–442 k/s): **mild ≥ 20 k/s, strong ≥ 100 k/s, error ≥ 250 k/s**. These are educated guesses — calibrate by replaying the 2026-07-11 00:45 and 03:29 windows on the Timeline tab before freezing them (same convention as the sentinel detector defaults).
- Detail strip / tooltip: show the raw values where the host point detail renders (`web/components/detail-strip.tsx`).
- Pre-cutover JSONL lines lack the fields (schema-optional) — such points simply score on load alone; no special casing.

**Verify:** replay 2026-07-11 00:30–04:00 — the host lane must show strong/error heat across both freezes despite swap≈0.

---

### Stage 3 — Duress episodes become first-class timeline events

**Plugins touched:** `debug/sentinel` (writer + reader), `debug/timeline` (new source + band). Sequence before Stage 5 (both touch sentinel; this one is small).

- **Persist transitions as a log channel, mirroring boot-events** (no DB table, survives re-forks, readable while wedged): the sentinel — today `onset.ts`, post-Stage-5 the worker — writes one line per transition to a persisted `duress-episodes` channel on main's log dir: `{ atMs, kind: "trip" | "clear", reason, episodeSetAt }`. Written by the latch's sole writer (the sentinel), NOT inside `duress/latch.ts` — keeps the duress plugin untouched (concurrent-track conflict, see Coordination) and the writer/record adjacency exact.
- Export from the sentinel server barrel: `readDuressEpisodes(windowMs): DuressEpisodeEvent[]` (zod schema in sentinel `core/`), mirroring `readBootEvents` — bounded `readChannelEntries` tail, safeParse-drop.
- Timeline: add a 7th source `"duress"` to the closed `TIMELINE_SOURCES` list (`core/`), a disk source reading main's log dir only. Pair trip→clear lines into intervals; an unpaired trip renders open-ended to `toMs` with `detail.open` (the in-flight-builds convention, `sources/builds.ts`). A lapse-clear (lease expired, no clear line — today's 03:34 flap) has no line; post-Stage-5 the worker owns the lifecycle so lapses become rare — accept the gap, don't reconstruct.
- Rendering: duress is host-global — render as a cross-lane **incident band** (the `web/internal/bands.ts` machinery), warning-tinted, labeled with the trip reason. This is the "this window is thinned" marker: shed slow-ops/reports inside a duress band are expected to be sparse.
- Deliberately NOT built: retroactive episode reconstruction from duress-shed reports (`ShedSummary.episodeSetAt`) — only covers episodes that shed, end-time skewed by `flushDelayMs`; the forward log line is authoritative and trivial.

**Contract for parallel implementation:** the `DuressEpisodeEvent` shape above is fixed now so the timeline side (Track A) and sentinel side (Track B) can proceed independently; the timeline source lands after the sentinel export exists.

**Verify:** trip the detector synthetically (or replay: next real episode) → band appears spanning trip→clear; `bun test plugins/debug/plugins/timeline`.

---

### Stage 4 — Shed replay carries original timestamps

**Plugins touched:** `debug/slow-ops`, `reports`. Fully independent of all other stages. **Zero duress-plugin changes** (the shed buffer stays generic; the timestamp rides inside the consumer's own input type).

- **slow-ops:** `RecordSlowOpInput` gains `occurredAt?: Date`. `recordSlowOp` stamps `input.occurredAt ??= new Date()` **before** `slowOpShed.admit(input)` (:173) so the buffered item carries the true time; replay re-passes the same object. Use it for: `mergeSample`'s `atTime` (:118), the marker line's `atTime` (:282), and the upsert's `lastSeenAt` — as `sql greatest(last_seen_at, ${occurredAt})` so an out-of-order replay can never regress it. Update the :139-141 comment (the accepted skew is no longer accepted).
- **reports:** `ReportInput` (`reports/shared/types.ts`) gains `occurredAt?: number` (epoch ms). `recordReport` stamps it before `reportShed.admit` (:137); the upsert's `lastSeenAt`/`updatedAt` become `greatest(last_seen_at, occurredAt)` / unchanged-now respectively. All existing call sites need no changes (optional field).
- Timeline effect (no timeline code change): slow-op `recentSamples` intervals and report points land at their in-freeze instants.
- Tests: `mergeSample` is pure — extend its coverage with an explicit `occurredAt`; a DB-backed `recordSlowOp` replay test via `database/db-test-fixture` is optional (the shed engine's replay mechanics are already pinned in duress's own tests).

**Verify:** simulate an episode (set a latch via a test, or wait for a real one): post-flush, `slow_ops.recent_samples` timestamps fall inside the episode window, not at flush time.

---

### Stage 5 — Sentinel sampling + latch lifecycle off main's event loop (worker thread)

**Plugins touched:** `debug/sentinel` (structure change); possibly `infra/duress` (see the latch-import decision — the ONE potential conflict with the concurrent duress/cli track).

**Decision: a full Bun `Worker` owning sampler + detector + latch** — not a heartbeat-only worker, not a child process.

- *Why full worker over heartbeat-only:* the observed failure has two halves — the lapse (heartbeat fixes it) and the fact that trips + cluster samples also ride main's wedged loop (heartbeat doesn't). A freeze that begins after main is already saturated would never trip, and the cluster lane would gap exactly during the incident (Stage 6's "dark" problem, at the source). The sampler is already side-effect-contained with nullable sub-reads; nothing ties it to main's loop except history.
- *Why worker thread over child process:* the backend runs from source in dev (`gateway/worktree.go:866` spawns `bun bin/index.ts`) so a worker entry works today, and Bun's bundler statically embeds `new Worker(new URL("./x.ts", import.meta.url))` for the compiled release path — while a spawned `process.execPath script.ts` child cannot work from a compiled binary. Lifecycle is also automatic: the worker dies with the process, so the 60 s lease lapse remains the fail-safe when main dies. The host-semaphore flock scripts are NOT a compiled-release precedent.

**Layout (`plugins/debug/plugins/sentinel/server/internal/`):**

- `worker/entry.ts` — worker entrypoint. Owns `setInterval(cadenceMs)`, the detector instance (imports the pure `../detector`), and the latch lifecycle (set/refresh/clear). Lean import closure: `node:os`/`node:fs`, `../detector`, `../sample-math`, the latch API (decision below), the shared `listWorktreeDirs` (Stage 1), pg + gather modules below.
- `worker/pg.ts` — ONE dedicated raw pg client (no drizzle pool, no PgBouncer) built from the embedded-cluster connection constants (`@plugins/database/plugins/embedded/server` + worktree name from init), running the existing `PG_STATS_SQL`. Independence from main's pool is the point — sharing it re-couples the sentinel to the contention it measures.
- `worker/sample.ts` — the impure gatherers moved out of `sampler.ts` verbatim: gateway fleet fetch (2 s abort), `ps` spawn, `readBackendP99Rollup` on `listWorktreeDirs()`.
- `worker-host.ts` (main side) — spawns/supervises the worker, forwards config, receives frames. Replaces the bodies of `startSentinelSampler`/`stopSentinelSampler`.
- `onset.ts` — **gutted to a best-effort re-emitter**: on `sample` frames → `clusterClass.emit` + `onSentinelSample` listeners; on `trip` frames → `captureTrace({kind:"cluster-onset", critical: true, …})`. ALL `setDuress/refreshDuress/clearDuress` calls deleted from main. **Single latch owner = the worker**; main never touches it again.

**Protocol (discriminated `type` frames):** main→worker `init {worktree, cadenceMs, thresholds, latchDir}` · `config {thresholds}` (pushed on change via `watchConfig`; the worker cannot call `getConfig` — no plugin runtime) · `stop`. Worker→main `sample {sample}` · `trip {runUpMs, signals, elevated, wall}` · `clear` · `log {line}` (main re-publishes to the existing `sentinel` channel — single writer per channel file; the worker writes the Stage-3 `duress-episodes` lines itself only if channel-append proves worker-safe, else those also route via `log`-style frames with a dedicated type). Nothing main-side is on the latch's critical path — a wedged main only stales the thresholds (last values retained) and delays ring/trace mirroring (postMessage buffers; samples carry their own `wall`, so late delivery is harmless).

**Per-signal degradation (preserves today's nullable-sub-read contract):** pg error → null pg fields + one reconnect attempt + log frame (detector already treats null blk-delta as neither elevated nor calm-blocking, `detector.ts:49,57`; locksWaiting reads 0); gateway/ps failures → null fields (unchanged); rollup reuses last on failure; a throwing tick is caught and logged, the interval survives.

**Supervision + failure modes:**

| Scenario | Behavior | Bound |
|---|---|---|
| Worker crashes | main respawns with backoff (~1 s, capped); the new worker **adopts a fresh existing latch at init** (reads it, seeds `tripped = true`, keeps refreshing) | missed refreshes ≪ 60 s lease |
| Main's loop wedged (the observed freeze) | worker thread has its own event loop — samples, trips, **and refreshes the latch** independently | primary goal |
| Main process dies | worker dies with it | lease lapses ≤ 60 s, fleet self-recovers (unchanged design) |
| Worker thread itself starved (page-fault thrash hits all threads) | no refresh | same ≤ 60 s fail-safe; strictly better than today (tiny working set, one `utimesSync`/tick); measure before escalating to a child process |
| Wrong stuck-tripped (mis-calibrated threshold) | optional **max-episode-hold** (generous, e.g. 30 min, config'd) forces clear + re-eval; note a forced clear re-grants first-N per key on the re-trip (a small periodic persistence burst — acceptable) | config'd |
| `stop()` (shutdown) | main posts `stop`; worker clears the latch if tripped, exits; main awaits bounded then terminates | mirrors `onset.ts:70-72` |

**The latch-import decision (open question for the user):** the worker must call `setDuress/refreshDuress/clearDuress`. `latch.ts` itself is lean (node:fs + infra/paths) but it is duress-internal; deep imports are illegal (one barrel per runtime), and the duress server barrel also evaluates `shed-buffer.ts` → `config_v2/server` + runtime-profiler at module eval.
- **(i) Clean:** extract `infra/duress/plugins/latch` as a sub-plugin with its own server barrel (legal nested-barrel import); duress's shed-buffer and today's consumers (`debug/slow-ops`, `debug/trace/engine`, `reports` import `createShedBuffer`; sentinel imports the latch fns) migrate their imports; **no re-export** from the duress parent (no-proxy rule). ⚠ Conflicts with the concurrent track touching `plugins/infra/plugins/duress` — needs sequencing with that track.
- **(ii) No-restructure:** the worker imports the full `@plugins/infra/plugins/duress/server` barrel, after verifying its module-eval is safe in a bare worker (no runtime-boot dependency at import time — `getConfig`/`Log.channel` are call-time). Zero duress edits; heavier worker closure.
Recommend (i) as the end-state, (ii) as the landing path if the concurrent track makes (i) painful this week.

**Tests:** detector + latch tests unchanged (the latch seams `_setLatchDirForTests`/`_setClockForTests` must survive any move). New: `worker/sample.ts` gatherers against a temp dir; a real-Worker bun test with a test-only `{type:"__sample"}` injection seam asserting frame sequence + latch file transitions (trip → mtime advances per tick → clear unlinks); **the decisive one**: parent thread blocks itself with `Atomics.wait` for > `FRESHNESS_LEASE_MS` while the tripped worker renews → `isUnderDuress()` still true when the parent wakes — a deterministic in-process reproduction of the exact 03:34 failure.

**Verification steps before/at landing:** (1) `new Worker(new URL(...))` under the release `Bun.build --compile` path (`plugins/framework/plugins/cli/bin/commands/release.ts`) — if not embedded, fall back to heartbeat-only worker (still fixes the lapse) and file the rest; (2) raw pg client connects over the embedded Unix socket from a worker; (3) duress barrel eval-weight (option ii).

---

### Stage 6 — Sampler gaps render dark; sleep classified at the source (with Stage 2)

**Plugins touched:** `debug/health-monitor` (source-side sleep stamp), `debug/timeline` (gap rendering).

- **Source fix (health-monitor sampler):** each tick computes `wallGapMs = sampledAt − prevSampledAt`. When `wallGapMs > SLEEP_JUMP_FACTOR × cadence` (e.g. 5×), the tick's loop-lag histogram spans a suspend and is polluted (the observed huge `eventLoopMaxMs` with calm p50) — reset the histogram, and stamp the sample with optional `wallJumpMs`. Same for the host sampler. Schema: `HealthSampleSchema`/`HostSampleSchema` gain optional `wallJumpMs` (the `monitorOps` optional-cutover precedent, `shared/schema.ts:40-41`). This fixes every consumer (Health pane included), not just the timeline — the structural altitude.
- **Timeline rendering (`heat.ts` + `health-map.ts` + `frames.ts`):** carry `wallJumpMs` through `TimelineHealthPoint`. In `heatSegments`: (a) **cap each point's half-span** at `GAP_CAP_FACTOR ×` the series' median inter-sample gap (e.g. 3×) instead of stretching to the neighbor midpoint across a void; (b) render the uncovered stretch of any gap `> GAP_DARK_FACTOR ×` median (e.g. 6×) as a **dark segment** — a distinct neutral/hatched class (new `HeatSegment` kind, not a severity color) so "no data" is visually unambiguous from both "healthy" and "elevated"; (c) a point carrying `wallJumpMs` contributes NO severity (its metrics span the sleep) and classifies its preceding dark segment as `sleep` (tooltip label) vs plain `sampler dark` (wedged or dead — during a freeze, the honest answer). Pure logic, co-located bun tests (`heat.test.ts` already exists).
- Note the interlock with Stage 5: post-worker, the cluster lane keeps flowing during main freezes, so "all lanes dark + cluster alive" ⇒ freeze, "everything dark incl. host" ⇒ sleep — but don't build cross-lane inference now; the per-lane dark + sleep stamp is sufficient.

**Verify:** replay Jul 10 18:34–23:25 (sleep: dark segments labeled sleep, no fake red) and 2026-07-11 03:29–03:43 (freeze: main's lane shows dark where the sampler starved instead of transparent-healthy).

---

### Stage 7 — Small assessed items (with Stage 2/6, same track)

- **(6c) Traces enrich slack — widen.** `timeline/server/internal/sources/traces.ts:11` `ENRICH_SLACK_MS` 5 min → 30 min. Convoy-delayed persists (enrich queues behind a saturated host) exceed 5 min; the slack is only a coarse SQL pre-filter on indexed `created_at` — `map()` still does the exact wall-clock overlap check (:65), so the cost is a few more rows read and discarded. One-line change.
- **(6b) Boot lane: wedged-mid-boot visibility — build it.** `writeBootEvent` runs only in `onReady` (`boot-events/server/internal/write-boot-event.ts`), so a backend that wedges during migrations/boot is invisible exactly during deploy-restart bursts. Add a `phase: "start"` line written as early as the plugin system allows (module-eval/registration of the boot-events server plugin, before `onReadyBlocking` work), and keep the existing ready line (gains `phase: "ready"`, both optional-discriminated so old lines parse). `readBootEvents` pairs by `processStartedAt`; an unpaired start renders open-ended to `toMs` (the in-flight-build convention) — "a backend tried to boot here and never became ready". Touches `boot-events` (schema/write/read) + `timeline` `sources/boot-map.ts` (+tests).

### Cut items (with justification)

- **(6a) Live-state log channel as a timeline lane — cut for now.** The channel's volume is disqualifying for the fan-out-on-demand model: 65,425 drop lines + ~20 k sendSubs in 88 min, a full 128 MB rotation window in that period (compressor-thrash doc, Finding 2) — the timeline endpoint opens *during* incidents and would tail-parse hundreds of MB across worktrees. The amplifier is also being cured at the source this week (bootEpoch short-circuit, gate-after-dedup, sub-batch replay — landed, awaiting re-validation), and the signal is partially covered already: live-state-churn monitor files reports (a timeline source), and Debug → Live-State Health exists for live inspection. Revisit only if post-cure storms persist — then as pre-aggregated per-minute counters written to a slim side channel, never raw-line ingestion.
- **Shed-buffer cap raising / per-key summarization — cut.** The dropped counts already survive per cascade key in the duress-shed accounting (truth about the loss is preserved); first-N keeps the onset evidence; Stage 4 makes what IS replayed truthful in time. Raising caps buys memory pressure at the worst moment for the tail with the least marginal value (overflow drops newest by design). Per-key aggregation would change the generic shed contract — and `infra/duress` is being touched by a concurrent track. Revisit if episodes still drop at the 16 k scale after Stage 5 + the replay-storm cures land.
- **Retroactive duress-episode reconstruction from duress-shed reports — cut** (folded into Stage 3's rationale: forward log line is authoritative and trivial).

## Implementation partitioning (file-conflict-free tracks)

| Track | Stages | Plugins | Depends on |
|---|---|---|---|
| **Land first, alone** | 1 | `infra/paths`, tiny touches in `debug/sentinel`, `debug/timeline`, `debug/health-monitor` | — |
| **A — timeline fidelity** | 2 + 6 + 7 | `debug/timeline`, `debug/health-monitor`, `debug/boot-events` | Stage 1 landed; Stage 3's `readDuressEpisodes` export for the duress source (land that source cell last) |
| **B — sentinel resilience** | 3 then 5 | `debug/sentinel` (+ `infra/duress` ONLY if latch option (i)) | Stage 1 landed |
| **C — replay timestamps** | 4 | `debug/slow-ops`, `reports` | none |

⚠ **Coordination:** another track is concurrently touching `plugins/infra/plugins/duress` and `cli/bin`. This plan touches **neither**, except Stage 5's latch option (i) (sub-plugin extraction) — sequence that with the other track or take option (ii). Stage 3's episode lines are deliberately written from the sentinel, not the latch, for this reason.

## Open questions

1. **Stage 5 latch import:** extract `infra/duress/plugins/latch` (clean, conflicts with the concurrent duress track) vs import the full duress server barrel in the worker (needs an eval-weight check)? Recommend (i) with sequencing; need the user's call given the other track's timeline.
2. **Compressor heat thresholds** (20 k / 100 k / 250 k decompressions/s) — accept as calibratable defaults, or hold Stage 2 until a replay-calibration pass?
3. **Max-episode-hold** in the worker (default 30 min) — include, or omit and rely on the lease + detector clear?
4. Confirm the two cuts (live-state lane; shed-cap changes).

## Verification (end-to-end)

1. `./equin build` per stage; `./equin check` (type-check picks up the schema changes).
2. Unit: `bun test plugins/debug/plugins/timeline`, `bun test plugins/debug/plugins/sentinel`, `bun test plugins/infra/plugins/duress` (latch seams intact), the new `Atomics.wait` latch-hold test.
3. Live replays on Debug → Slow Events → Timeline: **2026-07-11 00:30–04:00** (host lane red on compressor during both freezes despite swapIn≈0; duress band 03:29→; slow-op/report events inside the freeze window post-Stage-4 episodes) and **2026-07-10 18:00–24:00** (sleep gaps dark + labeled, no fake incidents).
4. Sentinel health: `sentinel.jsonl` free of tick failures; `backendP99` populated; after Stage 5, a synthetic main-loop block (test) can no longer lapse a tripped latch.
