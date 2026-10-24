# Backend RSS reduction — root-cause track

**Date:** 2026-06-18
**Category:** global (server-core boot, infra watchers, debug tooling)
**Scope:** Instrument + fix in one pass. Diagnostic tooling is permanent.

## Context

Each `bun bin/index.ts` worktree backend grows to ~4.6–6.1 GB RSS within seconds of
boot, even on a healthy host. With several worktrees deployed concurrently this
exhausts the 64 GB machine and produces bursty slowness — long stop-the-world GC
pauses on multi-GB heaps plus expensive cold-starts whenever the gateway lazy-spawns
a backend or re-spawns one after the 10-minute idle sweep.

**Why the existing health-monitor isn't enough.** The `health-monitor` plugin
samples `process.memoryUsage()` every 10s and persists RSS/heap/event-loop lag to
`logs/health.jsonl` (read from disk so it survives a wedged backend). That answers
*whether* and *when* a backend balloons, and is the detection half of this work. It
cannot answer *why*: it has no per-boot-phase RSS attribution and no breakdown of the
heap by object type. This track adds exactly those two missing capabilities and then
fixes the culprit they surface. The two compose: health-monitor = detection/when;
this track = attribution/why.

**Key finding from exploration.** Static analysis eliminated the frontend bundle
(the Go gateway streams `web/dist` via `http.ServeFile`; the bundle never enters the
bun process) and found **no single GB-scale allocation in the TS code**. The largest
held blobs are tweakcn `catalog.json` (2 MB) and `ICON_SVG_MAP` (636 KB), eagerly
imported at module scope — real waste but not GB-scale. The leading structural
suspect is `@parcel/watcher`: the shared `createFileWatcher` primitive only passes an
`ignore` list when a caller opts in, and **only 1 of 7 callers does**. The remaining
6 recursively watch unbounded trees (`.git`, `~/.claude/projects`,
`~/.singularity/worktrees`, the repo) with no ignore patterns. Because the true
culprit is not provable from static reading, **the plan is diagnostic-first**: build
the measurement tools, run them on a live backend, then fix what the data points to —
applying the high-confidence structural fixes regardless.

## Phase A — Diagnostic instrumentation (permanent)

### A1. Per-phase RSS attribution in the boot profiler

Extend the existing boot profiler so the boot Gantt also shows the RSS delta of each
phase/plugin. Boot phases (`register → awaitPgReady → runMigrations →
routePopulation → socketBind → onReadyBlocking → onReady → onAllReady`) already wrap
spans; we add memory to them.

- **`plugins/framework/plugins/server-core/core/profiler.ts`**
  - Add optional `rssStartMb` / `rssEndMb` to the `Span` type. In `profilerStart`,
    capture `process.memoryUsage().rss` at start and in the returned end fn.
    `process.memoryUsage()` is cheap; this is near-free.
  - Add a `memoryCheckpoints: MemoryCheckpoint[]` array and a
    `recordMemoryCheckpoint(label)` export that snapshots
    `{ label, atMs, rssMb, heapUsedMb, externalMb, arrayBuffersMb }`.
  - Include `memoryCheckpoints` in `getProfilingData()`'s return.
- **`plugins/framework/plugins/server-core/bin/index.ts`** — call
  `recordMemoryCheckpoint(...)` at clean boundaries: process start (baseline), after
  the `Promise.allSettled` module-import block (≈ end of `register`), after
  `onReadyBlocking`, after `onReady`, after `onAllReady`. These boundary deltas are
  the clean signal.
- **`plugins/debug/plugins/profiling/plugins/boot/`** — surface RSS in the Gantt:
  - `shared/endpoints.ts` — add `memoryCheckpoints` + per-span RSS to the response
    type (mirror `getProfilingData()`).
  - `web/components/boot-section.tsx` — render an RSS-delta label per phase group and
    a compact checkpoint timeline (baseline → after each phase). Reuse the existing
    `GanttSection` / `groupByPhase` API; do not fork it.

**Caveat to document in the code:** `onReadyBlocking` and `onReady` run their plugins
under `Promise.all`, so *per-plugin* RSS deltas inside those phases overlap and are
only directional. The *phase-boundary* checkpoints are the authoritative numbers.

### A2. On-demand heap inspector (new debug sub-plugin)

New plugin **`plugins/debug/plugins/heap-snapshot/`** (mirror the structure of
`health-monitor` and `profiling/boot`): server endpoint + Debug sidebar pane.

