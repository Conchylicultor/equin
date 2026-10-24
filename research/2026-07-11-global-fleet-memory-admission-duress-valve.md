# Fleet memory admission + duress-aware admission valve — design

**Status:** plan (Track 1 of the 2026-07-11 compressor-thrash remediation; fix direction 3 from
[`research/perfs/2026-07-11-compressor-thrash-subscription-replay-storm.md`](./perfs/2026-07-11-compressor-thrash-subscription-replay-storm.md), deliberately deferred until the CPU-axis gates were verified holding).

## Context

Two full app freezes on 2026-07-11 (00:45–01:00, 03:29–03:44) were caused at origin by macOS
**compressor thrash**: the agent fleet's aggregate memory footprint fills the 64 GB host
(measured 240k–442k decompressions/s, compressor pool to 30.6 GB, free mem pinned ~200 MB), and
the main backend — the host's ideal paging victim — freezes (loop p50 1.3–5.1 s, page loads
64–1,016 s) while Postgres stays healthy. Every CPU-axis gate was verified holding during the
03:29 freeze (type-check worker budget `e24e6040a` 5 ≤ 9; interactive DB lane `fbcaec47c`; QoS
boost; sub-convoy fixes `408837e9c`). **The binding constraint is now memory, and nothing admits
work by memory footprint.**

Verified gap (code, this session):

- The build slot gate (`withHostSlot` in `plugins/framework/plugins/cli/bin/host-semaphore.ts`,
  `floor(cpus/4)` = 4 slots) wraps **only** the checks+tsc+vite parallel section
  (`build.ts:1001–1119`). Ungated phases run outside any slot: `bun install` (build.ts:858),
  registry + manifest codegen, drizzle migration generation (build.ts:928), atomic publish,
  backend restart + health probe (build.ts:1296+). That is why 6+ concurrent
  `./equin build` processes co-exist with a 4-slot pool.
- Main-branch builds are fully exempt (`build.ts:978`); main's own 27-minute auto-build
  (03:21–03:48) spanned the whole second freeze.
- The compressor pressure is now measured (`health-monitor` host sampler,
  `plugins/debug/plugins/health-monitor/server/internal/host-sampler.ts`:
  `compressionsPerSec` / `decompressionsPerSec` / `compressorMb`, 10 s cadence,
  `health-host.jsonl`), but nothing consumes it for control.
- The duress latch (`plugins/infra/plugins/duress`, `~/.singularity/duress.latch`,
  mtime-leased 60 s, cheap synchronous `isUnderDuress()`) and its writer — the sentinel onset
  detector (`plugins/debug/plugins/sentinel/server/internal/{detector,onset}.ts`, dual-threshold
  dual-dwell hysteresis) — already exist. The detector's signals are load ratio, pg locks,
  blk-read delta, slow backends; **no memory signal**.

### Answer to the open checklist item (build-slot gate scope / "is 6-concurrent intended?")

Not intended, and not a bug in the gate either: the slot is *scoped to the heavy section by
design*, acquired mid-build, and main is exempt — so N processes legitimately co-exist with 4
slots; only their heavy sections are serialized. Post-`e24e6040a` the worker budget bounds the
**tsc fleet only**; vite (~2–4 GB per build), bun install, drizzle, and the server
compile/restart phases remain unbounded per-process. The build-level gate is therefore **not
moot** — but its unit of admission (a CPU-sized heavy-section slot) no longer matches the
binding constraint (whole-process memory footprint). This plan changes the unit.

## Design overview — two coupled pieces

| Piece | What | Altitude (perfs method) |
|---|---|---|
| 1. Fleet memory admission | One build = one admission token, held for the **whole build**; pool sized `min(CPU term, memory term)`; main's exemption becomes a **statically reserved share** | **Cure** at the admission layer — removes the class "heavy work is admitted with no memory accounting" |
| 2. Duress-aware admission valve | While the host is under duress (now including sustained compressor thrash), **stop admitting** new background heavy work; running work untouched | **Containment / backstop** — reactive; catches whatever the static budget mispredicts (Chrome, claude sessions, estimate drift) |

Both pieces extend existing precedents (host-semaphore flock pools, the lane classification, the
sentinel→duress latch pipeline). No new bespoke mechanism.

## Piece 1 — fleet memory admission

### D1. Admission unit: the whole build, not per-phase weighted shares

The build pool slot's scope extends from the current heavy-section wrapper to the **entire
build**: acquired right after the per-worktree build lock (before `bun install`), released in a
`finally` after the backend restart + health probe. One slot = one build = one budgeted peak
footprint (`BUILD_PEAK`).

