# 2026-07-16 — Main backend is the host's paging victim: confirm the mechanism, then fix the axes

**Track:** [Host saturation — agent build/check fleets starve the main backend](./2026-07-08-host-saturation-agent-checks-starve-main.md) (Ongoing).
**Predecessors:** [`2026-07-10-host-saturation-post-fix-swap-amplifier-findings.md`](./2026-07-10-host-saturation-post-fix-swap-amplifier-findings.md) (§5 designed the discriminators; never run), [`2026-07-11-compressor-thrash-subscription-replay-storm.md`](./2026-07-11-compressor-thrash-subscription-replay-storm.md) (first live corroboration of the cold-page-victim hypothesis).

## Context

During host memory pressure (compressor thrash: 240k–442k decompressions/s measured live in the 07-11 00:45 and 07-10 03:29 freezes), the main backend's event loop degrades to 0.3–5 s quanta and the app freezes for minutes (page loads 64–1,016 s) — while **every other app on the machine stays responsive**. The suspected victim profile: (a) a large cold heap that macOS preferentially compresses, (b) ±60–70 MB/10 s allocation churn on the delivery/flush path that turns compressed pages into fault storms, (c) a single event loop where one page fault blocks everything, (d) hop-count × lag-quantum amplification.

The mechanism has been corroborated live twice but **never confirmed by the designed discriminator experiments** (twin-probe, cold-switch — §5 of the 07-10 findings doc, still unrun as of today). Per the perfs-investigation methodology, this plan builds the confirmation harness first, then lands fixes per axis, each gated on its confirmation verdict.

### Where the prior stack stands (audited 2026-07-16; worktree merge-base = today's main)