- **Primary surface — `heapStats()` from `bun:jsc`** (cheap, aggregated): returns
  `{ heapSize, heapCapacity, objectCount, objectTypeCounts, protectedObjectTypeCounts, ... }`.
  `objectTypeCounts` is a per-JS-type count map — the direct "what is on the heap"
  answer. Render as a sortable table (type → count), plus headline `heapSize` /
  `objectCount`. This is the main "why" surface and is safe to call repeatedly.
- **Deep dump — full snapshot to disk, on demand:** a button calls
  `generateHeapSnapshotForDebugging()` (WebKit/Safari `.heapsnapshot` format; confirm
  the exact `bun:jsc` export name at implementation — Bun also exposes
  `generateHeapSnapshot()`). Write to
  `~/.singularity/worktrees/<wt>/heap-<timestamp>.heapsnapshot` and return the path +
  byte size. Loadable offline in Safari Web Inspector → Timelines/Heap.
- **Endpoints** (use `defineEndpoint`/`implement` from
  `@plugins/infra/plugins/endpoints`): `GET /api/debug/heap-stats` (cheap stats),
  `POST /api/debug/heap-snapshot` (dump to disk).
- **Pane**: `Pane.Register` + `DebugApp.Sidebar` "Heap" entry, mirroring
  health-monitor's web wiring.

**Caveats to document:** the full snapshot is synchronous and blocks the event loop
for its duration (seconds on a multi-GB heap) and the file can be hundreds of MB —
acceptable for a manual debug action, but the button must be clearly a heavy,
on-demand operation (no polling). `heapStats()` is cheap and is the everyday tool.

### A3. The decisive diagnostic fork

`heapStats().heapSize` vs sampled RSS is itself the key discriminator:
- **Heap ≈ RSS (multi-GB JS heap):** culprit is JS allocation → the snapshot's
  dominant retained type names it; fix that allocation.
- **Heap ≪ RSS (small heap, huge RSS):** culprit is *native/off-heap* — `@parcel/watcher`
  native trees, pg driver buffers, JSC mmap'd regions, `external`/`arrayBuffers`.
  Then the watcher fixes (Phase C) are the primary lever and per-phase RSS localizes
  which `onReady` watcher is responsible.

## Phase B — Measure

1. `./equin build` to deploy Phase A.
2. Open Debug → Profiling (boot) and read per-phase RSS deltas; open Debug → Heap and
   read `heapStats()` + capture one full snapshot a few seconds after boot.
3. Cross-check against `logs/health.jsonl` RSS trend.
4. Record findings inline in this doc (append a "Findings" section) to drive Phase C's
   data-driven fix.

## Findings (Phase B — measured 2026-06-18)

The new per-phase RSS tooling + vmmap/footprint produced a decisive — and
plan-overturning — result.

**1. The JS heap is tiny; the balloon is off-heap.** `heapStats()` after boot:
heapSize 41 MB, 422 k objects. A full snapshot is 92 MB. Yet `process.memoryUsage().rss`
reaches 5+ GB. So the balloon is *not* JS objects.

**2. Boot per-phase RSS:** boot-start 33 MB → after-import 209 MB → after-onReadyBlocking
306 MB → **after-onReady 5417 MB**. All the growth is in `onReady`. Per-plugin
attribution fingered `onReady:infra.git-watcher` (+5047 MB / 20 s) — but that is a
**red herring**: onReady runs under `Promise.all`, git-watcher's span is the longest
(its `git` subprocesses are slow under host contention), so it merely *brackets*
whatever allocates concurrently.

**3. `ps` / `process.memoryUsage().rss` massively overcounts on macOS.** For the same
backend at the same instant: **`ps_rss` = 5.46 GB but `phys_footprint` = 885 MB** (~6×).
`vmmap` shows the "RSS" is dominated by *resident-but-clean/reserved* pages:
- WebKit Malloc (JSC bmalloc): 2.7 G resident, **only 160 M dirty**.
- IOAccelerator (GPU / unified memory): 1.8 G resident, **691 M dirty**.
- JS VM Gigacage: huge *virtual* reservation (65 GB reserved), ~0 resident.
A minimal `bun -e` process reserves the same 65 GB Gigacage virtual but is 22 MB rss /
~20 MB footprint — confirming the giant reservations are baseline JSC and not physical.

**4. @parcel/watcher is NOT the cause.** Isolated probe: `parcel.subscribe` on both
`.git/refs` and the whole `.git` (with ignores) returns in 1–2 ms and allocates **0 MB**
(footprint flat at 20 MB). The watcher hypothesis in the original plan is disproven.

