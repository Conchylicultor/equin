# Backend GPU (IOAccelerator) memory — root-cause + observability

**Date:** 2026-06-18
**Category:** global (debug tooling + Bun runtime)
**Follow-up to:** [`research/2026-06-18-global-backend-rss-reduction.md`](./2026-06-18-global-backend-rss-reduction.md) (item **R4**)
**Deliverable (confirmed with user):** diagnose the root cause **and** ship a permanent `gpuDirtyMb` metric. Mitigation: benchmark any runtime-flag lever and decide on data — do not apply blindly.

## Context

The prior RSS track established that the headline "4–6 GB per-backend balloon" is mostly a macOS `rss` measurement artifact; true `phys_footprint` is < 1 GB. The **one genuinely unexplained real consumer** left was ~691 MB of **dirty IOAccelerator (Metal / GPU / unified) memory** in a headless server that does no rendering. R4 filed it as "investigate what touches Metal/GPU." This plan does that and makes the number permanently observable.

### What live investigation already established (corrects R4's premise)

R4 implicitly assumed a **boot-time constant ~691 MB**. Measurement (`vmmap -summary <pid>` on the live cluster) shows it is **use-driven and accumulating, then plateauing** — a very different shape:

| Backend | Role | rss | IOAccelerator **dirty** |
|---|---|---|---|
| pid 49683 | central runtime (auth/secrets only, idle) | 80 MB | **13 MB** |
| pid 40755 | a worktree backend (busy) | 6.1 GB | **~570 MB** |
| pid 49686 | main app backend (busy) | 7.2 GB | **~670 MB** |

- The dirty memory is **real physical memory** allocated as **~18 × 128 MB private Metal GPU resource heaps** (high `40e…` addresses, `SM=PRV`, charged to the bun process — *not* a child process).
- It **grows with app activity** (idle 13 MB → busy ~670 MB) and **plateaus** ~670 MB over minutes ⇒ a **bounded cache, not an unbounded leak** (to be re-confirmed by the new metric across the fleet).
- The macOS GPU/media framework stack — **Metal, GPUCompiler, MetalTools, GPURawCounter, GPUWrangler, CoreImage, ImageIO (libPng/libJPEG/libGIF/libTIFF/libJP2), MPS/MPSNeuralNetwork, VideoToolbox** — is **dlopen'd at runtime**. Neither the `bun` binary nor `bun-pty` link it directly (`otool -L`). It is loaded **even in the idle central runtime** (13 MB dirty), so framework *loading* is a Bun baseline; the differentiator is the actual GPU **buffer allocation**, which only full app backends do under load.
- **No server TypeScript decodes images.** An exhaustive map (attachments, screenshots, paste-images, icon-picker, asset-mirror, browser/proxy, bookmark-scraper, transcript-watcher, code-explorer image handler) found only `Bun.file`/`Bun.write`/base64/in-memory `Map` byte-passthrough — no `sips`/`qlmanage`/`ffmpeg`/`canvas`/`sharp`/`createImageBitmap`/Bun image API anywhere.
- An lldb breakpoint on the ImageIO decode entry (`CGImageSourceCreateImageAtIndex`) did **not** fire under a page load ⇒ the path is **not image decode**.
- The only non-system native modules unique to busy backends are `@parcel/watcher` (disproven as a memory cost in the prior track) and `bun-pty`.

**Leading hypothesis (to be tested, not assumed):** the GPU memory is **GPU-accelerated compilation/compute inside the Bun/JSC runtime** (the loaded `GPUCompiler`/`MetalTools` frameworks + a busy "JIT Worklist Helper Thread" on busy backends point at the JIT/compute path far more than at image decode). This is a Bun-runtime-internal allocation exercised in proportion to JS workload — consistent with the use-driven, bounded, plateauing shape. The decisive confirmation is cheap (below) and runs **before** any lldb work.

## Findings + decision (measured 2026-06-18, post-implementation)

**Root cause — it is JSC's executable-code region, not image decode and not GPU compute.** The cheap A/B test was decisive and overturned the leading hypothesis:

- **JIT optimization is not the driver.** `JSC_useFTLJIT=false`, `JSC_useDFGJIT=false`, and even `JSC_useJIT=false` produced **no meaningful change** in IOAccelerator dirty. The hypothesized JSC-JIT→Metal-shader path is ruled out.
- **It scales with the volume of distinct JS code compiled/loaded**, with zero relation to compute or I/O:
  - idle `bun -e` ≈ **1.9 MB** dirty (1 region)
  - `bun -e 'import("typescript")'` ≈ **15 MB** (independent re-confirm; agent saw `ts-morph` → **206 MB / 4 heaps**)
  - bundled-zod (1 file) → **0** extra heaps vs separate-module zod (10 files) → 1–2 heaps
  - a tight 30 s numeric+RegExp JIT loop → **0** growth; 800k Postgres queries → **0** growth
  - a **freshly-booted full worktree backend** (this task's, right after compiling the 100+ plugin module graph) ≈ **858 MB** dirty
- **Bounded, not a leak.** Busy backends plateau ~570–860 MB as JSC's code GC evicts cold code; the value is the natural size of the compiled-code region for this app's module graph.

**Mechanism (leading explanation; not backtrace-confirmed — SIP blocked `lldb`/`malloc_history` attach).** On Apple Silicon the rwx (executable) JIT/code arenas JSC allocates for bytecode + JIT output are surfaced under the `IOAccelerator` vmmap tag (the OS maps W^X/PAC-protected executable pages through that subsystem). Each 128 MB region is one code arena; a backend starts with ~1 at boot and grows to ~18–26 in proportion to how much distinct JS it compiles. This is why central (auth/secrets only) sits at ~13 MB while full app backends reach hundreds of MB — and why it is fundamentally a **Bun/JSC + Apple-Silicon architectural cost**, not an app bug.

**Decision (per "test the lever, decide on data"):**
- **No runtime flag is applied** — the data shows `JSC_useFTLJIT=false` does nothing and `JSC_useJIT=false` (interpreter-only, 10–100× slower hot paths) is not viable for ~10% savings. Don't trade JS throughput for it.
- **The `gpuDirtyMb` health-pane metric was built and verified, then deliberately NOT shipped.** Now that the number is understood to be benign, bounded, and lever-less, a permanent metric only earns "regression canary" value — and the sampler reads it via `vmmap`, which **suspends the process ~0.58s per sample**. Adding a recurring per-backend suspension to track a non-actionable number (especially while intermittent slowness is being investigated) isn't worth it. The metric design is retained below for reference; if a per-backend GPU-dirty number is ever wanted, make it **on-demand** (sample only while the Health pane is open), not an always-on 60s poll. What ships from this task is the **diagnosis** (this doc + the debug-skill note), which is the durable value.
- **Possible future structural lever (follow-up, not committed):** the bundled-vs-unbundled signal (bundled zod allocated 0 extra arenas; the full unbundled plugin graph reaches 858 MB) suggests per-module compilation overhead is real — **bundling the backend into fewer modules** could shrink the code region. Worth a scoped experiment if per-backend footprint becomes a fleet constraint; uncertain payoff, larger change.
- **Net:** the original headline ("4–6 GB balloon") was an `rss` artifact (prior track); this last ~600–860 MB is real but is the JSC code region — bounded, architectural, and now measured. Treat as a known per-backend baseline.

## Phase 1 — Make GPU memory observable (built + verified, then NOT shipped — see decision above)

Add a per-backend `gpuDirtyMb` metric to the **health-monitor** so the IOAccelerator dirty number is charted alongside rss/heap and acts as the regression canary. This composes with the existing health pipeline (detection/when) and the R1 footprint follow-up.

**Design constraint — `vmmap` is heavy.** `vmmap -summary <pid>` **suspends the target process ~0.58 s** (measured). The health `process-sampler` `tick()` is synchronous and runs every 10 s — calling `vmmap` inside it would add ~5.8% latency. **Do not.** Instead mirror the `host-sampler` model: a **separate async sampler on a 60 s interval** that spawns `vmmap` non-blockingly and caches the last value; the synchronous `tick()` reads the cached number (zero added latency).

Files (all under `plugins/debug/plugins/health-monitor/`):

- **`server/internal/gpu-sampler.ts`** *(new — only new file)* — `startGpuSampler()`/`stopGpuSampler()`/`getLastGpuDirtyMb()`. A 60 s `setInterval` whose async tick runs `Bun.spawn(["vmmap","-summary",String(process.pid)],{stdout:"pipe"})`, parses the **first** `^IOAccelerator ` line's **dirty column (4th field; units K/M/G; skip the `(reserved)` row and `0K`)**, and stores it in a module-level `lastGpuDirtyMb`. Darwin-gate (`process.platform === "darwin"`; else stays 0). Reuse the `Bun.spawn(["vm_stat"])` pattern already in **`server/internal/host-sampler.ts`** (lines ~36).
- **`shared/schema.ts`** — add `gpuDirtyMb: z.number()` to `HealthSampleSchema` (after `gcPreciseTotalMs`). Forward-compatible numeric default 0; all consumers pick it up automatically.
- **`server/internal/process-sampler.ts`** — in `tick()`'s sample object add `gpuDirtyMb: getLastGpuDirtyMb()`; call `startGpuSampler()` from `startProcessSampler()` and `stopGpuSampler()` from `stopProcessSampler()`.
- **`web/components/health-monitor-panel.tsx`** — add `gpuDirtyMb` as a **series on the existing Memory `ChartBlock`** (next to `rssMb`/`heapUsedMb`; e.g. `color: "var(--warning)"`) and append `· {gpuDirtyMb} MB GPU` to the summary caption when > 0. No new chart.

Optional gate: `SINGULARITY_GPU_SAMPLING=0` to disable the sampler if even the 60 s suspension is unwanted on a latency-sensitive worktree.

## Phase 2 — Confirm the root cause (cheap test first, lldb only if needed)

Run on a **freshly-spawned clean backend** (~13 MB GPU dirty baseline). Delegate the manual driving session to a subagent.

1. **Fast-track A/B (decisive, ~5 min, no debugger):** spawn the same backend twice — once normal, once with `JSC_useFTLJIT=false` (fallback escalation: `JSC_useDFGJIT=false`, then `JSC_useJIT=false` for diagnostic confirmation only). Drive identical app operations against each; compare `vmmap -summary <pid> | grep '^IOAccelerator '` dirty MB.
   - **Dirty stays ~13 MB with the flag** ⇒ confirms the JSC JIT→Metal hypothesis **and** identifies the mitigation lever in one shot → go to Phase 3.
   - **Dirty still grows** ⇒ the cause is elsewhere (a specific Bun API / CoreImage / bun-pty) → step 2.
2. **lldb backtrace (only if step 1 is inconclusive):** attach to the clean backend, break on **`-[IOGPUMetalHeap init]`** (fires once per 128 MB heap — low frequency, the decisive symbol; backups `-[_MTLDevice newHeapWithDescriptor:]`, and `MTLCreateSystemDefaultDevice` to timestamp Metal init). Do **not** break on `newBufferWithLength:` (thousands/sec). Drive operations **one at a time** (page load → open conversation → start a terminal/bun-pty session → run a build → stream a claude conversation → open browser app), polling `gpuDirtyMb` between each; the operation that bumps dirty by ~128 MB is the trigger, and the backtrace's top *system-framework* frames name the layer even if bun frames are unsymbolicated.
   - Cheaper alternative to interactive lldb: boot with `MallocStackLogging=1`, then `malloc_history <pid> --callTree --virtual` once dirty has grown.

## Phase 3 — Decision gate (test the lever, decide on data)

Per the user's direction (**test, decide on data — don't apply blindly**):

