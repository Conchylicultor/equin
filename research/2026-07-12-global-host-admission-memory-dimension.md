# Host admission: closing the memory dimension (staged)

**Date:** 2026-07-12
**Category:** global (infra/host-admission + framework/cli + tooling/checks)
**Status:** plan
**Supersedes (in part):** [`2026-07-11-global-fleet-memory-admission-duress-valve.md`](./2026-07-11-global-fleet-memory-admission-duress-valve.md) Piece 1 — its whole-build *memory token* was dropped when the branch rebased onto main's host-admission registry ([`2026-07-10-global-host-admission-unified-budget.md`](./2026-07-10-global-host-admission-unified-budget.md), `f149097f8`). This doc re-lands the *intent* inside the new model.

## Context

Two full app freezes on 2026-07-11 were caused at origin by macOS **compressor thrash**: the
agent fleet's aggregate memory footprint fills the 64 GB host and the main backend — the ideal
paging victim — freezes. **The binding constraint is memory.** Fix direction 3 of
[`research/perfs/2026-07-11-compressor-thrash-subscription-replay-storm.md`](./perfs/2026-07-11-compressor-thrash-subscription-replay-storm.md)
("bound fleet *memory*, not just CPU/workers") is still marked **NOT built**.

The host-admission unification (`f149097f8`) landed a real improvement — the heavy build section
(checks + tsc + vite) is now gated by a host CPU grant, so the freeze-era "6 concurrent builds vs
a 4-slot pool" state is gone. But it bounds **CPU**, and it left three residuals:

| # | Gap | Status after triage |
|---|---|---|
| 0 | Phases outside the heavy grant (`bun install`, drizzle gen, atomic publish, restart + health probe) run under **no admission**; N builds stack them. | Real, but **unmeasured** and plausibly secondary. |
| a | The duress valve holds a build only **before** it queues for the grant; a trip while parked in the flock queue is not re-checked. | Real, cheap to close, **independent of sizing**. |
| b | Per-build peak RSS vs the 2.7 GB `PER_UNIT_BYTES` quantum is unreconciled. | The **load-bearing** gap — and the data to settle it does not exist yet. |

### The unifying finding: the memory dimension is half-wired

`PoolCost` (`plugins/infra/plugins/host-admission/core/internal/budget.ts:16-21`) declares
`ramBytes?: number`. Exactly one pool sets it (the `cpu` pool, `server/internal/grant.ts:28`).
**Nothing ever reads it** — verified by grep: zero property reads repo-wide. The `host-budget`
check sums only `cost.cpu`. The RAM that *is* accounted appears solely as a ceiling on the CPU
pool's own size:

```
B = max(1, min( floor(hostCpuCeiling − reservedCpuCost),      // floor(18 − 6.5) = 11
                floor(hostRamCeiling / PER_UNIT_BYTES) ))     // floor(34.4e9 / 2.7e9) = 12
  = 11
```

So the model has a memory *type* but no memory *budget*.

### Why the obvious fix is wrong

The tempting move — have `host-budget` assert `Σ(size × ramBytes) ≤ hostRamCeiling()` — is
**unsound**. `B` is *constructed* by the `min()` above to satisfy `B × PER_UNIT_BYTES ≤ ramCeiling`,
so that assertion is **tautological on its dominant term** and can never fail on its own. The
apparent "headroom" (34.4 − 11×2.7 = 4.7 GB) is *floor-rounding slack* from whichever term won the
`min()`, not a principled budget. Handing that slack to a new pool double-spends the ceiling: if the
CPU residual ever reached 12, the slack evaporates.

The sound formulation is **reserved-subtraction**, mirroring `reservedCpuCost()` — carve reserved
RAM out *before* the min term, so reserving build memory legitimately **pushes `B` down** (the
correct physical coupling: more concurrent whole-builds ⇒ fewer concurrent heavy workers). That is
Stage 2 below.

### Why we are not sizing anything yet

Measured `maxRSS` from real builds (`~/.singularity/worktrees/*/`, build-profile JSON + build.log):

| Heavy child | Measured peak | vs `PER_UNIT_BYTES` (2.7e9) |
|---|---|---|
| `vite build` | 2.8–3.3 GiB = **3.0e9–3.5e9 B** | **11–31 % over** |
| `tsc server-core` | 1.3 GiB | under |
| `tsc central-core` | 1.2 GiB | under |
| `tsc cli` | 422 MiB | under |
| **type-check worker** | **never measured** | — |
| `bun install`, drizzle gen, orchestrator | **never measured** | — |

