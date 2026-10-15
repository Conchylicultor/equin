import { cpus, totalmem } from "node:os";

// Runtime-agnostic host-admission arithmetic — pure `node:os` reads, NO `bun:ffi`
// — so the server pools, the budget check, and (later) the CLI all share ONE
// definition of the host ceilings and the fleet budget.

/**
 * Which half of the host a holder belongs to. Interactive work has a human
 * blocked on it; background work does not. Admission partitions a laned pool's
 * capacity along this axis (the reserved floor). Only the CPU pool is laned
 * today; the wiring lands in a later step.
 */
export type Lane = "interactive" | "background";

/**
 * One type-check-class worker's resident set — the RAM quantum, and since
 * 2026-09-09 the ONLY term that sizes the elastic fleet.
 *
 * **This constant alone determines `B`**, hence how many heavy workers (tsc,
 * vite, a nested check's children) may run at once across every backend on the
 * box. Nothing subtracts from the ceiling any more — host pools declare a
 * cardinality cap and make no claim on a budget — so a change here moves the
 * fleet ceiling directly and visibly, with nothing else to hide behind.
 *
 * **`3.6e9` is not a fresh measurement.** It is chosen so the memory-only
 * formula lands on the `B` the old reserved-subtraction formula produced
 * (`floor(34.36e9 / 3.6e9) = 9`), which is what keeps the removal of the CPU
 * reservation structural rather than a re-tuning in disguise. `B = 9` holds for
 * any quantum in `(3.436e9, 3.818e9]`, and `3.6e9` sits near the centre of that
 * interval — 0.54 above the `B = 9` boundary, 0.46 below `B = 10` — so a small
 * change in host memory or in the ceiling fraction cannot flip it. (`3.8e9` also
 * gives 9 but sits 0.04 from flipping to 8; do not use it.)
 *
 * It is nonetheless better justified than the `2.7e9` it replaces. **First
 * measured 2026-07-12** (Stage-1 instrumentation; before that the constant was
 * inherited, never observed). The headline finding is that this class has NO
 * single value — a worker's peak swings up to **3×** on whether tsc's
 * `.tsbuildinfo` is warm:
 *
 * | worker      | warm   | cold   |
 * |-------------|--------|--------|
 * | web-core    | 2.1 GB | 5.3 GB |
 * | test        | 1.9 GB | 5.1 GB |
 * | server-core | 1.3 GB | 3.9 GB |
 * | central-core| 1.3 GB | 3.8 GB |
 * | **8-worker fleet total** | **9.4 GB** | **22.6 GB** |
 *
 * **Size on COLD.** A fresh agent worktree has no `.cache/tsbuildinfo`, so its
 * first build is cold — and a fleet burst (many agents building at once) is
 * therefore dominated by cold builds. That is exactly the regime that thrashed
 * the host on 2026-07-11. Sizing on warm numbers would be sizing for the case
 * that never hurts.
 *
 * Against cold, across the 7 real tsc targets (web-core 5.3, test 5.1,
 * server-core 3.9, central-core 3.8, tooling 1.8, cli 1.2, tools 1.0 GB): the
 * **mean** is 3.16 GB and `2.7e9` sat *below* it, while `3.6e9` sits above it
 * with ~14 % headroom. But the **tail** (5.3 GB) is still ~1.5× the quantum — so
 * `B × PER_UNIT_BYTES` models the MEAN and carries no tail headroom, and ONE
 * cold build's 8-worker fan-out (~22.6 GB) is already 66 % of
 * `hostRamCeiling()`. Whether to (a) raise the quantum to the tail (`5.3e9` ⇒
 * `B = 6`, a large throughput cost), (b) keep a mean quantum and reserve
 * headroom, or (c) replace the uniform quantum with per-class weights, is the
 * open Stage-2 question in
 * `research/2026-07-12-global-host-admission-memory-dimension.md` — do NOT
 * re-tune this ad hoc. Option (c) now has a spelling: a consumer whose measured
 * peak exceeds this quantum declares a multi-unit weight through `grant.run(fn,
 * { units })`, so the quantum stays the mean and the tail is paid where it is
 * measured.
 *
 * One caveat for whoever picks that up: Stage 2 §2.1 proposed a
 * `reservedRamCost()` **mirroring** `reservedCpuCost()`, and the latter no longer
 * exists — pools reserve nothing, so there is no reserved term to carve a RAM
 * twin out of. The question survives intact; its proposed mechanism does not, and
 * needs re-deriving against this memory-only formula. See
 * `research/2026-09-09-global-host-pools-stop-reserving-cpu.md`.
 *
 * Note `vite` (3.0e9–3.5e9) also fits inside this quantum, but a build runs
 * exactly ONE vite and MANY workers — so the count asymmetry means the worker
 * distribution, not vite, governs the fleet's memory.
 *
 * Units are DECIMAL bytes — the `maxRSS` log lines that calibrate it are decimal
 * too (a GiB/GB mismatch here silently understates the true peak by ~7 %).
 */
export const PER_UNIT_BYTES = 3.6e9;

/** Host CPU ceiling: one admission unit per logical core. */
export function hostCpuCeiling(): number {
  return cpus().length;
}