- **Landed:** replay-storm fixes (`408837e9c`: bootEpoch sub short-circuit, gate-after-dedup, sub-batch replay), health-host compressor sampling (same commit), sentinel on a dedicated Worker + duress latch + duress-episodes channel + timeline compressor heat (`7ebe610f3`), duress admission valve for background builds (`cli/bin/admission-valve.ts`), host-admission **memory measurement** Stage 1 (`4fd40fe48` — measure-only; one cold build ≈ 28 GB ≈ 80 % of the RAM ceiling).
- **Open:** host-admission memory **enforcement** (Stage 2 — explicitly gated on a user throughput-trade decision; **out of scope here**, this plan is main's-layer victimhood); live re-validation of the 07-11 stack (no freeze episode documented since); the discriminators.
- **Live evidence today (quiet host):** main backend at **865 MB RSS 38 min after boot**; an idle 11-hour backend squeezed to 90 MB resident — the victim shape is visible even without a freeze.

### Memory anatomy (code-confirmed 2026-07-16)

- **No general resident value map** in the live-state runtime; push/invalidate values are function-local. But **keyed resources retain `entry.snapshots: Map<pk, Map<id, string>>` where each string is the row's FULL canonical JSON** (`keyed-diff.ts` — the "hash" is `JSON.stringify(row)`, UTF-16 ⇒ ~2 B/char), per actively-subscribed pk; evicted on N→0 **except persisted `scopedMembership` resources, kept forever** (`runtime.ts:2987-2991`) — and that class's persist path reconstructs the full value by `JSON.parse` of every stored string (`runtime.ts:2189-2194`).
- **Churn sites** (one drainEntry cycle = 3+ independent full-value serializations): `sendJson` stringifies the same frame **per subscriber** (`runtime.ts:1700-1707`; loops at 1382/2081/2220/2404/2433); `diffKeyedFull` re-stringifies **every row** and reallocates the whole snapshot Map per recompute (`keyed-diff.ts:62-95`); `persistSnapshot` stringifies the full value again (`live-state-snapshot/server/internal/persist.ts:94`).
- **Cold-heap candidate #1: the `stats/cost` usage corpus-index** — indexes every Claude transcript on the machine (unbounded), and `ensureFresh()` loads it into **every worktree backend's** heap (only persistence is `isMain()`-gated; `corpus-index.ts:328,349,354-361`). Others (log-channel rings, plugin-tree memos) are bounded/moderate; the 10.6 MB FS snapshot is transient.

## Decision points (defaults chosen; flag if you want otherwise)

1. **Twin probes are config-gated, default OFF.** Armed for controlled experiments; you may leave them enabled to catch organic freezes (fat probes ≈ 800 MB nominal, mostly compressor-resident when cold — being compressed is the phenomenon under test).
2. **The controlled-pressure run (A4) requires a fresh go-ahead** in the session that executes it — it deliberately makes the machine sluggish for ~10–20 min.
3. **Sequencing:** instrumentation (Phase A) lands first; Phase B fixes are built next but each is *independently justified waste-removal* — confirmation verdicts set priority and validate impact. B2 (serialize-once) may land before confirmation; B1/B4 wait for the A3/A4 numbers.

---

## Phase A — measurement & discriminator harness

### A2 — the per-backend "squeezed-out" metric (land first, smallest)

**⚠ Correction to the naive design:** `process.memoryUsage().rss` **over-counts phys_footprint ~6×** on macOS (Gigacage virtual reservation etc.) — documented in `server-core/core/phys-footprint.ts:3-8`; an `rssMb` field was already removed from the health schema once for this reason. The correct "physically in RAM right now" number is mach **`ri_resident_size`** (offset 64 of the same `proc_pid_rusage(RUSAGE_INFO_V0)` buffer the existing FFI already fills and discards). `phys_footprint` (offset 72) *includes* compressed private pages, so:

> **squeezedOutMb ≈ physFootprintMb − residentMb** — the direct per-backend victimhood time series.

- `plugins/framework/plugins/server-core/core/phys-footprint.ts` — extend to `procMemory(): { physFootprintBytes, residentSizeBytes }` (one syscall, both offsets); keep `physFootprintBytes()` as a wrapper. Export via `core/index.ts`.
- `plugins/debug/plugins/health-monitor/server/internal/process-sampler.ts` — add `residentMb` to the sample.
- `plugins/debug/plugins/health-monitor/shared/schema.ts` — `residentMb: z.number().optional()` (mirror the `wallJumpMs` optional precedent so old JSONL lines still parse).
- Health-pane chart: add a derived "squeezed-out" line only if the chart tolerates `undefined`; otherwise compute in the endpoint. The JSONL series alone satisfies A4 — don't force a required schema field.
- Fallback if the proxy proves noisy: `task_vm_info.compressed` (a second, self-only `task_info` call) is the definitive per-task compressed byte count — noted, not built.

**Verify:** health endpoint shows `residentMb ≤ physFootprintMb`; delta grows under pressure; old lines still parse.

### A1 — twin-probe harness: new debug sub-plugin `plugins/debug/plugins/paging-probe/`

Three probe **variants** (one `bin/probe.ts` entry, variant via argv), spawned as **separate child processes** (a Worker would share main's address space/footprint ledger — not an independent victim):

| Variant | Heap | Behavior | Discriminates |
|---|---|---|---|
| `lean` | ~5 MB | lag loop only | scheduling floor (all slow ⇒ CPU, not paging) |
| `fat-idle` | ~400 MB mixed-entropy, touched once at boot, then never | lag loop only | mere residency vs touch |
| `fat-touch` | ~400 MB | each 10 s tick touches a random ~25 MB slice + times it; timed `Bun.gc(true)` each minute | fault-storm on touch; **GC-over-cold-heap** (the suspected main mechanism: GC marking walks cold pages) |

Design rules:

- **Main-only, config-gated OFF by default**, supervised from `server/index.ts` `onReady` (`isMain() && !isRelease() && config.enabled`), respawn with capped backoff mirroring `sentinel/server/internal/worker-host.ts` byte-for-byte in shape; torn down in `onShutdown`.
- **Default QoS, not darwinbg, not boosted** — the fair twin is "a normal app" (the symptom is normal apps staying responsive). Optional `boostQos` config for a boosted second axis.
- **Lean closure is load-bearing:** `bin/probe.ts` imports only `node:perf_hooks`/`node:fs`/`node:crypto` + a copied (not imported) `ri_*` FFI snippet; writes JSONL directly via `appendFileSync` to `~/.singularity/worktrees/singularity/logs/paging-probe-<variant>.jsonl`. Importing the plugin runtime or `Log.channel` would bloat the lean probe's own heap and destroy the measurement.
- **Sample schema** (`core/schema.ts`, zod, optional-tolerant): `{ sampledAt, variant, tickIndex, eventLoopP50Ms, eventLoopP99Ms, eventLoopMaxMs, lateByMs, physFootprintMb, residentMb, touchMs?, touchBytes?, gcMs? }`. **`lateByMs`** (actual − expected tick time) is the headline: a tick 3 s late means the probe itself was frozen 3 s — a fair twin to main's stall.
- **Data join:** timestamp-window join against `health.jsonl`, `health-host.jsonl` (`decompressionsPerSec`, `compressorMb`), and `duress-episodes` — no new join infra.
- **Config** (`core/config.ts`, mirror `sentinel/core/config.ts`): `enabled` (default false), `fatSizeMb` (400), `touchSliceMb` (25), `gcEachMinute` (true), `boostQos` (false). Web-side registration in `web/index.ts` (config only, no pane).
- Files: `package.json`, `core/{config,schema,index}.ts`, `bin/probe.ts`, `server/index.ts`, `server/internal/probe-host.ts`, `web/index.ts`, `CLAUDE.md`; tests: `core/schema.test.ts` + a pure touch/timing helper with co-located `bun:test`.

**Verify:** enable, rebuild — three JSONL files grow; lean footprint ~5 MB, fat ~400 MB; `lateByMs ≈ 0` at idle.

### A3 — heap-attribution protocol (manual, quiet box; no code)

Attribute main's ~865 MB before choosing between B1 and B4 priority:

1. `GET /api/debug/heap-stats` ×3 over 10 min (object-type histogram + footprint; separates standing from transient).
2. One `POST /api/debug/heap-snapshot` (blocks the loop for seconds — manual, quiet moment), analyze offline in Chrome DevTools.
3. Attribute to buckets: keyed-snapshot string Maps (retainers under `createResourceRuntime`), corpus-index `CorpusFile` (`FilePartial[]` + `dayBuckets`), log-channel rings, plugin-tree memos, other.
4. Record exact numbers per bucket **in this doc**.

### A4 — controlled-pressure experiment (run only on fresh go-ahead)

1. Quiet box; baseline `health-host.jsonl` compressor ≈ 0; arm probes; 10 min baseline.
2. **Induce pressure:** primary — a calibrated standalone bun allocator (mixed-entropy pages, ramp-controlled, no sudo; essentially `fat-touch` cranked). Cross-check — `memory_pressure -S -l critical` (**verify sudo requirement before relying on it**).
3. Drive a scripted page-load loop against main (`e2e/screenshot.mjs` or curl loop) to keep the delivery/flush path hot.
4. Record start/stop wall times here; abort switch = kill the allocator.

**Confirmation criteria (gate every Phase B fix):**

- **(a) cold-RSS victimhood — CONFIRMED** if `fat-*` probes' `lateByMs`/`eventLoopMaxMs` spike in lockstep with `decompressionsPerSec` while `lean` stays flat, AND main's `(physFootprint − resident)` rises during its stalls. **REFUTED** if lean and fat lag identically, or main stalls with no squeeze rise. → gates B1's cold-heap claim, B4, B5.
- **(b) churn amplification — CONFIRMED** if main lag tracks push/flush spans and the `heapGrowthMb` sawtooth, AND `fat-touch` lags measurably more than `fat-idle`. **REFUTED** if idle ≡ touch. → gates B1, B2.
- **(c) fault-monopoly — CONFIRMED** if a single `fat-touch.touchMs` cold-slice touch hits the same 0.3–5 s quantum as main's stalls. **REFUTED** if `touchMs` stays in ms while the compressor thrashes.
- **GC-over-cold-heap:** CONFIRMED if `gcMs` spikes to seconds under pressure, correlating with main's multi-second pauses. → strengthens B1 and the B5 GC options.

This run doubles as the **overdue live re-validation of the 07-11 replay-storm fixes** (watch `subShortCircuits`, sub-convoy depth, ack rate during the window).

### A5 — hop-count metric: defer

Max span-tree depth per trace is derivable from existing `Span.parent` links, but surfacing it touches the trace engine schema/panes — deferred to the B6 track with this note.

---

## Phase B — fixes per axis (each independently mergeable; gates named)

### B1 — keyed-snapshot slimming (gate: axis **b**; note this is primarily a **churn** fix — non-persisted snapshots already evict on N→0; standing retention only for persisted `scopedMembership`)

Store an 8-byte content hash instead of the full canonical-JSON string; keep `JSON.stringify(row)` as the canonicalization (CPU unchanged), retain only `Bun.hash.wyhash(json)` (bigint):

- `keyed-diff.ts`: `KeyedSnapshot` → `ReadonlyMap<string, bigint>`; `hashRow()` replaces the four inline stringify-stores. All consumers compare equality only — except:
- **Persist-reconstruction carve-out** (`runtime.ts:2189-2194` JSON.parses stored strings): maintain `entry.persistValue: Map<pk, unknown[]>` **for persisted-`scopedMembership` entries only**, updated by applying the same `{upserts, deletes, order}` the membership diff already computes (and seeded/replaced wherever `drainMembershipFull` seeds the snapshot), stringified directly at persist. Wire + jsonb bytes stay byte-identical. Measure object-vs-string size in A3 first; fall back to retaining canonical strings in `persistValue` for this one class if objects prove larger. Rejected alternatives: keep-strings-for-that-class-in-snapshot (no win where it churns most), read-prior-jsonb-from-DB (adds a DB read to the hot persist path).
- **Collision trade (document in-code):** a 64-bit collision = a silently missed update no self-heal catches. Birthday-bounded to astronomically small at realistic row counts; optional cheap tiebreak `hash ^ (BigInt(len) << 56n)`.
- Untouched by construction: sub-ack idempotent re-seed and evicted-snapshot self-heal depend on snapshot *presence*, not content.
- **Tests:** extend `keyed-diff.test.ts` fuzz (client view still converges), pin byte-identical jsonb for the persist carve-out, collision-injection test documenting the failure mode. Full runtime invariant suite green.

### B2 — delivery serialize-once (gate: none — self-justifying; land early)

`broadcastJson(subs, msg)`: stringify once, `ws.send(str)` per socket (string send = identical wire). Replace the five per-subscriber loops (`runtime.ts:1382, 2081, 2220, 2404, 2433`); keep `sendJson` for single-recipient frames. Saves `frames × (subscribers − 1)` full serializations. Preserve `sendUpdate`'s no-await-before-send (stringify stays synchronous, before the loop) — `runtime-h5.test.ts` pins it.

### B3 — persist/deliver serialization reuse: **rejected**

Persist is bare jsonb; delivery wraps an envelope; persist often runs with zero subscribers (L2 always-persist). String-splicing a shared `valueStr` into the frame is fragile and defeats B2. Considered and rejected.

### B4 — corpus-index residency (gate: A3 shows the corpus bucket is material)

- **B4a (small, land first): bound growth** — retention horizon (config, default ~90 days) on `FilePartial`/`dayBuckets` in `stats/cost/server/internal/usage-index.ts`, applied at rollup *and* entries-consumption so every backend's resident set shrinks. Test: extend `usage-index.test.ts` (boundary cases).
- **B4b (own track, sized later): worktree→main delegation** — worktree backends proxy `GET /api/stats/cost/*` to main instead of loading the host-global index locally (today `ensureFresh()` loads it into any backend that serves a cost request; only persistence is main-gated). Needs a cross-backend fetch seam; gate on A3 materiality.

### B5 — fleet-footprint options (assess only; present with trade-offs, no commitment)

- `--smol` for **worktree** backends at the gateway spawn site (`gateway/worktree.go`, same non-main/non-central predicate as darwinbg at :877) — shrinks fleet JSC heaps (host-pressure reduction complementing the deferred Stage 2). Distinct, reversible commit. **Main stays un-smol** (throughput-critical).
- Periodic idle `Bun.gc()` + heap-shrink — measure `fat-touch.gcMs` first: a GC pause itself walks cold pages.

### B6 — hop-count reduction: separate track (A5 note feeds it).

---

## Ordering

1. **A2** resident metric → 2. **A1** probe harness → 3. **B2** serialize-once (self-justifying) → 4. **A3** heap attribution (manual) → 5. **A4** controlled pressure run (**fresh go-ahead required**) → 6. **B1** hash snapshots (after axis-b verdict) → 7. **B4a** corpus retention (after A3 materiality) → 8. B5/B4b/B6 assessed/deferred.

Disjoint files per fix (B1: keyed-diff/runtime; B2: runtime broadcast; B4: stats/cost; B5: gateway Go) — independently landable/revertible.

## Session log

### 2026-07-16 — A3 heap attribution RUN (live main, quiet-ish host, load ~15)

Samples: heap-stats ×2 (13:0x, ~20 min apart) + one V8 `.heapsnapshot`
(`heap-1784199988883.heapsnapshot`, 66 MB, self-size aggregation by
constructor + string-content buckets):

| Bucket | Size | Verdict |
|---|---|---|
| **JS heap total self-size** | **97 MB** (heapSize 138–159 MB, capacity 170–210 MB) | The JS heap is NOT the bulk of the footprint |
| plain strings | 28.4 MB / 145k | — |
| closures + code + ModuleRecords | ~44 MB | the plugin codebase itself (grows with plugin count) |
| **keyed-snapshot canonical-JSON strings** | **~5–6 MB** (`{"id…` 4.4 + `{"conversationId…` 0.7 + `{"attemptId…` 0.3) | B1's *standing-retention* win is small — B1 is a **churn** fix (FC-2 confirmed on data) |
| corpus-index (stats/cost) | **not loaded**; persisted file 2.5 MB / 3,837 entries | ❌ NOT material — **B4a skipped by its gate** (fleet-duplication concern remains, revisit if the index 10×es) |
| phys_footprint − heap | ≈ 230–310 MB | **off-heap native** (JSC JIT/bmalloc, Bun internals, buffers) — the dominant standing footprint |
| `ps` RSS vs phys_footprint | 865 MB vs 392–469 MB | rss over-count confirmed live (FC-1) |

Consequences for the axes: (a) **cold-RSS shrink via JS-cache eviction has
little headroom on today's main** — the standing footprint is mostly code +
native, which only the pressure experiment can weigh; the 1.26 GB episode
peaks were transient churn backlog (heap 188→608 MB during the 07-11 freeze),
i.e. **axis (b)**. B1+B2 (built this session) attack exactly that. Axis (c)
confirmation still requires the probes + pressure run (A4).

Also corroborated live while planning: an idle 11-hour backend squeezed to
90 MB resident while younger ones sat at 700+ MB rss — the victim shape, now
directly measurable via A2's `physFootprintMb − residentMb` series.

### 2026-07-16 — implementation state (worktree `att-1784197364-no0m`, build green, deployed)

- **A2 BUILT + verified live**: `procMemory()` (phys_footprint + ri_resident_size,
  one syscall) in server-core; `residentMb` (optional) in `HealthSampleSchema`,
  sampled every tick, charted on the Health pane. Live sample on the worktree
  backend: `residentMb: 544.9` alongside `physFootprintMb: 230.5` — note
  resident also counts shared file-backed pages, so read the difference as a
  TREND (resident falling under pressure = squeeze), documented in the schema.
- **A1 BUILT + smoke-tested**: `plugins/debug/plugins/paging-probe/` — three
  child-process variants (lean / fat-idle / fat-touch), config-gated OFF,
  main-only + non-release, sentinel-worker-host-shaped supervisor, copied FFI
  (lean closure), `lateByMs` headline metric, 21 co-located tests. Layout note:
  the spawned entry lives at `server/internal/probe/entry.ts` (NOT `bin/` — the
  type-check only discovers tsconfigs under `plugins/framework/plugins/*`; the
  sentinel-worker layout is the sanctioned pattern for spawned entries). Smoke:
  lean tick lateByMs 0 / 12 MB footprint; fat-touch 32 MB → touchMs 0.3 ms warm
  baseline, gcMs 0.9 ms.
- **B2 BUILT** (`broadcastJson`, all 6 sites, H5a preserved) — 119/119 runtime
  tests. **B1 BUILT** (hash snapshots via `SnapEncoder`; `scopedMembership`
  statically retains canonical strings for the persist-reconstruction carve-out,
  loud invariant guard; both-encoder test parameterization + collision-injection
  test) — 146/146 across runtime + round-trip suites. Deployed and verified
  serving live keyed data (tasks list over HTTP + full UI render).
- **NOT run yet**: A4 (controlled pressure — awaiting explicit go-ahead) and the
  organic-freeze cross-tab. Probes remain OFF until an experiment window.

## Verification

- **Per-step verifies** listed inline above (schema tolerance, probe footprints, invariant suites, byte-identical jsonb).
- **End-to-end:** `./equin build`; `./equin check`; run the A4 protocol — the exit test per the methodology: under the same induced pressure, main's lag quanta and `(physFootprint − resident)` squeeze must *shrink measurably* post-fixes vs the pre-fix baseline window, while the lean probe's floor is unchanged (proves we fixed the victim, not the pressure).
- **Living-doc duty:** update this doc + `research/perfs/CLAUDE.md` index paragraph with every verdict (✅/❌/🔬 per axis), same-turn.

## Altitude statement (methodology requirement)

The host-layer **origin** is fleet memory overcommit (Stage 2 enforcement — separate, user-gated track). This plan's fixes are the **cure at main's layer** for the *victimhood differential*: other apps survive the same pressure; after (a)+(b) fixes main's working set is smaller, denser, and less churned, so it should too. Containments are labelled as such where they occur.