Rejected alternative — a weighted quantum pool (`acquireUnits({min,max})` on a 1 GiB-slot pool,
per-phase weights):

- It needs a new primitive semantic (all-or-nothing multi-slot accumulation). That introduces
  **hold-and-wait deadlock shapes**: builds holding "section units" while their tsc workers wait
  for "worker units" from the same pool is a textbook circular wait; avoiding it forces either
  up-front worst-case reservation (≈ the whole-build token anyway) or careful lock-ordering
  rules across nested acquisitions.
- The existing `acquireShare(max)` semantics ("at least 1, greedily up to max") are right for
  elastic worker fan-out but wrong for footprint admission — a 3 GB phase granted 1 GB of slots
  still uses 3 GB.
- Per-phase weights would rest on per-phase estimates we don't have (see D4); the whole-build
  token needs exactly one constant.
- The whole-build token mirrors the working precedent byte-for-byte in shape: the type-check
  budget is already "per-unit footprint constant → pool size, min'd with a CPU term"
  (`type-check/check/index.ts:158–163`).

Accepted trade: the token is held across cheap/wait phases (waitForPg, waitForDatabase, publish),
so throughput under contention drops. That is the point — admission control, not scheduling. The
pathological case (token held while a first-build DB fork queues) is rare and arguably correct:
the fork's `pg_restore` is itself heavy work on this worktree's behalf.

### D2. Pool size: `min(CPU, memory)`; main's exemption → static reserved share

In `bin/host-semaphore.ts` (the stated policy file), the build pool becomes:

```ts
const BUILD_PEAK_BYTES = 4 * 2 ** 30;        // one agent build's non-tsc-worker peak (vite + orchestrator + drizzle); calibrated, see D4
const MAIN_RESERVE_BYTES = BUILD_PEAK_BYTES; // main may always be building; budget as if it is
const HEAVY_NONWORKER_FRACTION = 0.25;       // share of RAM for build tokens (tsc workers have their own landed budget)

function buildSlotCount(): number {
  const memBudget = totalmem() * HEAVY_NONWORKER_FRACTION - MAIN_RESERVE_BYTES;
  return Math.max(1, Math.min(
    Math.floor(cpus().length / 4),
    Math.floor(memBudget / BUILD_PEAK_BYTES),
  ));
}
```

On the 18-CPU / 64 GB host: `min(4, floor((16 − 4) / 4)) = 3` agent build tokens.

This satisfies the primitive's hard constraint (size must be a pure function of stable host
facts, identical in every process — `host-semaphore.ts:15–24`; `os.totalmem()` is already relied
on for this by the type-check budget). The size sentinel handles the 4→3 slot-file transition:
idle pool → silent resize; live pool at the old size → loud throw (land during a quiet window,
or on first conflict simply retry after in-flight builds drain).

**Main stays never-queued but no longer unaccounted.** Main (and push) keep `exempt` — a human
is blocked, and queueing main behind agents is a regression we refuse. Instead main's footprint
is **statically reserved**: `MAIN_RESERVE_BYTES` is subtracted from the budget before sizing the
agent pool, i.e. the agent pool is sized as if main is always building. Main builds are already
serialized among themselves by the per-worktree `.build.lock`, so one reserve suffices.

Rejected alternative — main takes a slot from a reserved index sub-range of the pool: it makes
main *waitable* (even briefly, on flock mechanics), complicates the primitive's sweep logic, and
buys nothing over static reservation, since reservation-by-subtraction already makes agents pay
for main's worst case.

### D3. Budget arithmetic (stated honestly, with the known residual)

Worst-case *gated* footprint after this change:

```
3 agent tokens × 4 GB      = 12 GB
main reserve               =  4 GB
tsc background lane (9 × 2.7 GB, unchanged, landed & verified) = 24.3 GB
                    total ≈ 40.3 GB of 64 GB
```

Residual, accepted and named: (a) the **interactive tsc lane** can add another 24.3 GB while a
main build/push runs its checks — partially overlapping the main reserve window; (b) claude
sessions (~12 × 0.5–2 GB), Chrome, and backends are ungated by design. So the static budget alone
cannot guarantee no thrash — **Piece 2 is the backstop for exactly this**. We deliberately do
NOT touch the type-check budget in v1 (it landed 2026-07-10 and was verified holding during the
03:29 freeze; re-tuning a verified fix without fresh data violates the perfs method).

### D4. Footprint estimates: measure continuously, declare centrally

The 2–4 GB vite/tsc peak figures in the docs are claims. Rather than inherit them:

