# Host pools stop reserving CPU: a pool is a cardinality cap, not a claim on a budget

**Date:** 2026-09-09
**Category:** global (infra/host/host-admission + the five pool consumers + tooling/checks)
**Status:** plan
**Builds on:** [`2026-07-10-global-host-admission-unified-budget.md`](./2026-07-10-global-host-admission-unified-budget.md) (the registry + grant), [`2026-07-12-global-host-admission-memory-dimension.md`](./2026-07-12-global-host-admission-memory-dimension.md) (Stage 1 measurements; this doc resolves part of its Stage-2 framing)

## Context

`reservedCpuCost()` (`host-admission/core/internal/budget.ts:131-136`) subtracts
`size × cost.cpu` for every entry in `RESERVED_POOLS` unconditionally, at module eval. The
fleet's pool size `B` is whatever is left:

```
B = max(1, min(floor(18 − 8.5), floor(34.4e9 / 2.7e9))) = min(9, 12) = 9
```

So six pools that are almost never held permanently deflate the budget of the one thing that
actually fills the box. Two defects fall out of that, and the second is the real one.

**1. The same core is reserved twice.** `layout-harness/check/index.ts:193-196` runs
`ctx.grant.run(() => browserPool.run(...))` — it spends a unit of `B` *and* its pool's
`cpu: 1` was already subtracted from the ceiling that produced `B`. `push` avoids this with
`cost: { cpu: 0 }` (`server/internal/push.ts:11`), so the correct pattern already exists in the
table, but nothing makes it the only spelling and `PoolCost.cpu` — a bare number — cannot say
which of the two regimes it is in. A related hole: `layout-harness/check/index.ts:87-91`
re-spells `cost: { cpu: 1 }` at its `defineHostPool` call site instead of reading the table the
way `fork-gate`, `mutate-gate`, `host-read-pool` and `browser-fetch` all do, so the two can
drift with nothing to notice.

**2. Reserve-for-peak-always.** Even with the double count fixed, the model books each pool's
worst case forever.

### What the measurements say

The reservation is buying almost nothing, and it is priced as if it were buying a lot.

| Pool | Reserved | Times it ever waited (all recorded `slow_ops`) |
|---|---|---|
| `heavy-read` | 2.0 | 29 ops / 1.2M ms at the **host** tier — against 35M ms at its own **local** tier (29× more) |
| `worktree-mutate` | 1.5 | **2**, ever, since 2026-07-01 |
| `db-fork` | 2.0 | **1**, ever |
| `browser-fetch` | 2.0 | **0** — never appears |
| `layout-geometry` | 1.0 | **0** — no wait layer at all |
| `push` | 0.0 | — |

Hold durations are asymmetric by three orders of magnitude: a representative `heavy-read` hold
is **75 ms** (`boot-bench/load-generator.ts:10`, sized to a real `git diff`), while a build
holds its grant across the whole heavy section — **p50 137 s, p90 424 s, max 20 min** over the
last 67 builds (`build_runs`). We reserve capacity for the millisecond work and ration the
minute work.

### The finding that shapes the fix

**The 8.5-core reservation is currently the only thing holding the fleet ceiling below what the
RAM quantum permits.** `B` is 9 because CPU-reserved-subtraction won the `min()`; the RAM term
alone would say 12. So the reservation has been accidentally doing memory admission's job.

That matters because memory, not CPU, is what is actually binding on this box. Sampled over
~33 minutes on 2026-09-08: **58.6 GB used of 65.5 GB (p50), max fully full; compressor p50
4.2 GB / max 12.8 GB; decompressions peaking at 113k/s** — live compressor thrash, the same
mechanism as the 2026-07-11 freezes. Meanwhile load average p50 was 16.2, already above the
17.5 the CPU model believes it admits, because most of what runs on this box is not admitted at
all (16 backends, agent sessions, editors).

Deleting the reservation naively would therefore raise the concurrent-worker ceiling 33% on the
axis that is already saturated. **The CPU cleanup and the memory quantum are one change.**

### Intended outcome

- A host pool declares only how many holders of its kind may run at once. It makes no claim on
  a CPU budget, so double-counting has no spelling (rung 1 of the fix ladder — the wrong thing
  becomes inexpressible, not checked).