**5. Real footprint settles < 1 GB.** Backends peak ~4.2 GB ps_rss / ~885 MB footprint
during onReady, then settle to ~350 MB footprint. The genuine real consumer above the
~310 MB post-onReadyBlocking baseline is ~575 MB, of which the largest single piece is
**IOAccelerator (GPU) dirty memory (~691 MB)** — anomalous for a headless server and the
one genuinely unexplained, potentially-reducible item.

**Conclusion:** the headline "4–6 GB per-backend balloon" is *primarily a measurement
artifact* of `rss` (which is what the health-monitor logs). True per-backend physical
footprint is < 1 GB. Many backends at ~885 MB each (plus builds, embedded PG, claude
processes) can still pressure the host, but no single backend holds 6 GB of real memory.
File-watchers and the frontend bundle are both exonerated.

## Shipped (this task)

- **Diagnostic tooling (kept, permanent):** per-phase RSS + memory-boundary timeline in
  the Boot Gantt; new **Debug → Heap** pane (`heapStats()` type breakdown + on-demand V8
  `.heapsnapshot` dump). This is what cracked the case and stays for future use.
- **C2 git-watcher → watch only `.git/refs`** (kept, reframed as a **perf** fix): measured
  git-watcher onReady span **20 s → 1.1 s**. It no longer reacts to the high-churn object
  store shared across 1000+ worktree gitdirs. (No memory effect — parcel allocates ~0.)
- **C3 lazy static imports** (kept): tweakcn catalog (2 MB) + icon map (636 KB) no longer
  parsed/resident on every backend boot.
- **C1 reverted:** the file-watcher default-ignore primitive change + watch-edited-files
  migration. Parcel is not a memory cost, and the `**/.git/**` default broke git-watcher.
- **Two follow-up tasks filed:** (R1) report phys_footprint instead of rss across the
  memory surfaces; (R4) investigate the ~691 MB IOAccelerator/GPU memory.
- **Debug skill updated** with the Heap pane, per-phase boot RSS, and the rss-overcount caveat.

## Revised fixes (supersede the original Phase C hypothesis)

- **R1 — Report `phys_footprint`, not just `rss`** (the actual fix). The boot checkpoints,
  the heap pane, and the health-monitor should surface macOS `phys_footprint` (the metric
  Activity Monitor / memory-pressure use) so the team stops chasing the inflated `rss`
  phantom. `process.memoryUsage()` doesn't expose it; obtain it by shelling out to
  `footprint <pid>` (precedent: host-sampler already spawns `vm_stat` every 10 s) or via
  FFI `task_info(TASK_VM_INFO)`.
  - **✅ SHIPPED 2026-06-19** (`research/2026-06-19-global-phys-footprint-memory-surfaces.md`).
    Replaced `rss` with `phys_footprint` on all three surfaces. Acquisition: FFI
    `proc_pid_rusage(RUSAGE_INFO_V0)` reading `ri_phys_footprint` (synchronous, no
    subprocess — survives a wedged event loop, unlike a `footprint` spawn) via the new
    `physFootprintBytes()` helper in `framework/server-core/core`. Falls back to `rss`
    off-darwin.
- **R2 — Keep C3 (lazy static imports).** Genuine, if small, real-footprint win on every
  backend; unrelated to the artifact, still worth keeping.
- **R3 — Revert C1/C2 watcher changes.** Parcel is proven not the cause; the default
  `**/.git/**` ignore also breaks git-watcher (needed an `includeHeavyDirs` workaround).
  Don't ship a fix for a disproven cause. (Decision pending user confirmation.)
- **R4 — Follow-up: investigate the ~691 MB IOAccelerator (GPU) dirty memory** — what in
  the backend touches Metal/GPU? Not baseline Bun. Likely a separate task.

## Phase C — Structural fixes (original hypothesis — see "Revised fixes" above)

### C1. Fail-safe default ignore in `createFileWatcher` (highest-confidence structural fix)

The primitive is opt-in for `ignore`; it must be **fail-safe by default**. Per the
project principle "fix the structural issue, not the instance," every current and
future caller should be protected with zero per-call code.

- **`plugins/infra/plugins/file-watcher/server/internal/create-file-watcher.ts`** —
  always apply a curated default ignore list, merged with any caller `ignore`:
  `**/node_modules/**`, `**/.git/**`, `**/dist/**`, `**/build/**`, `**/.next/**`,
  `**/.turbo/**`, `**/.cache/**`, `**/coverage/**`. Add an explicit opt-out
  (`includeHeavyDirs?: true`) for the rare watcher that truly needs them (none today).
  Export the default list so callers/tests can reference it.
- **Migrate the lone bypass onto the primitive:**
  `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/watch-edited-files.ts`
  calls `parcel.subscribe` directly with its own `IGNORE`. Route it through
  `createFileWatcher` so there is **one** watch path with the safe default — removing
  the only bypass and the duplicated ignore list.