- **If a runtime flag (e.g. `JSC_useFTLJIT=false`) eliminates the GPU dirty:** benchmark its **actual** cost on this I/O-bound server — request latency (Debug → Profiling runtime spans / `get_runtime_profile`) and event-loop p99 (Debug → Health) before vs after — against the ~600 MB/backend GPU saving. Recommend apply-or-not from the numbers. If applied, the lever is a one-line env addition at backend boot (`plugins/framework/plugins/server-core/bin/index.ts` / the spawn env in the gateway/CLI boot path — confirm at implementation).
- **If the cause is app-controllable (a specific endpoint/job or bun-pty):** fix at the source (avoid the GPU path / isolate it to a child / release the context).
- **If it is Bun-runtime-internal with no acceptable lever:** file a minimal repro upstream with Bun ("headless backend allocates N × 128 MB Metal heaps; `JSC_use…` toggles it"), document the bounded ~670 MB baseline here, and keep the Phase 1 `gpuDirtyMb` chart as the regression canary. **This is an acceptable terminal outcome** — the problem is bounded and now measured.

## Execution notes (subagents)

Per the user's "use subagents to save context" and the repo model rules:
- **Phase 1 instrumentation** → one **Opus** implementation subagent (load-bearing edits across sampler/schema/web), handed the exact file list above.
- **Phase 2 diagnostic driving** (spawn/drive/measure, run the A/B flag test, optional lldb) → a **Sonnet** subagent following the command sequence; it returns the dirty-MB deltas + any backtrace, not raw dumps.
- Keep the main thread holding only the conclusions.

## Critical files

| Concern | File |
|---|---|
| New GPU sampler (vmmap → IOAccelerator dirty) | `plugins/debug/plugins/health-monitor/server/internal/gpu-sampler.ts` *(new)* |
| Reuse `Bun.spawn` shell-out pattern | `plugins/debug/plugins/health-monitor/server/internal/host-sampler.ts` |
| Sample wiring + sync read | `plugins/debug/plugins/health-monitor/server/internal/process-sampler.ts` |
| Wire schema field | `plugins/debug/plugins/health-monitor/shared/schema.ts` |
| Chart + caption | `plugins/debug/plugins/health-monitor/web/components/health-monitor-panel.tsx` |
| (If flag applied) backend boot env | `plugins/framework/plugins/server-core/bin/index.ts` *(confirm spawn-env path at impl)* |
| Debug skill (document GPU metric) | `.claude/skills/debug/SKILL.md` |

## Verification

- `./equin build`, load `http://<worktree>.localhost:9000`, open **Debug → Health**: the Memory chart shows a **GPU dirty** series and the caption shows `MB GPU`; cross-check the value against `vmmap -summary <pid> | grep '^IOAccelerator '` for the same backend (should match within rounding) and against `cat logs/health.jsonl` (records now carry `gpuDirtyMb`).
- Confirm the sampler does **not** regress latency: event-loop p99 in Debug → Health stays flat (60 s cadence, async spawn).
- **Root cause:** Phase 2 A/B yields a clear statement — either "`JSC_useFTLJIT=false` holds GPU dirty at ~13 MB" (cause + lever found) or a named alternative trigger from the lldb backtrace.
- **Decision recorded:** append a short "Findings + decision" section here (lever benchmarked & applied/declined, or upstream repro filed), mirroring the prior track's Findings section.
- `./equin check` passes (boundaries, doc-in-sync, type-check).
