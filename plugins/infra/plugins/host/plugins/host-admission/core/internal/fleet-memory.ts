import { z } from "zod";
import {
  cpuBudget,
  laneSplit,
  PER_UNIT_BYTES,
  thisHost,
  type HostFacts,
  type Lane,
} from "./budget";

// The fleet's MEASURED memory window: how many of the `cpu` pool's `B` slots the
// agent fleet may hold right now, given what the rest of the machine actually
// uses and what the fleet itself actually uses.
//
// `B` (budget.ts) is a static ceiling — half of RAM in `PER_UNIT_BYTES` quanta —
// and it is the most the fleet may EVER hold: it names the slot files. On its
// own it modelled a host where nothing but the fleet used memory, and a fleet
// whose only cost was the children it spends units on. Both were false on
// 2026-11-12 03:58–04:24: Chrome held 37.6 GB, the backends, agents and the rest
// another 23 GB, and the grant holders themselves (`build`, its nested `check`,
// a top-level `check`, a test) — charged nothing — were 3–4.5 GB each. The pool
// admitted "within budget" onto a host that was already out of memory.
//
// So admission counts every byte, two ways:
//
// - **The rest of the machine, by measurement.** `otherBytes` is the physical
//   footprint of every process that is not an agent op (Chrome, backends,
//   agents, Postgres, the agent browser, everything else), as main's owner
//   sampler attributes it every 30 s; `wiredBytes` is the kernel's wired memory,
//   which no process footprint carries. What is left of RAM is what the fleet
//   can have.
// - **The fleet, by the larger of what it reserved and what it uses.** A held
//   slot reserves `PER_UNIT_BYTES` from the moment it is taken (a just-started
//   build has not grown yet); the fleet's measured footprint (`opsBytes`: every
//   running op's whole process tree — holders, nested checks, workers, tests)
//   replaces that reservation whenever it is larger. That is where a holder's
//   own memory is charged: a build holding one slot whose `build` + `check` +
//   worker measure 6.5 GB is charged 6.5, not 3.6.
//
// The window is then the slots already held plus as many more quanta as fit in
// what is left — never above `B`, never below 1 (one op can always run, so the
// line always moves: the same floor `cpuBudget` keeps on a small host).

/**
 * One reading of the fleet's memory, published by main's owner sampler (see
 * `publishFleetMemory`) and read at every grant acquire.
 */
export const FleetMemoryReadingSchema = z.object({
  /** When the footprints were read (epoch ms). */
  sampledAt: z.number(),
  /** Physical memory of the host. */
  ramBytes: z.number().positive(),
  /** Kernel wired memory (vm_stat "Pages wired down"): in no process's footprint. */
  wiredBytes: z.number().nonnegative(),
  /** Physical footprint of every process that is not an agent op. */
  otherBytes: z.number().nonnegative(),
  /** Physical footprint of every running op's process tree (holders included). */
  opsBytes: z.number().nonnegative(),
  /** `cpu` pool slots held host-wide at the reading. */
  heldUnits: z.number().int().nonnegative(),
});
export type FleetMemoryReading = z.infer<typeof FleetMemoryReadingSchema>;

/**
 * How old a reading may be and still decide admission: four of the sampler's
 * 30 s ticks. A reading older than that means main's sampler is not running
 * (main restarting, or down), and admission says so (`unmeasured`) instead of
 * acting on a picture of the machine minutes out of date.
 */
export const FLEET_MEMORY_LEASE_MS = 120_000;

/** What the fleet is charged and what it may have, in bytes and in slots. */
export interface FleetWindow {
  /** RAM left for the fleet: RAM − wired − every non-op process's footprint. */
  allowedBytes: number;
  /** The fleet's charge: max(held slots × quantum, its measured footprint). */
  chargedBytes: number;
  /** Slots the fleet may hold now, held ones included: `1 … B`. */
  slots: number;
}

/** The fleet window a reading allows on `host` (whose `B` caps it). */
export function fleetWindow(
  reading: FleetMemoryReading,
  host: HostFacts = thisHost(),
): FleetWindow {
  const allowedBytes =
    reading.ramBytes - reading.wiredBytes - reading.otherBytes;
  const chargedBytes = Math.max(
    reading.heldUnits * PER_UNIT_BYTES,
    reading.opsBytes,
  );
  const more = Math.floor((allowedBytes - chargedBytes) / PER_UNIT_BYTES);
  const slots = Math.min(
    cpuBudget(host).B,
    Math.max(1, reading.heldUnits + more),
  );
  return { allowedBytes, chargedBytes, slots };
}

/**
 * The capacity one acquire in `lane` may use out of a `slots`-wide window: the
 * whole window for `interactive`, and the window's own background share for
 * `background` — the same reserved-floor split `cpuBudget` makes of `B`, so a
 * shrunken window still keeps its top slot(s) for a human-blocked op.
 */
export function laneCapacity(slots: number, lane: Lane): number {
  return lane === "interactive" ? slots : laneSplit(slots).backgroundLimit;
}