- The fleet ceiling `B` becomes a pure function of host facts and one measured constant, with
  no term drawn from the pool table. Adding or removing a pool cannot move it.
- **`B` stays exactly 9.** The change is deliberately throughput- and memory-neutral, so its
  effect is attributable and the cold-tail sizing question stays a separate, measured decision.

## Decisions (agreed with the user)

1. **Hold `B` at 9** by re-basing `PER_UNIT_BYTES`, rather than letting the freed capacity flow
   into the fleet (`B`→12) or sizing on the measured cold tail (`B`→6). The structural change
   lands with zero throughput or memory effect; the (a)/(b)/(c) sizing trade from the
   memory-dimension doc stays open, now unmasked.
2. **Build-vs-build fairness stays out of scope.** A build acquires `max: cpuBudget().B` — the
   whole pool — and holds it for the entire heavy section, so a second build waits the first
   out rather than interleaving (this is the "a contended build once sat here ~5 min,
   unattributed" comment at `app-artifacts.ts:1012`). Real, but a separate pathology; fixing it
   properly means per-child weighted acquisition, which the flock primitive cannot express
   all-or-nothing and which needs its own deadlock argument. File as a follow-up.

## The model

**A host pool is a cardinality cap on a kind of work. The only thing being budgeted is the
elastic fleet, and its constraint is memory.**

The two questions `cost.cpu` was answering at once come apart:

- *How many concurrent holders of this kind may exist?* — a mutual-exclusion / anti-stampede
  bound (one Chromium, two forks). Stays, as `size`. It was never really about cores.
- *How much of the box must be permanently withheld so this pool never queues?* — deleted. The
  evidence says these pools do not queue, and their holds are milliseconds.

What remains bounded is the type-check/vite fleet, because it is the only holder that both
fills the box and can shrink. Its budget is `PER_UNIT_BYTES` against `hostRamCeiling()` — one
constant, one ceiling, nothing else subtracting from it.

### The constant

`B = 9` requires `floor(34359738368 / Q) === 9`, i.e. `Q ∈ (3.436e9, 3.818e9]`.

**`PER_UNIT_BYTES = 3.6e9`** — `34.36e9 / 3.6e9 = 9.544`, near the centre of that interval
(0.54 above the `B=9` boundary, 0.46 below `B=10`), so a small change in host memory or the
ceiling fraction cannot flip `B`. Note `3.8e9` would also give 9 but sits **0.04** from
flipping to 8 — do not use it.

It is also better justified than the constant it replaces. Measured cold peaks across the 7
real tsc targets (`budget.ts:37-44`): web-core 5.3, test 5.1, server-core 3.9, central-core
3.8, tooling 1.8, cli 1.2, tools 1.0 GB — **mean 3.16 GB, fleet total 22.1 GB**. The old
`2.7e9` sat *below* the cold mean; `3.6e9` sits above it with ~14% headroom, still below the
5.3 GB cold tail. The tail question (`5.3e9` ⇒ `B = 6`) remains open and is called out as such.

## Design

### 1. `core/internal/budget.ts` — delete the reservation

- **Delete `PoolCost`** (and its `cpu` / `ramBytes` fields) and its `core/index.ts` export.
- **Delete `reservedCpuCost()`**, and the `hostCpuCeiling() − reserved` term.
- **Rename `RESERVED_POOLS` → `HOST_POOLS`**, `ReservedPoolSpec` → `HostPoolEntry`, and reduce
  the entry to `{ size: number }`. The old name would be a lie once nothing is reserved, and
  "one name per concept" (api-design skill) makes the rename part of the change, not churn.
  **All six keys stay** — `data-dirs/index.ts:27-30` derives the `locks/<id>` declarations from
  them, and dropping a key would un-declare its lock dir and make
  `paths:no-undeclared-data-dirs` (`paths/check/index.ts:505`) report the on-disk directory as
  an orphan.
- **`rawCpuResidual()` → `rawFleetCeiling()`**, now `min(hostCpuCeiling(), floor(hostRamCeiling()
  / PER_UNIT_BYTES))`. `cpuBudget()` is otherwise unchanged, including the `max(1, …)` floor and
  the small-host lane collapse (`backgroundLimit = max(1, B − reservedInteractive)`), which a
  4-core VPS still needs.
- **Re-base `PER_UNIT_BYTES` to `3.6e9`** and rewrite its doc comment (below).

### 2. `server/` — a pool has no cost

- `internal/pool.ts`: drop `cost` from `HostPoolSpec` (`:109`) and `HostPool` (`:78`), drop the
  `PoolCost` import (`:9`), drop `cost: spec.cost` (`:194`). The re-definition mismatch guard
  (`:134-139`) compares **`size` only** — the message loses its `/ cpu N` half.
- `internal/grant.ts:24-30`: the `cpu` pool loses `cost: { cpu: 1, ramBytes: PER_UNIT_BYTES }`.
  Nothing reads `ramBytes` (verified repo-wide), and `PER_UNIT_BYTES` remains the thing that
  sizes `B` — so the RAM fact gains one home instead of being duplicated as a decorative field.
- `internal/push.ts:8-12`: drop `cost: { cpu: 0 }`. Its whole reason to exist is gone.

### 3. The five consumers — destructure `size` only

Same one-line pattern at each; the surrounding comments that say "size **and CPU cost** are
declared ONCE … so this pool and the `host-budget` check read the SAME numbers" need their
cost half removed (they stay true about `size`):

- `database/admin/server/internal/fork-gate.ts:28`
- `infra/host/host-read-pool/server/internal/pool.ts:16`
- `infra/safe-fetch/browser-fetch/server/internal/pool.ts:16`
- `infra/worktree/server/internal/mutate-gate.ts:31`
- `debug/profiling/boot-bench/server/internal/load-generator.ts:60-64` — drops `cost:` entirely

And the one that was drifting:

- `primitives/css/layout-harness/check/index.ts:87-91` — `defineHostPool({ id:
  "layout-geometry", size: HOST_POOLS["layout-geometry"].size })`, matching its four peers, so
  the table and the call site can no longer disagree. Its `:84-86` comment about "two different
  guarantees" is now simply true: the pool is the mutual exclusion, `ctx.grant.run` is the one
  and only charge.

### 4. `host-budget` — repoint, don't delete

Its current assertion evaporates. With no reserved term, `rawFleetCeiling()` can only fall
below 1 when the host has less than one quantum of usable RAM (a 2-core / 4 GiB VPS gives
`raw = 0`) — and that is "this box is smaller than one worker", not "the pools overcommitted
the ceiling". The existing `max(1, …)` floor and lane collapse already handle it and are kept.
So the check's overcommit reading is gone: nothing a pool declares can push `B` anywhere.

Deleting the check outright would weaken the structural bar — `host-pools-declared` stops
`createHostSemaphore` being imported outside `host-admission`, but nothing would then stop a
seventh pool being declared at `size: 50`.

Keep the id (many call-site comments name it) and re-point it at the property that *can* still
fail — a **cardinality** bound:

```
Σ (every pool's size) + B  ≤  hostCpuCeiling() × MAX_OVERSUBSCRIPTION
```

with `MAX_OVERSUBSCRIPTION = 2`, declared and commented as a **stampede bar, not a core
model**: admitted holders are not all CPU-saturating (heavy-read and worktree-mutate are
IO-bound, push waits on the network), and the box runs far more un-admitted work than admitted
work, so pretending to schedule cores here would be false precision. Today: `13 + 9 = 22 ≤ 36`,
passing with room, and a `size: 50` pool trips it.

The check keeps its current tree scope and needs no `cacheSignature()`: like today it reads the
in-tree table plus `os.cpus()`, and the `scope !== "tree" ⇒ cacheSignature` invariant
(`tooling/core/types.ts:117-126`) is therefore not engaged.

Update `host-budget/CLAUDE.md`; the `checks/CLAUDE.md` registry entry is a name-only
autogenerated line, so keeping the id means no churn there.

### 5. The `PER_UNIT_BYTES` comment

The existing comment (`budget.ts:32-77`) is load-bearing — it carries the cold-vs-warm
measurement and a warning against ad-hoc re-tuning. It must be rewritten rather than patched,
because the constant's job changes: it is no longer one of two terms in a `min()` with a
reservation quietly holding the result down, it is **the whole fleet budget**. The rewrite must
say:

- what the constant now solely determines (`B`, hence every concurrent heavy worker host-wide);
- that `3.6e9` was chosen to (i) hold `B` at 9 across the reservation's removal and (ii) sit
  above the measured 3.16 GB cold mean, and that it is centred in the interval that yields 9 so
  small host changes cannot flip it;
- that the cold **tail** is 5.3 GB and `B` therefore still models a mean, with `5.3e9 ⇒ B = 6`
  the open Stage-2 option, per the memory-dimension doc;
- that nothing else subtracts from the ceiling any more, so a future change here moves the
  fleet ceiling directly and visibly;
- that `3.6e9` is **not a fresh measurement** — it is chosen to land the memory-only formula on
  the `B` the old formula produced, so this change stays structural rather than becoming a
  re-tuning in disguise;
- that Stage 2's proposed `reservedRamCost()` mechanism no longer has a `reservedCpuCost()` to
  mirror (see Out of scope).

### 6. Docs

`host-admission/CLAUDE.md` — the "One ceiling, two dimensions" section, the reserved table, the
`B` formula, and the whole "RAM dimension is a forward hook" block (which exists to warn against
an unsound `Σ ramBytes` assertion that no longer has a field to sum). Also
`host-read-pool/CLAUDE.md:32`. `./equin build` regenerates `docs/plugins-*.md`;
`plugins-doc-in-sync` covers the drift.

## Files

| File | Change |
|---|---|
| `host-admission/core/internal/budget.ts` | delete `PoolCost`/`reservedCpuCost`; `RESERVED_POOLS`→`HOST_POOLS` (size-only); `rawCpuResidual`→`rawFleetCeiling`; `PER_UNIT_BYTES` → `3.6e9` + rewritten comment |
| `host-admission/core/index.ts` | drop the `PoolCost` / `reservedCpuCost` / `rawCpuResidual` exports; rename the table export |
| `host-admission/server/internal/pool.ts` | drop `cost` from spec, handle and mismatch guard |
| `host-admission/server/internal/grant.ts` | `cpu` pool loses `cost` |
| `host-admission/server/internal/push.ts` | drops `cost: { cpu: 0 }` |
| `host-admission/data-dirs/index.ts` | table rename only (keys unchanged) |
| `database/admin/…/fork-gate.ts`, `host-read-pool/…/pool.ts`, `browser-fetch/…/pool.ts`, `worktree/…/mutate-gate.ts` | destructure `size` only; comments lose their cost half |
| `boot-bench/…/load-generator.ts` | drop `cost:` |
| `css/layout-harness/check/index.ts` | read `HOST_POOLS["layout-geometry"].size` instead of re-spelling `size`/`cost` |
| `checks/plugins/host-budget/check/index.ts` + `CLAUDE.md` | re-point to the cardinality bound |
| `host-admission/CLAUDE.md`, `host-read-pool/CLAUDE.md` | prose |
| `css/layout-harness/CLAUDE.md:185` | the snippet quotes `defineHostPool({ id: "layout-geometry", size: 1, cost: { cpu: 1 } })` — update to the new call |
| `type-check/check/index.ts:202`, `build/cli/internal/app-artifacts.ts:275` | comments only: both hardcode "2.7e9" in prose as the calibration reference; re-state as `3.6e9` |
| `host-admission/core/internal/budget.test.ts` | **new** — the B-independence test (below) |

`checks/CLAUDE.md`'s registry entry is a name-only autogenerated line and the check keeps its
id, so it needs no edit. The check is also registered in the generated
`checks/core/check.generated.ts` — another reason repointing beats deleting.

`plugins/infra/plugins/paths/core/internal/legacy-layout.ts` hand-lists the seven pool lock
dirs and is **deliberately untouched**: no pool id changes, so its list stays correct.

## Order of work

1. `core/internal/budget.ts` + `core/index.ts` (types and constant), with the new test.
2. `server/` (pool, grant, push) — `tsc` now names every consumer that must change.
3. The five consumers + `layout-harness`.
4. `host-budget` re-point.
5. Docs, then `./equin build`.

Steps 1–3 are one `tsc`-guided sweep; there is no intermediate state where the tree compiles
with a half-removed field.

## Verification

**`B` is unchanged, and no longer reads the pool table.** New unit test in a new
`core/internal/budget.test.ts` — not in `grant.test.ts`, whose tests drive the real flock pool;
`budget.ts` is pure `node:os` arithmetic and deserves its own suite. Host-fact-independent, so
it passes on any box:

```ts
// B is a pure function of host facts and the quantum — nothing from the pool table.
expect(cpuBudget().B).toBe(
  Math.max(1, Math.min(hostCpuCeiling(), Math.floor(hostRamCeiling() / PER_UNIT_BYTES))),
);
```

Re-adding a `cost` field is a `tsc` error (rung 2), so it needs no test of its own.

**No migration fence — and this is the point of holding `B` at 9.** A pool's `size` names its
flock slot *files*, so previous rollouts needed a drain window. Here every pool's size is
unchanged (`cpu` stays 9, the six others keep their sizes), so the slot sets on disk are
identical and a pre-change process and a post-change one contend for the same files. Confirm
after building: `ls ~/.singularity/locks/cpu/` still shows `slot-0 … slot-8` plus
`turnstile.lock` and the `9:6` size sentinel.

**Regression gates that must pass unmodified** — the whole of
`packages/host-semaphore/…/host-semaphore.test.ts` (cross-process serialization, the seven
`acquireShare` tests, the four reserved-floor lane tests, the stranding/SIGKILL/orphan
crash-safety tests, the size-identity and legacy-sentinel tests, the six cancellation tests) and
all four existing `grant.test.ts` tests. None of them read `cost` or the pool table, so a
change to any of them means the sweep went wider than intended.

```bash
./equin test plugins/packages/plugins/host-semaphore
./equin test plugins/infra/plugins/host/plugins/host-admission
./equin check host-budget
./equin check host-pools-declared
./equin check paths:no-undeclared-data-dirs   # lock dirs still declared
./equin check                                  # type-check + plugins-doc-in-sync
```

**Live.** `./equin build` in this worktree, then:

- the fleet still runs at most 9 concurrent workers —
  `pgrep -fl 'type-check/shared/worker.ts' | wc -l` never exceeds 9 during the run;
- the build's own line still reports the same grant width it did before the change;
- all seven pools still report through `hostOccupancy()` (Debug → the host-gate rows), i.e. no
  pool lost its gauge along with its `cost`;
- `~/.singularity/locks/` still holds exactly the seven declared directories.

## Out of scope

- **Build-vs-build fairness** (the greedy `max: cpuBudget().B` acquire held across the whole
  heavy section). Decided above; follow-up task.
- **Per-child / weighted acquisition.** The honest way to express the measured bimodal worker
  footprint (web-core 5.3 GB vs tools 1.0 GB) is a per-class weight, which requires
  all-or-nothing weighted acquire — a primitive the flock pool does not have, with a real
  deadlock surface (two workers each holding part of what the other needs). Named here so the
  next reader knows why the uniform quantum survives.
- **Re-sizing on the cold tail** (`5.3e9 ⇒ B = 6`). Unmasked by this change, not taken by it.
  Note for whoever picks it up: the memory-dimension doc's Stage-2 §2.1 proposed a
  `reservedRamCost()` *mirroring* `reservedCpuCost()`, and this change deletes the thing it
  would mirror. The open **question** (mean quantum vs cold tail vs per-class weights) survives
  intact; its proposed **mechanism** does not, and needs re-deriving against the memory-only
  formula. The `PER_UNIT_BYTES` comment must say so, so nobody implements a design whose
  foundation is gone. Research docs are historical records here, so that doc is not edited.
- **The lane floor.** `reservedInteractive = max(1, floor(B/3)) = 3` is still a permanent
  withholding — but on the *fungible* axis, shared by every latency-sensitive holder, so unlike
  a per-kind reservation it is occupied whenever anything urgent runs. Kept unchanged.
- **Unifying `Lane` with `runtime-profiler`'s `OriginClass`.** Same partition at two layers;
  still blocked by the cycle the 2026-07-10 ADR named.