/** Host RAM ceiling for admission: half of physical memory. */
export function hostRamCeiling(): number {
  return totalmem() * 0.5;
}

/** One host pool's declared admission footprint. */
export interface HostPoolEntry {
  /** Number of host-wide slots (flock files) — a pure function of host facts. */
  size: number;
}

/**
 * The non-CPU host pools, declared ONCE here so the pools themselves and the
 * `host-budget` check read the *same* numbers, and so `data-dirs/index.ts` can
 * derive one `locks/<id>` declaration per entry.
 *
 * **A size is a cardinality cap, not a claim on a budget.** It answers only "how
 * many holders of this kind may exist at once" — a mutual-exclusion /
 * anti-stampede bound (one Chromium, two forks). It withholds nothing from the
 * fleet: `B` is computed from host facts alone and cannot move when a pool is
 * added, removed or resized. That is what makes double-counting inexpressible —
 * a caller may hold a pool slot AND spend a CPU grant unit, and neither has been
 * paid for twice. See
 * `research/2026-09-09-global-host-pools-stop-reserving-cpu.md`.
 *
 * Sizes are pure functions of stable host facts (never env-overridable — the size
 * names the flock slot-file set, so it must be identical in every backend),
 * matching the formulas the pools themselves size to.
 */
export const HOST_POOLS = {
  "heavy-read": { size: Math.max(1, Math.floor(hostCpuCeiling() / 4)) },
  "worktree-mutate": { size: Math.max(2, Math.floor(hostCpuCeiling() / 6)) },
  "db-fork": { size: 2 },
  // A headless-Chromium page render. `size` is a CONSTANT (like `db-fork`, unlike
  // the `cpus()`-derived pools): a browser launch costs roughly the same on every
  // box, and the size names the flock slot files, so it must be identical in
  // every backend.
  "browser-fetch": { size: 2 },
  "layout-geometry": { size: 1 },
  push: { size: 1 },
  // One repo-program type-check worker (7–14 GB resident). The CPU grant
  // cannot bound these: its 2-unit weight clamps to each holder's own share, so
  // up to `B` holders ran one each — 2–4 at once on 2026-10-14, the box in
  // memory duress, every warm worker burning 718–2211 CPU-s instead of 29–162.
  // Two is what fits beside everything else on the 64 GB box that measured it;
  // a CONSTANT (like `db-fork`), because the size names the slot files. The
  // owner lanes it (background may use 1, the interactive lane — the push
  // holder, main — keeps the other). See
  // research/2026-10-15-global-push-typecheck-lane-priority-and-cap.md.
  "type-check-worker": { size: 2 },
} as const satisfies Record<string, HostPoolEntry>;

/**
 * The fleet's ceiling BEFORE the `≥ 1` floor: the smaller of the host's cores and
 * how many worker-sized resident sets fit in `hostRamCeiling()`. Memory is what
 * actually binds on this box, so the RAM term is normally the winner.
 *
 * Nothing from the pool table enters here. A value `< 1` therefore means only
 * that the host has less than one quantum of usable RAM — "this box is smaller
 * than one worker", not "the pools overcommitted the ceiling" — which the `max(1,
 * …)` floor in `cpuBudget()` handles.
 */
export function rawFleetCeiling(): number {
  return Math.min(
    hostCpuCeiling(),
    Math.floor(hostRamCeiling() / PER_UNIT_BYTES),
  );
}

/** The CPU pool's derived size and its interactive/background lane split. */
export interface CpuBudget {
  /** CPU pool size — the fleet ceiling, floored to `≥ 1` so a holder always gets a slot. */
  B: number;
  /** Reserved interactive floor — high slots background work can never take. */
  reservedInteractive: number;
  /** Background lane window: `B − reservedInteractive`. */
  backgroundLimit: number;
}

/**
 * The CPU pool size `B` is the whole elastic fleet: `B = max(1,
 * min(hostCpuCeiling, floor(hostRamCeiling / PER_UNIT_BYTES)))`. The reserved
 * interactive floor is `max(1, floor(B / 3))`; the background lane gets the rest.
 *
 * **Small hosts (`B === 1`) collapse the lane split.** On a host with less than
 * two workers' worth of usable RAM — a 4-core/8 GB VPS, i.e. any target the
 * release artifact ships to — `rawFleetCeiling()` is 1 (or 0), `B` floors to 1,
 * and the reserved interactive floor claims that one slot, leaving the background
 * lane a window of 0. That is not a budget, it is a deadlocked pool, and
 * `defineHostPool` (rightly) refuses to build it — which made the whole app
 * unbootable on such a host rather than merely slow. With a single slot there is
 * nothing to partition: the honest degenerate is one shared slot, so the
 * background window floors to 1 and the pool behaves as unlaned. The reserved
 * interactive floor only becomes meaningful again at `B >= 2`.
 */
export function cpuBudget(): CpuBudget {
  const B = Math.max(1, rawFleetCeiling());
  const reservedInteractive = Math.max(1, Math.floor(B / 3));
  const backgroundLimit = Math.max(1, B - reservedInteractive);
  return { B, reservedInteractive, backgroundLimit };
}