Two facts make an immediate constant-bump indefensible:

1. **The process class `PER_UNIT_BYTES` names has never been measured.** The constant means "one
   type-check-class worker's resident set", but the worker spawn
   (`tooling/plugins/checks/plugins/type-check/check/index.ts:136`) does not call
   `proc.resourceUsage()`. Every sample above came from `--skip-checks` fast-path builds (runtime
   tscs), not the full-checks worker fleet.
2. **Count asymmetry.** A build runs **exactly one** `vite` but **many** tsc workers. Raising the
   uniform quantum to vite's peak over-charges the numerous class to cover the singular one. The
   under-count from vite is bounded by `(concurrent builds) × ~0.8e9 B` — material, not dominant.

Bumping `PER_UNIT_BYTES` on vite data alone would re-tune a verified-holding budget on the wrong
class, which the perfs method forbids. **We instrument the missing class first, then set the
constant from the real p95 mix.**

### A unit bug that would corrupt the calibration

`maxRssLine` (`cli/bin/commands/build.ts:256-261`) computes `maxRssBytes / 2 ** 30` (**GiB**) and
labels it **"GB"**, while `PER_UNIT_BYTES` is decimal (`2.7e9`). Anyone calibrating by reading
"3.3 GB" as `3.3e9` understates the true `3.54e9` by 7 %. Fix the unit before it is used as a
calibration input.

## Decisions (agreed with the user)

1. **Posture: staged / measured.** Stage 1 (instrumentation + the sizing-independent fixes) lands
   now. Stage 2 (the memory dimension proper) is **gated** on the Stage-1 data plus one validated
   fleet-burst episode. Rationale: the 03:29 freeze predates *both* the valve and host-admission
   stacks — there is **zero post-fix validation data**, and Stage 2's central constant
   (`BUILD_NONHEAVY_FOOTPRINT`) is currently a guess.
2. **Gap (a): close now** with a cheap post-acquire duress re-check. It is independent of all
   sizing and needs no primitive change.

---

## Stage 1 — measure the unmeasured, fix what needs no sizing (land now)

### 1.1 Capture `maxRSS` for the type-check worker fleet — *the load-bearing item*

`plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/index.ts:136`

```ts
const proc = Bun.spawn(demote([process.execPath, WORKER, jobPath]), { … });
// after `await proc.exited`:
const maxRssBytes = proc.resourceUsage()?.maxRSS;
```

Report it per worker the way build already does — one greppable line + the profiler span. This is
the class `PER_UNIT_BYTES` claims to size, and it has never been observed. **Without this number,
Stage 2 cannot be sized and the constant cannot honestly be re-tuned.**

### 1.2 Capture the remaining non-heavy phases (the gap-0 evidence)

- **drizzle-kit** — `cli/bin/migrations.ts:281` (`Bun.spawn(cmd, …)`): capture
  `proc.resourceUsage()?.maxRSS` and thread it onto the existing `generateMigration` build span
  (`build.ts:946-958`, currently `endSpan()` with no payload).
- **The build orchestrator itself** — its own peak RSS covers every in-process codegen phase
  (registry, manifest, composition, config propagation), none of which is a subprocess and none of
  which is currently visible. Sample `process.memoryUsage.rss()` at the end of the build and record
  it on the build profile.
- `bun install` already flows to the profiler span (`build.ts:877`); also persist its line into
  build.log so a calibration pass is one `grep`, not a JSON join.

The profiler sink already supports this — `maxRssBytes` is an optional field on a span
(`cli/bin/profiler.ts:15,30,39`). Only the **capture sites** are missing.

### 1.3 Fix the GiB/GB unit bug

`build.ts:256-261` — make `maxRssLine` consistent with the decimal `PER_UNIT_BYTES` (either divide
by `1e9` and keep "GB", or keep `2**30` and label "GiB"). Prefer decimal, to match the constant it
feeds.

### 1.4 Gap (a) — post-acquire duress re-check

`cli/bin/commands/build.ts:1022-1029`. Today: `holdThroughValve(...)` then `withHostGrant(...)`. A
build that entered the flock queue while the host was calm, and sat there while duress tripped,
walks straight into the storm. `withHostGrant`'s closure shape has no release-and-requeue seam — but
one is not needed. Wrap the acquire in a small retry loop **outside** the closure:

```ts
const gated = valveGates(lane, process.env);
for (;;) {
  await holdThroughValve({ gated });
  const result = await withHostGrant({ lane, max: cpuBudget().B }, async (grant) => {
    // Re-check INSIDE the grant: we now hold slots. If duress tripped while we were
    // parked in the flock queue, release them (return the sentinel) rather than start
    // the heavy section into a memory storm.
    if (gated && isUnderDuress()) return REQUEUE;
    return await runHeavySection(grant);   // the existing body, extracted
  });
  if (result !== REQUEUE) return result;
  // released by withHostGrant's finally; loop → hold at the valve again
}
```

Barging is already documented behaviour of the primitive, so there is no FIFO position to lose. The
loop terminates: the valve's `MAX_VALVE_HOLD_MS` (30 min) fail-open means `isUnderDuress()` cannot
hold it forever — after fail-open the valve returns immediately and the re-check is skipped, so add
the fail-open outcome to the loop's exit condition (do **not** re-check duress after a fail-open
hold, or the loop would spin). Extracting the existing heavy-section body into `runHeavySection(grant)`
is a pure refactor.

### 1.5 Document `ramBytes` as a forward hook

Until Stage 2 wires it, `PoolCost.ramBytes` is write-only. Say so in
`host-admission/CLAUDE.md` + a comment at `budget.ts:20`, naming this doc — so the next reader does
not mistake a declared-but-unsummed field for an enforced budget, or "fix" it with the unsound
`Σ ≤ ceiling` assertion.

### Stage 1 files

| File | Change |
|---|---|
| `plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/index.ts` | capture worker `maxRSS` (**the key measurement**) |
| `plugins/framework/plugins/cli/bin/migrations.ts` | capture drizzle-kit `maxRSS` |
| `plugins/framework/plugins/cli/bin/commands/build.ts` | thread drizzle RSS onto its span; orchestrator peak RSS; persist `bun install` line; fix `maxRssLine` units; extract `runHeavySection`; the gap-(a) re-check loop |
| `plugins/framework/plugins/cli/bin/admission-valve.ts` | expose the hold outcome so the loop can distinguish `cleared` from `fail-open` |
| `plugins/infra/plugins/host-admission/core/internal/budget.ts` | comment: `ramBytes` is a forward hook, unsummed (no behaviour change) |
| `plugins/infra/plugins/host-admission/CLAUDE.md` | same, in prose |

**No constant changes and no new pool in Stage 1.** `PER_UNIT_BYTES` stays `2.7e9` and `B` stays 11.

---

## Stage-1 RESULT — the worker fleet, measured for the first time

The instrumentation landed and immediately produced the number Stage 2 was blocked on. It also
**overturned the framing above**: the load-bearing gap is not the non-heavy phases (gap 0), it is
the heavy fleet's own memory, and the quantum has no tail headroom.

**The headline: a worker's peak swings up to 3× on whether tsc's `.tsbuildinfo` is warm.**

| worker | warm | **cold** | swing |
|---|---|---|---|
| `web-core` | 2.1 GB | **5.3 GB** | 2.5× |
| `test` | 1.9 GB | **5.1 GB** | 2.7× |
| `server-core` | 1.3 GB | **3.9 GB** | 3.0× |
| `central-core` | 1.3 GB | **3.8 GB** | 2.9× |
| `tooling` | 0.85 GB | 1.8 GB | 2.1× |
| `cli` | 0.80 GB | 1.2 GB | 1.5× |
| `tools` | 0.66 GB | 1.0 GB | 1.5× |
| `web-core-node` | 0.47 GB | 0.48 GB | 1.0× |
| **8-worker fleet total** | **9.4 GB** | **22.6 GB** | **2.4×** |