- **Instrumentation (cheap, ships with this change):** `exec` / `execBuffered`
  (`build.ts:208`) capture `Bun.Subprocess.resourceUsage().maxRSS` after each child exits and
  record it on the build-profiler span (+ one build.log line, e.g.
  `vite build: maxRSS 2.9 GB`). Every real build then contributes per-phase peak data to the
  existing Gantt/profiling surfaces; drift from the declared constant becomes visible.
- **Calibration:** after landing, read the maxRSS lines from ~10 real agent builds and one main
  build; set `BUILD_PEAK_BYTES` / `MAIN_RESERVE_BYTES` from the observed p95 concurrent peak
  (heavy section = vite + orchestrator; tsc workers are excluded — they carry their own budget).
  Record the numbers in the perfs issue doc. Initial constants above are educated guesses,
  clearly marked as such in code comments.

In-process phases (codegen) aren't covered by subprocess rusage; they are not the heavy term and
are visible indirectly via the orchestrator's own footprint if ever needed.

### D5. Interaction with existing gates (deadlock analysis)

Per-process acquisition order, globally consistent:

```
.build.lock (per-worktree) → [valve wait] → build token (host flock) → … → type-check worker share (host flock, separate pool) → release all
```

- Token holders may wait for worker slots; worker-slot holders are leaves (never wait for
  tokens). Build-lock holders wait for tokens; token holders never wait for another worktree's
  build lock. The cross-pool wait-for graph is acyclic.
- The `worktree-mutate` gate (`infra/worktree/server/internal/mutate-gate.ts`) shares no
  resource with builds — builds never acquire it. No interaction beyond sharing the host.
- flock auto-releases on process death, so every `process.exit(1)` path in `failBuild` and a
  SIGKILLed agent build release the token — same crash-safety as today.
- `push` is unchanged (its own size-1 pool + interactive lane). Standalone
  `./equin check` remains outside the token in v1 (its tsc fleet is budgeted; its
  eslint/import-graph residual is modest) — follow-up if the maxRSS data says otherwise.

## Piece 2 — duress-aware admission valve

### D6. Pressure source: compressor thrash becomes a sentinel onset signal (the existing latch, not a sibling)

