# Report phys_footprint instead of rss across backend memory surfaces

**Date:** 2026-06-19
**Category:** global (framework/server-core boot profiler + debug tooling)
**Follow-up to:** `research/2026-06-18-global-backend-rss-reduction.md` (Findings + Revised fix **R1**)

## Context

The prior RSS-reduction investigation proved the headline "4–6 GB per-backend balloon"
is **primarily a measurement artifact** of `process.memoryUsage().rss`, which on macOS
massively overcounts real memory. Measured on a live worktree backend at one instant:
`ps`/`rss` read **5.46 GB** while the true `phys_footprint` was **885 MB** (~6×). `vmmap`
showed the "RSS" is dominated by resident-but-clean/reserved pages — JSC WebKit-Malloc
(2.7 G resident, only 160 M dirty), the JS VM Gigacage (65 GB virtual, ~0 resident), and
IOAccelerator/GPU regions. A bare `bun -e` process reserves the same 65 GB Gigacage but is
22 MB rss.

Every diagnostic surface today reports `rss`: the boot per-phase checkpoints, the new
Debug → Heap pane, and the health-monitor sampler. So they all show 4–6 GB per backend
when the real footprint is < 1 GB — sending memory investigations chasing a phantom.

**Goal:** report macOS `phys_footprint` (the metric Activity Monitor and macOS
memory-pressure use) **instead of** `rss` on all three surfaces. `process.memoryUsage()`
has no field for it; we obtain it via FFI `proc_pid_rusage`.

**Decisions (confirmed with user):**
- **Acquisition:** FFI `proc_pid_rusage` (synchronous, ~µs, no subprocess). Not the
  `footprint <pid>` subprocess — async spawns won't resolve under a wedged event loop,
  which is exactly when the health sampler must keep working, and they'd add latency to
  each boot checkpoint.
