# CLI op wedge — root cause: a memory-pressure death-spiral of the checks pass

**Supersedes the root-cause verdict of all three prior docs** (read them for the
investigation trail, not the conclusion):
- [`2026-07-19-global-cli-op-wedge-investigation-state.md`](./2026-07-19-global-cli-op-wedge-investigation-state.md)
- [`2026-07-20-global-cli-op-wedge-capture-watchdog.md`](./2026-07-20-global-cli-op-wedge-capture-watchdog.md)
- [`2026-07-21-global-cli-op-wedge-gc-sink.md`](./2026-07-21-global-cli-op-wedge-gc-sink.md) — its "subsystem = JSC GC" was one snapshot of the spiral, not the cause.

**Status: root cause identified.** The wedge is a **paging/GC death-spiral of an
oversized, concurrent working set built by the `runChecks` pass** — the
source-import scanners over the whole plugin corpus, plus type-check's TS
programs. It is **not** the in-process vite/rollup web-artifacts arm (a hypothesis
this session raised and then refuted), and it is a **death-spiral driven by host
memory pressure, not a pathological infinite loop**.

## The symptom (recap)

A `./equin {build,check,push}` op intermittently never exits: it spins ~1
core (state `R`), its heap balloons to 0.95–2.8 GB and pages to swap, and it holds
its host cpu-slots (`~/.singularity/cpu-slots/slot-N.lock`) — and for a push, the
global push mutex — for hours, serialising and starving every build+push on the
machine. First observed ~2026-07-17; a build/check regression.

## The decisive observation

Two specimens were live simultaneously on 2026-07-21:

- **pid 47482** — a `build` wedge (worktree `po60`): 90% core, 948 MB peak, **has
  an esbuild child** (vite spawns esbuild). This is the specimen whose esbuild
  child made the frontend arm look guilty.
- **pid 91220** — a `check --scope tree` wedge (spawned by a `push`, worktree
  `m0gj`): 95% core, 2.1 GB peak, **no esbuild / vite / child processes at all.**

A `check --scope tree` op runs **only checks** — there is no web-artifacts arm, no
rollup, no esbuild. Yet its `sample` hot stack is **byte-identical (by relative
offset) to the build specimen's**, both converging on the same recursive burner
frame (`…→0x8ecf40→0x43a040→0x1a2cc0→0x28591a8→0x25e9648→0x31716b8`, which
recurses). The same burner in a build **and** in a rollup-free check ⇒ the burn is
in code common to both = **the checks arm**. This refutes the web-artifacts/rollup
hypothesis outright.

The earlier "it's the frontend/rollup pipeline" lead came from over-weighting the
`build` specimen (whose esbuild child is a red herring — vite spawns it but it
sits idle at 0% CPU) and not yet having a check-only specimen to compare against.

## Root cause — the causal chain

1. **`runChecks` fans out ~71 checks concurrently** with no memory admission:
   `results = await Promise.all(selected.map(async (check) => …))`
   (`plugins/framework/plugins/tooling/plugins/checks/core/runner.ts:304`). Nothing
   bounds how many memory-heavy checks build their working set at once, so their
   peak footprints **sum**.