### C2. Narrow the git-watcher tree

- **`plugins/infra/plugins/git-watcher/server/internal/watcher.ts`** — currently
  watches `${commonDir}/refs/heads` **and** the entire `${commonDir}` (`.git`)
  recursively, including the object store. It only needs ref changes. Drop the full
  `commonDir` recursive watch; watch `${commonDir}/refs` (and rely on the C1 default
  ignore, extended with `objects/**`, `lfs/**`, to keep the tree small). Verify
  `packed-refs` advances are still observed (add its parent if needed).

### C3. Lazy-load eager static blobs

Both are imported at module scope, so parsed and held resident on **every** backend
boot though most worktrees never hit their endpoints.

- **`plugins/ui/plugins/tweakcn/plugins/community-browser/server/internal/handle-get-catalog.ts`**
  — replace the top-level `import catalog from "../../shared/catalog.json"` (2 MB)
  with a memoized lazy load inside the handler (`await import(...)` or `readFile`).
- **`plugins/primitives/plugins/icon-picker/server/`** — `ICON_SVG_MAP` (636 KB,
  `icon-svg-map.generated.ts`) is imported unconditionally via `resolve-svg.ts`.
  Make it a memoized lazy import resolved on first SVG-resolution request.

### C4. Data-driven culprit (the actual root cause)

Whatever Phase B's snapshot/per-phase RSS names as the dominant retained type or the
ballooning phase gets a structural fix here. This is the load-bearing fix; C1–C3 are
high-confidence cleanups that stand on their own. (Exact change TBD by measurement —
do not guess before Phase B.)

## Phase D — Document the new debug entry points

Update the **debug skill** and plugin docs so the new surfaces are discoverable.

- **`.claude/skills/debug/SKILL.md`** — under "Profiling (Gantt)" note the boot Gantt
  now shows **per-phase RSS deltas**; add a new bullet for **Debug → Heap**
  (`heapStats()` object-type breakdown + on-demand `.heapsnapshot` dump for offline
  Safari analysis), and state the heap-vs-RSS discriminator (A3) as the first move for
  any "backend RSS ballooning" investigation.
- **`plugins/debug/plugins/heap-snapshot/CLAUDE.md`** — hand-written prose + autogen
  block (created/refreshed by `./equin build`).
- The compact/details plugin docs regenerate via `./equin build`.

## Critical files

| Concern | File |
|---|---|
| Boot profiler (RSS spans + checkpoints) | `plugins/framework/plugins/server-core/core/profiler.ts` |
| Boot phase boundaries | `plugins/framework/plugins/server-core/bin/index.ts` |
| Boot Gantt endpoint/UI | `plugins/debug/plugins/profiling/plugins/boot/{shared/endpoints.ts,web/components/boot-section.tsx}` |
| New heap inspector | `plugins/debug/plugins/heap-snapshot/{server,web,shared}/` (new) |
| Watcher default-ignore | `plugins/infra/plugins/file-watcher/server/internal/create-file-watcher.ts` |
| Bypass to migrate | `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/watch-edited-files.ts` |
| git-watcher narrowing | `plugins/infra/plugins/git-watcher/server/internal/watcher.ts` |
| Lazy tweakcn catalog | `plugins/ui/plugins/tweakcn/plugins/community-browser/server/internal/handle-get-catalog.ts` |
| Lazy icon map | `plugins/primitives/plugins/icon-picker/server/` (`resolve-svg.ts`, `icon-svg-map.generated.ts`) |
| Debug skill | `.claude/skills/debug/SKILL.md` |

## Verification

- `./equin build`, then load `http://<worktree>.localhost:9000`.
- **Diagnostics work:** Debug → Profiling shows non-zero per-phase RSS deltas and the
  checkpoint timeline; Debug → Heap shows `heapStats()` type counts and successfully
  writes a `.heapsnapshot` file (verify it loads in Safari Web Inspector).
- **Reduction confirmed:** compare steady-state RSS (`logs/health.jsonl` and Debug →
  Health, ~30s after boot) before vs after Phase C on the same worktree. Target a
  clear drop from the 4–6 GB baseline. Spawn 2–3 worktrees and confirm aggregate host
  memory pressure (Debug → Health host strip) drops.
- **Watchers still function:** edit a file in a conversation worktree → "edited files"
  still updates; `git commit` on main → git.refAdvanced still fires (ref resource
  updates); config edit still hot-reloads.
- `./equin check` passes (boundaries, doc-in-sync, type-check).