- **Display:** **replace** `rss` with `phys_footprint` on every surface (don't show both).

## Mechanism — one shared FFI helper

`proc_pid_rusage(pid, RUSAGE_INFO_V0, &buf)` (libproc) fills a `rusage_info_v0` struct whose
`ri_phys_footprint` (uint64) lives at **byte offset 72** — the same value Activity Monitor
shows. This needs no `mach_task_self()` dance (unlike `task_info(TASK_VM_INFO)`); it takes a
pid directly. FFI via `dlopen` is well-precedented here (`packages/host-semaphore`,
`infra/worktree`).

```
struct rusage_info_v0 {            // offset
  uint8_t  ri_uuid[16];            //  0
  uint64_t ri_user_time;           // 16
  uint64_t ri_system_time;         // 24
  uint64_t ri_pkg_idle_wkups;      // 32
  uint64_t ri_interrupt_wkups;     // 40
  uint64_t ri_pageins;             // 48
  uint64_t ri_wired_size;          // 56
  uint64_t ri_resident_size;       // 64
  uint64_t ri_phys_footprint;      // 72  ← target
  uint64_t ri_proc_start_abstime;  // 80
  uint64_t ri_proc_exit_abstime;   // 88
};                                 // size 96
```

### Where it lives — and why it must be inside server-core

The boot profiler (`plugins/framework/plugins/server-core/core/profiler.ts`) is the lowest
layer; anything it imports cannot transitively import server-core back. Every plugin's
`server` barrel default-exports a `ServerPluginDefinition` (a type-only edge to
server-core/core), so a dedicated leaf-plugin barrel would create a **cycle**
(server-core → helper → server-core). The helper therefore must be **internal to
server-core** and re-exported from its `core` barrel so the two debug consumers can import
it cross-plugin.

This is safe re: web bundling: **no `web/` file imports `@plugins/framework/plugins/server-core/core`**
(verified by grep), and `profiler.ts` already calls the Bun-only `process.memoryUsage()`
in that same barrel. To be defensive, the `dlopen` is **memoized inside the function**
(deferred, not at module top-level) so merely importing the module has no FFI side effect.

**New file — `plugins/framework/plugins/server-core/core/phys-footprint.ts`:**

```ts
import { dlopen, ptr, suffix } from "bun:ffi"; // suffix/dylib name confirmed at impl

/** phys_footprint of `pid` in bytes (macOS only). null on non-darwin. Throws if the
 *  darwin syscall fails (fail loud — a broken FFI binding must not silently degrade). */
export function physFootprintBytes(pid: number = process.pid): number | null
```

- Darwin only; returns `null` on other platforms (the host is the user's Mac). Consumers
  fall back to `process.memoryUsage().rss` so the wire field is always a number — documented
  in each call site.
- Confirm at implementation: dylib (`libproc.dylib`, fall back to the full libSystem path)
  and that `proc_pid_rusage` is exported there; flavor `RUSAGE_INFO_V0 = 0`.
- Export `physFootprintBytes` from `core/index.ts`.

## Surface changes (replace rss → phys_footprint)

### 1. Boot per-phase checkpoints — `plugins/framework/plugins/server-core/core/profiler.ts`
- `MemoryCheckpoint`: rename `rssMb` → `physFootprintMb`. Keep `heapUsedMb` / `externalMb` /
  `arrayBuffersMb` (real JS-side detail, still from `process.memoryUsage()`).
  `recordMemoryCheckpoint` sets `physFootprintMb = toMb(physFootprintBytes() ?? process.memoryUsage().rss)`.
- `Span`: rename `rssStartMb`/`rssEndMb` → `physFootprintStartMb`/`physFootprintEndMb`;
  `profilerStart` captures `physFootprintBytes()` (fallback rss) at start and end. Sync, cheap.
- No other callers of these Span/checkpoint fields exist outside the boot debug pane (verified).

### 2. Boot Gantt pane — `plugins/debug/plugins/profiling/plugins/boot/`
- `shared/endpoints.ts`: `SpanSchema` `rssStartMb`/`rssEndMb` → `physFootprintStartMb`/
  `physFootprintEndMb`; `MemoryCheckpointSchema` `rssMb` → `physFootprintMb`.
- `server/internal/handle-boot-profiling.ts`: pass-through (spreads the renamed fields) — no
  logic change, just confirm it still type-checks against the renamed schema.
- `web/components/boot-section.tsx`: `CheckpointRow.rssMb` → `physFootprintMb`; column headers
  `RSS`→`Footprint`, `Δ RSS`→`Δ Footprint`; the per-phase directional table reads
  `physFootprint{Start,End}Mb`; update the `MemorySummary` caveat comment to say "phys_footprint".

### 3. Heap pane — `plugins/debug/plugins/heap-snapshot/`
- `shared/endpoints.ts`: add `physFootprintMb: z.number()` to `HeapStatsResponseSchema`.
- `server/internal/handle-heap-stats.ts`: return
  `physFootprintMb = (physFootprintBytes() ?? process.memoryUsage().rss) / BYTES_PER_MB`.
- `web/components/heap-panel.tsx`: add `phys_footprint` to the headline next to heap size — it
  is now the real **heap-vs-footprint discriminator** (research A3): heap ≈ footprint ⇒ JS
  allocation; heap ≪ footprint ⇒ off-heap/native.

### 4. Health-monitor sampler — `plugins/debug/plugins/health-monitor/`
- `shared/schema.ts`: in `HealthSampleSchema` **remove `rssMb`, add `physFootprintMb: z.number()`**.
  (Historical `health.jsonl` lines lack the new field, so `safeParse` drops them — a brief
  history gap right after deploy as the ~2h rolling window refills. Acceptable.)
- `server/internal/process-sampler.ts`: `tick()` stays **synchronous**; set
  `physFootprintMb = (physFootprintBytes() ?? mem.rss) / 1_048_576`. Document the fallback.
- `web/components/health-monitor-panel.tsx`: Memory chart line `{ key: "rssMb", label: "RSS" }`
  → `{ key: "physFootprintMb", label: "Footprint" }`; headline `latest.rssMb … "MB RSS"` →
  `latest.physFootprintMb … "MB footprint"`.

### 5. Docs
- `.claude/skills/debug/SKILL.md`: the memory surfaces now report **phys_footprint**, not rss;
  drop/rewrite the "rss overcounts ~6×" caveat into "we now report the real footprint
  (phys_footprint); rss is intentionally not shown." Keep the heap-vs-footprint discriminator
  as the first move for any "backend memory ballooning" investigation.
- Append a short "Shipped (R1)" note to `research/2026-06-18-global-backend-rss-reduction.md`.
- Plugin `CLAUDE.md` autogen blocks + `docs/plugins-*.md` regenerate via `./equin build`
  (the new `physFootprintBytes` export and changed slots are picked up automatically).

## Critical files

| Concern | File |
|---|---|
| FFI helper (new) | `plugins/framework/plugins/server-core/core/phys-footprint.ts` |
| Core barrel export | `plugins/framework/plugins/server-core/core/index.ts` |
| Boot profiler fields | `plugins/framework/plugins/server-core/core/profiler.ts` |
| Boot endpoint schema | `plugins/debug/plugins/profiling/plugins/boot/shared/endpoints.ts` |
| Boot handler (passthrough) | `plugins/debug/plugins/profiling/plugins/boot/server/internal/handle-boot-profiling.ts` |
| Boot Gantt UI | `plugins/debug/plugins/profiling/plugins/boot/web/components/boot-section.tsx` |
| Heap endpoint schema | `plugins/debug/plugins/heap-snapshot/shared/endpoints.ts` |
| Heap handler | `plugins/debug/plugins/heap-snapshot/server/internal/handle-heap-stats.ts` |
| Heap UI | `plugins/debug/plugins/heap-snapshot/web/components/heap-panel.tsx` |
| Health schema | `plugins/debug/plugins/health-monitor/shared/schema.ts` |
| Health sampler | `plugins/debug/plugins/health-monitor/server/internal/process-sampler.ts` |
| Health UI | `plugins/debug/plugins/health-monitor/web/components/health-monitor-panel.tsx` |
| Debug skill | `.claude/skills/debug/SKILL.md` |

## Verification

1. **Spot-check the helper** before wiring UI: in a worktree shell, compare against the OS —
   `footprint <backend-pid>` (Activity Monitor's number) should match `physFootprintBytes`
   within rounding, and be ~5–6× **smaller** than `ps -o rss= -p <pid>`.
2. `./equin build`, then load `http://<worktree>.localhost:9000`.
3. **Boot pane** — Debug → Profiling: checkpoint timeline shows a `Footprint` column with
   plausible sub-GB numbers (not the old ~5 GB rss); after-onReady is dramatically lower than
   the historical rss figure.
4. **Heap pane** — Debug → Heap: headline shows `phys_footprint` next to heap size; footprint
   ≫ heap (confirming the off-heap discriminator) but still < 1 GB.
5. **Health pane** — Debug → Health: the Memory chart's primary line is labeled `Footprint`,
   trends < 1 GB, and the headline reads "… MB footprint". New `health.jsonl` lines carry
   `physFootprintMb` and no `rssMb` (`tail` the file).
6. `./equin check` passes (plugin-boundaries — confirm no server-core import cycle and no
   web→bun:ffi leak; type-check; plugins-doc-in-sync after build).