2. **Several checks each build a large working set over the entire plugin corpus**
   (hundreds of files):
   - The source scanners `findImports`
     (`plugins/plugin-meta/plugins/parse-utils/core/find-imports.ts:70`) and
     `findMarkerCalls` (`…/parse-utils/core/find-marker-calls.ts:136`), and the
     recursive barrel-reachability walk `visit`/`collectReachableGenerated`
     (`checks/plugins/pre-barrel-manifests-complete/check/index.ts:78`), call
     **`maskSource`** on every file.
   - **`maskSource`** (`…/parse-utils/core/mask-source.ts:65`) does
     **`const out = src.split("")`** — allocating an N-element array of
     single-character strings *per file* — then a per-character regex `.test()`
     loop. This is the dominant allocation churn, run over the whole corpus.
   - `buildPluginTree({ facets: true })` (`…/plugin-tree.ts:391`) parses every
     plugin; facet `parseResources` on top.
   - The `type-check` check builds full TS programs; its **worker children reach
     3.0–3.2 GB each** (web-core 3.2 GB, test 3.0 GB, per a run's own log).
   - All of it sits on top of `readFileSync` (~26% of a heavy run's self-time).
3. **Because these run concurrently, the process (and its type-check children)
   balloon** to ~2 GB in the main process + ~3 GB per type-check worker.
4. **Add the fleet.** When several builds/checks run across worktrees at once,
   total demand exceeds physical RAM → macOS compresses/swaps → the
   `decompressionsPerSec` duress signal trips (the same signal the admission valve
   watches; see [`2026-07-11-global-fleet-memory-admission-duress-valve.md`](./2026-07-11-global-fleet-memory-admission-duress-valve.md)).
5. **The spiral.** Once the working set is paged to swap, the CPU-bound scan/GC
   touches swapped-out pages → constant major page faults → the process burns a
   full core doing almost nothing but faulting and garbage-collecting a 2 GB heap.
   It never completes → never exits → holds its cpu-slots (and the push mutex) for
   hours → **starves the fleet, which raises pressure further** — a positive
   feedback loop.

`vmmap` of the live specimen 47482 is the mechanism, caught in the act: **406 MB
swapped_out, ~370 MB resident, 948 MB peak footprint, 90% CPU.** Ballooned heap
paged out; core pinned faulting it back in. This also reconciles the prior docs'
apparent contradiction — one sample caught the main-thread scanner/walk, another
caught the JSC GC threads collecting the 2 GB heap. Same cause, different instants.

## Death-spiral, not pathological input

Evidence it is a memory-pressure spiral rather than an infinite loop:
- A faithful repro (`check --scope tree`, grant-bypassed, under `--cpu-prof`)
  **completed in 347 s at ~1.8 GB peak, all checks OK**, under the eased pressure
  present at repro time (host ~80% mem free, load ~6) — a heavy-but-surviving run
  on the same curve whose extreme is the wedge. No infinite loop for that content.
- The recursive `visit` walk is **cycle-guarded** (`visited` set) — bounded by
  construction, not an unbounded recursion.
- The live 47482 signature (406 MB-swapped + tiny resident + 90% CPU) is textbook
  paging thrash, not a hot compute loop over resident data.

## The Jul-17 regression, reframed

`1ee68a9c7` (Jul 16, "per-plugin web artifacts as the default frontend build")
made the frontend build run **in-process**, concurrently with the checks, in one
process. That is a **memory-pressure trigger/amplifier — not the CPU cause**: it
raised the build's summed main-process working set, so builds tip into swap more
often. Checks also wedge independently (the push→`check --scope tree` path,
specimen 91220), so the checks pass is separately vulnerable regardless of that
commit. Do not "fix" this by reverting the frontend arm alone — that reduces the
trigger rate but leaves the checks pass able to wedge on its own.

## What is proven vs. still open

**Proven (high confidence):**
- The burn is the **checks arm, not web-artifacts/rollup** (~95%) — identical hot
  stack in a rollup-free `check --scope tree` op.
- **Death-spiral, not a hard infinite loop** (~80%) — repro completed; recursion
  cycle-guarded; live swap-thrash confirmed by `vmmap`.
- **Top single allocator is `maskSource`'s `src.split("")` + per-char scan** driven
  by `findImports` / pre-barrel `visit` (~85%).

**Still open (the residual ~15–20%):**
- No symbolicated stack was captured **at the wedge instant**. bun 1.3.13
  `--cpu-prof` / `--heap-prof` **only flush on clean exit** (SIGINT/SIGTERM do
  **not** flush — verified), so a never-exiting wedge cannot be dumped that way.
  The named functions come from a heavy run that *completed*, not from a frozen
  one.
- A worktree-content-specific superlinear cost in `po60`/`m0gj` on top of the
  generic pressure is not fully excluded.
- Closing both requires catching a live wedge under `--inspect` while inducing
  controlled host memory pressure — deliberately **not** done here, because the
  box already had two wedged specimens pinning cpu-slots and was swapping;
  ballooning RAM to force a wedge risks worsening a live fleet. Gated on a human.

## Reproduction

`plugins/debug/plugins/op-wedge-watchdog/scripts/repro-check-wedge.ts` — a
standalone bun script (no repo imports, safe to run when things are broken). By
default it runs the `check --scope tree` pass with a **self-contained in-process
grant** (`SINGULARITY_HOST_GRANT`, so it does **not** contend for the host
cpu-slots a live wedge holds) under `--cpu-prof`, samples the process-tree RSS
each second, and on exit prints **peak RSS + the top self-time functions** parsed
from the `.cpuprofile`. This reproduces the heavy *working set* (~1.8 GB)
deterministically and names the allocators; use it to verify a fix **shrinks the
peak**. It does **not** by itself force a full wedge — see the script's header for
the (guarded, risky) escalation that does.

```
bun plugins/debug/plugins/op-wedge-watchdog/scripts/repro-check-wedge.ts
```

## Remediation directions (candidate fixes — none applied)

Fix the structural issue (unbounded summed working set), not one function:
- **Memory admission for checks.** Bound how many memory-heavy checks run
  concurrently (a memory-weighted gate in `runChecks`, not the current unbounded
  `Promise.all`), and/or don't co-schedule the in-process web-artifacts build with
  the checks when host RAM is tight (extend the duress valve to cover an op
  *already past* the grant, not just the pre-queue window).
- **Shrink the per-check working set.** Kill `maskSource`'s `src.split("")` (mask
  in place over the string / a typed buffer instead of an N-string array), and
  **cache/stream the masked-source corpus once** so ~71 checks don't each re-scan
  and re-mask the whole tree.
- **Bound type-check worker memory.** 3 GB per worker × N is the biggest absolute
  contributor; cap concurrency or `--max-old-space-size` per worker.

## Evidence / artifacts preserved

- Live-specimen forensics (both 47482 and 91220): `~/.singularity/op-wedge-captures.log`.
- Symbolicated CPU profile of a completing heavy `check --scope tree`:
  `…/scratchpad/checktree.cpuprofile` (Chrome DevTools) + `…/scratchpad/checktree.md`.
- `build-progress.jsonl` + `check-progress.jsonl` under `~/.singularity/`.

## Confidence

- Checks arm, not web-artifacts: **~95%.**
- Death-spiral, not infinite loop: **~80%.**
- `maskSource` `split("")` as the dominant allocator: **~85%** (from a completing
  run, not a captured wedge instant).
- Exact wedge-instant line: **not captured** — requires the gated `--inspect`
  under-pressure step.