(Two independent runs first disagreed by ~2.4× on identical hardware; the controlled cold-vs-warm
experiment above is what reconciled them. Neither was wrong — they measured different regimes.
`SINGULARITY_CHECK_NO_CACHE=1` bypasses the tree-hash *check* cache but NOT tsc's `.tsbuildinfo`.)

### Three consequences

1. **Calibrate on COLD.** A fresh agent worktree has no `.cache/tsbuildinfo`, so its first build is
   cold — and a **fleet burst is therefore dominated by cold builds**. That is exactly the regime
   that thrashed the host on 2026-07-11. Warm numbers describe the case that never hurts.
2. **The quantum models the mean and has no tail headroom.** Against cold, `PER_UNIT_BYTES = 2.7e9`
   tracks the fleet *mean* (~2.8 GB) well, but the *tail* (5.3 GB) is ~2× it. `B × PER_UNIT_BYTES`
   is therefore a mean-estimate, not a bound.
3. **One cold build is already 66 % of the ceiling.** A single build's 8-worker fan-out peaks at
   ~22.6 GB against a 34.4 GB `hostRamCeiling()`. Add vite (~3.5 GB) and any second build and the
   box is over — which is precisely the observed failure.

### Gap 0, now measured: real, but secondary

The non-heavy phases were measured on the same build. They are **not** noise, but they are not the
binding term either:

| phase | maxRSS |
|---|---|
| `bun install` | 111 MB |
| `drizzle generate` | 335 MB |
| **`build orchestrator`** (all in-process codegen) | **1.8 GB** |
| — non-heavy total | **≈ 2.2 GB / build** |

The orchestrator dominates the non-heavy term (and note it is the *same* process that then holds
the grant, so its 1.8 GB is **concurrent with** its own workers, not sequential). So gap 0 is worth
~2.2 GB per concurrent build — ~6 % of the RAM ceiling each, real but an order below the 22.6 GB
cold fleet.

**Full cold single-build footprint: ~22.6 (workers) + 3.5 (vite) + 2.2 (non-heavy) ≈ 28 GB — about
80 % of the entire 34.4 GB host RAM ceiling, from ONE build.** That single number is the clearest
statement of why the box thrashes under a fleet burst, and it re-ranks the work: the heavy fleet is
the target, the `build` pool is a second-order cleanup.

## Stage 2 — the memory dimension (design; **gated**, do not build yet)

**The Stage-2 question is now sharper:** the uniform quantum is a *mean*, and the fleet's cold tail
is 2× it. Three ways to close that, in ascending cost:

- **(a) Raise the quantum to the cold tail** (`PER_UNIT_BYTES` → ~5.3e9 ⇒ `B` = `floor(34.4/5.3)` = 6,
  down from 11). Correct by construction, one line — but roughly **halves build concurrency**. The
  throughput cost is real and is a user decision, not an agent's.
- **(b) Keep a mean quantum, reserve explicit tail headroom** — i.e. lower `hostRamCeiling()`'s
  fraction, or add a fixed reserve. Cheaper on throughput, less principled.
- **(c) Replace the uniform quantum with per-class weights** (a worker declares its own footprint;
  `web-core`/`test` cost 2 units, `tools`/`web-core-node` cost ½). Most accurate, most machinery —
  and it is the honest model, since the measured distribution is bimodal, not uniform.

A cheap, high-leverage adjunct worth costing separately: **warm the `.tsbuildinfo` for a new
worktree** (seed `.cache/tsbuildinfo` from main at worktree-creation time). If a fresh worktree's
first build were warm, the fleet's cold peak would drop ~2.4× at a stroke — attacking the *cause*
of the tail rather than budgeting for it.

**Entry gate (revised):**

1. Cold-regime worker data from ≥ 10 real builds (use `SINGULARITY_CHECK_NO_CACHE=1` **and** clear
   `.cache/tsbuildinfo`, else you measure the warm case).
2. A decision from the user on the (a)/(b)/(c) throughput trade above.
3. Ideally, one fleet-burst episode observed with the current stacks live.

The **`build` pool + reserved-subtraction design below is retained but deprioritised** — consequence
3 says the heavy fleet, not the non-heavy tail, is what overruns the box.

### 2.1 Reserved-subtraction, not a summed assertion

`host-admission/core/internal/budget.ts` — mirror `reservedCpuCost()`:

```ts
export function reservedRamCost(): number {
  return Object.values(RESERVED_POOLS).reduce((s, p) => s + p.size * (p.cost.ramBytes ?? 0), 0);
}

export function rawCpuResidual(): number {
  return Math.min(
    Math.floor(hostCpuCeiling() - reservedCpuCost()),
    Math.floor((hostRamCeiling() - reservedRamCost()) / PER_UNIT_BYTES),  // ← RAM carve-out
  );
}
```

Now a pool that reserves RAM **pushes `B` down**, and `host-budget` gains a *real* convergence
property to assert (`rawCpuResidual() ≥ 1` already trips when the reserved pools eat the ceiling —
it simply becomes sensitive to RAM too). This makes `ramBytes` load-bearing instead of decorative,
and it is the one assertion that is **not** tautological.

### 2.2 The `build` pool — whole-build memory admission

```ts
defineHostPool({ id: "build", size: N, cost: { cpu: 0, ramBytes: BUILD_NONHEAVY_FOOTPRINT } })
```

- `cpu: 0` — it must not consume the CPU residual `B`; the heavy section's CPU grant is unchanged
  and stays heavy-section-scoped.
- `ramBytes` counts **only** the per-build memory *not already covered by the cpu pool's heavy
  children* — the orchestrator + `bun install` + drizzle. Measured in Stage 1. (This is why it is
  not byte-double-counting.)
- Acquired right after the per-worktree build lock (`build.ts:861`, before `bun install`), released
  in a `finally` after the health probe. Add `"build"` to `RESERVED_POOLS` so the budget sees it.
- The duress valve moves to gate **this** acquisition (the front of the build) rather than the CPU
  grant's.

**Deadlock: acyclic.** Every build acquires `build-slot` strictly *before* the cpu grant, so no
build ever holds a cpu slot while waiting for a build slot. The globally consistent rank
`build-pool < cpu-pool` is the textbook avoidance condition. flock auto-releases on process death,
preserving today's crash-safety.

**Known trade, stated honestly:** the build slot is held across `waitForPg`, `waitForWorktreeDatabase`,
publish, and restart + health-probe — phases whose real RSS is near zero. That reserves memory
admission (the *binding* axis) for a low-footprint tail. This is the same granularity trade the
superseded design accepted for its whole-build token. If the Stage-1 data shows the tail is long
relative to the heavy section, prefer gating a **tighter span** (build-lock → end of vite) over the
literal whole build.

---

## Verification

**Stage 1 (the only stage being built):**

- **Unit:** `bun test plugins/framework/plugins/cli` — new test for the gap-(a) re-check loop against
  injected valve deps (`ValveDeps` already exists for exactly this): duress trips *while parked* ⇒
  the grant is released and the build re-holds; a `fail-open` hold ⇒ the loop proceeds and does
  **not** spin. Existing `admission-valve` and `host-admission/grant` tests must pass unmodified.
- **Instrumentation lands (live):** run `./equin build` (full checks, so the worker fleet
  spawns) and confirm the build profile + build.log now carry `maxRSS` for: each type-check worker,
  drizzle gen, `bun install`, the orchestrator, vite. Before this change the worker + drizzle +
  orchestrator lines do not exist at all.
  ```bash
  grep -hoE '[A-Za-z][A-Za-z0-9 _./-]*: maxRSS [0-9.]+ (GB|GiB|MB)' \
    ~/.singularity/worktrees/*/logs/* | sort | uniq -c | sort -rn
  ```
- **Units are honest:** a child whose true peak is `3.54e9 B` prints `3.5 GB` (decimal), not
  `3.3 GB`.
- **No behaviour drift:** `./equin check host-budget` passes unchanged; `B` is still 11
  (`bun -e` printing `cpuBudget()`); a solo build's worker fan-out is unchanged.
- **Valve drill (live):** set the latch from the main worktree, start an agent build → it holds at
  the valve. Then: start a build while the host is **calm**, let it park in the grant queue, trip the
  latch → it must release its slots and re-hold rather than run the heavy section. This is the direct
  test of gap (a), which no existing test covers.

**Stage 2 gate:** the calibration pass itself — read ≥ 10 builds' `maxRSS` and record the p95 per
class in the perfs issue doc. That table *is* the artifact that decides whether Stage 2 is built, and
per the perfs living-doc rule it lands in the same turn as the data.

## Out of scope

- **Re-tuning `PER_UNIT_BYTES` in Stage 1.** Deliberate: the class it names is unmeasured until 1.1
  ships. Bumping it on vite data alone over-charges the numerous class to cover the singular one.
- **Main's exemption / reserved share.** Main takes the interactive lane, whose floor of 3 is
  unreachable by agent work. Unchanged.
- **Load-reactive admission** (admitting on live loop-lag / compressor readings). The static budget
  must be shown correct first; a feedback loop on a wrong ceiling is a worse ceiling. Same call as
  the host-admission ADR.
- **The compressor-thrash sentinel signal** (`decompressionsPerSec` as a duress input) — Piece 2/D6
  of the superseded doc, tracked separately; the valve consumes whatever trips the latch.