- **Sample plumbing:** the sentinel sampler (`sentinel/server/internal/sampler.ts`) reads the
  latest `health-host.jsonl` line per tick (it already imports
  `log-channels.readChannelEntries` and tail-scans `health.jsonl`; mirror that), guarded by a
  30 s freshness window (3× the host sampler's 10 s cadence). `ClusterSample` (sentinel `core`)
  gains nullable `decompressionsPerSec` / `compressorMb` / `freeMemMb` fields. Rejected: a
  second `vm_stat` spawn in the sentinel — the sentinel doc explicitly avoids duplicating the
  host sampler.
- **Detector:** `signalsAt` (`detector.ts`) gains one signal: `decompressionsPerSec ≥
  onDecompressionsPerSec` (config default **50,000/s** — measured freezes ran 240k–442k/s,
  healthy baseline ≈0; benign compression bursts are a few k/s). A stale/null reading is
  neither elevated nor calm-blocking — exactly the existing null-blk-read convention.
  **Hysteresis needs no new mechanism**: the detector's dual-threshold (`offRatio`) dual-dwell
  (`onTicks`/`offTicks`) machinery applies to the new signal like every other.
- **One latch, one semantic.** Compressor thrash trips the *existing* duress latch
  (`setDuress("cluster-onset: decompressionsPerSec")` via the unchanged onset wiring). Rejected:
  a sibling "memory duress" latch — it would need its own writer lifecycle, lease, and
  hysteresis config, and the admission valve would want the union anyway: *any* duress (pg
  pressure, load, memory) means "do not add heavy work now". The latch payload's `reason`
  already tells consumers which signal tripped.

### D7. The valve: hold background admissions while latched

New module `plugins/framework/plugins/cli/bin/admission-valve.ts`:

- `awaitAdmission(lane)`: returns immediately for the interactive lane. For background: while
  `isUnderDuress()` (imported from `@plugins/infra/plugins/duress/server` — CLI bin already
  imports server barrels; the read is one memoized `statSync`), print **one loud line per
  episode**:
  `build admission held: host under duress (<reason from readDuress()>) — waiting for clear`,
  open a `duressHold` build-profiler span (category `build:queue`, beside the existing
  `buildSlotWait`), and wait.
- **Waiting without polling:** wakeups are event-driven — `fs.watch` on `~/.singularity/`
  scoped to the latch filename (`LATCH_FILENAME`; catches unlink *and* mtime refresh) **plus**
  one computed deadline timer at `latch mtime + FRESHNESS_LEASE_MS + ε` (the lease guarantees a
  stale latch self-clears within 60 s, so the deadline is a real wake condition, not a poll).
  Recheck on every wake; a refresh advances the deadline.
- **Integration in `build.ts`:** the token acquisition becomes a small loop —
  `await awaitAdmission(lane); acquire token; if (isUnderDuress()) { release; continue; }` —
  so a build that sat in the flock queue while duress tripped does not start into the storm
  (there is no FIFO to lose; barging is already documented behavior of the primitive).
- **Only admission stops.** Already-admitted builds run to completion untouched. Because the
  token now spans the whole build, there are no per-phase valve points to design — one valve at
  one admission point, by construction.
- Scope v1: agent builds only (the background lane). Push, main builds, and the main detached
  auto-build (`SINGULARITY_BUILD_DETACHED`, spawned by `plugins/build/server/internal/run-build.ts`)
  pass the valve — open question 1 below.

Mechanical note: `withHostSlot`'s closure shape doesn't fit a whole-command span cleanly; add
`acquireHostSlot(kind, hooks): Promise<{ release(): void }>` to `bin/host-semaphore.ts` (a thin
wrapper over the primitive's existing `acquireShare(1)`), keep `withHostSlot` for `push`.

## Implementation scope

**Piece 1 (~1 day):**

1. `plugins/framework/plugins/cli/bin/host-semaphore.ts` — memory-aware `buildSlotCount()`,
   the three constants, `acquireHostSlot()` handle API.
2. `plugins/framework/plugins/cli/bin/commands/build.ts` — move acquisition to just before
   `bun install` (after the build lock + sweep), release in `finally` after the health probe;
   delete the heavy-section wrapper (keep the wait-log hooks + `buildSlotWait` span);
   maxRSS capture in `exec`/`execBuffered` → profiler span + build.log line.

**Piece 2 (~1 day):**

3. `plugins/debug/plugins/sentinel/core/` — `ClusterSample` compressor fields +
   `onDecompressionsPerSec` config field (default 50,000).
4. `plugins/debug/plugins/sentinel/server/internal/sampler.ts` — health-host.jsonl tail read
   with freshness guard; `detector.ts` — the new signal in `signalsAt` (+ its pure test).
5. New `plugins/framework/plugins/cli/bin/admission-valve.ts` (+ bun test with injected
   `isUnderDuress`/watch/clock deps); wire into `build.ts` acquisition loop.

**After landing:** calibrate `BUILD_PEAK_BYTES`/`MAIN_RESERVE_BYTES` from real maxRSS lines;
update `research/perfs/CLAUDE.md` index + the compressor-thrash issue doc (fix 3 status) in the
same turn as landing, per the perfs living-doc rule.

## Verification

- **Unit:** detector test extends the existing pure state-machine suite (trip/clear on the
  compressor signal, null-stale handling). Valve test drives the wait loop against injected
  deps. Host-semaphore behavior unchanged (existing tests).
- **Admission bound (live):** launch 5–6 agent builds across scratch worktrees; from the
  `build admitted` marker timestamps in build.log + `ps`, assert ≤ 3 concurrently-admitted
  agent builds end-to-end (not just heavy sections). This is the direct re-test of the
  "6 concurrent" finding.
- **Valve drill (live):** set the latch manually (`bun -e` script calling `setDuress` from the
  main worktree), start an agent build → observe the hold line + `duressHold` span; then
  `clearDuress()` → build proceeds within seconds. Kill the writer instead of clearing →
  build proceeds within `FRESHNESS_LEASE_MS` (lease-lapse path).
- **Signal (live):** during the next natural memory burst, the sentinel channel logs
  `onset TRIP (decompressionsPerSec…)`, the timeline shows builds' `duressHold` spans inside
  the duress window, and — the actual acceptance property — main's loop p50 stays bounded
  because no *new* builds were admitted into the thrash. Re-validate on `singularity` data
  before marking anything Completed (perfs rule).

## Open questions (user's call)

1. **Main's detached auto-build vs the valve.** v1 exempts it (interactive lane; merge-deploy
   latency is human-relevant, and the static reserve covers its footprint). But today's
   27-minute main build *spanned* a freeze. Should the valve hold the **detached auto-build
   only** (distinguishable via `SINGULARITY_BUILD_DETACHED`) while letting manual main builds
   through? Recommendation: keep v1 exempt, revisit with post-landing episode data.
2. **Throughput trade.** Agent build concurrency drops 4 → 3 *and* tokens are held whole-build
   (roughly halving effective concurrent-build throughput under contention). Accept? The
   constants are one-line tunable after calibration.
3. **Trip threshold default** 50,000 decompressions/s (with existing dwell/offRatio hysteresis)
   — calibrate against the replayed 07-11 episodes on the Timeline tab, same convention as the
   other sentinel thresholds?
