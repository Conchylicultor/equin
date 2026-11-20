import { z } from "zod";
import {
  cpuBudget,
  laneSplit,
  PER_UNIT_BYTES,
  thisHost,
  type HostFacts,
  type Lane,
} from "./budget";
import { HolderReadingSchema, type HolderReading } from "./holders";

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
// - **The rest of the machine, by measurement.** `otherBytes` is the RAM held
//   by every process that is not an agent op (Chrome, backends, agents,
//   Postgres, the agent browser, everything else): what processes hold
//   machine-wide (packages/host-memory: macOS's anonymous + compressor pages,
//   Linux's AnonPages + Shmem) less the ops' footprint, as main's owner sampler reads it every 30 s — not a sum of
//   footprints, which count compressed pages uncompressed and over-counted the
//   machine by ~11 GB on 2026-11-13. `wiredBytes` is the kernel's own memory (macOS
//   wired pages; Linux what is neither free, on a page LRU nor
//   reclaimable slab);
//   the file cache is reclaimable and not charged. What is left of RAM is what
//   the fleet can have.
// - **The fleet, holder by holder: what each share is reserved, or what it
//   uses if larger.** A share is reserved from the moment it is taken (a
//   just-started build has not grown yet), and what it is reserved is what
//   holders of its kind of work have been MEASURED to peak at
//   (`holderReserve`, from main's holder-peak ledger) — not a whole
//   `PER_UNIT_BYTES` quantum per slot, which is the heavy type-check worker's
//   footprint per unit and ~3.6× what the fleet's slots used (p50 1.0 GB per
//   held slot, 2026-11-13). A holder whose tree measures more than its
//   reservation is charged the measurement. Ops holding no recorded share
//   (scripts, e2e runs, ops waiting for their grant) and slots held with no
//   holder marker (an older CLI) are charged as before: the larger of a
//   quantum per such slot and what those ops measure. So the charge is never
//   below the fleet's measured use, and a reservation can only be lowered by
//   a record of holders that used less.
//
// The window is then the slots already held plus as many more quanta as fit in
// what is left — never above `B`, never below 1 (one op can always run, so the
// line always moves: the same floor `cpuBudget` keeps on a small host). At 1,
// that op is an interactive one (`laneCapacity`) — bar on a host of `B ≤ 2`,
// where background shares it at low priority.

/**
 * Where the machine's sleep clock stood at one instant (packages/sleep-clock's
 * `readSleepClock`, less its `wakeAtMs`): two stamps of one `boot` differ in
 * `asleepMs` by exactly the time the machine slept between them, whichever
 * processes took them.
 */
export const SleepStampSchema = z.object({
  boot: z.string(),
  asleepMs: z.number().nonnegative(),
});
export type SleepStamp = z.infer<typeof SleepStampSchema>;

/**
 * One reading of the fleet's memory, published by main's owner sampler (see
 * `publishFleetMemory`) and read at every grant acquire.
 */
export const FleetMemoryReadingSchema = z.object({
  /** When the footprints were read (epoch ms). */
  sampledAt: z.number(),
  /**
   * The machine's sleep clock at `sampledAt`, or null where it cannot be read
   * (off macOS, or a sampler that predates the stamp): the lease is then judged
   * on the wall clock alone.
   */
  sleep: SleepStampSchema.nullable().default(null),
  /** Physical memory of the host. */
  ramBytes: z.number().positive(),
  /** Kernel memory in no process's footprint (host-memory `kernelBytes`: macOS wired pages, Linux RAM neither free, on a page LRU nor reclaimable slab). */
  wiredBytes: z.number().nonnegative(),
  /** RAM held by every process that is not an agent op: processes' anonymous + compressor pages, less `opsBytes`. */
  otherBytes: z.number().nonnegative(),
  /** Physical footprint of every running op's process tree (holders included). */
  opsBytes: z.number().nonnegative(),
  /** `cpu` pool slots held host-wide at the reading. */
  heldUnits: z.number().int().nonnegative(),
  /**
   * Every live share with a holder marker: its work, units, measured tree and
   * reservation. Defaulted, not optional: a reading from a sampler that
   * predates holder markers has none, and then every held slot is charged as
   * unrecorded — a whole quantum — exactly as before.
   */
  holders: z.array(HolderReadingSchema).default([]),
});
export type FleetMemoryReading = z.infer<typeof FleetMemoryReadingSchema>;

/**
 * How long a reading may have been AWAKE and still decide admission: four of
 * the sampler's 30 s ticks. A reading older than that means main's sampler is
 * not running (main restarting, or down), and admission says so (`unmeasured`)
 * instead of acting on a picture of the machine minutes out of date.
 *
 * Awake time, not wall time: while the machine sleeps every process is frozen,
 * the sampler and the memory it measures alike, so a nap ages nothing the
 * reading describes. On the wall clock, the first acquire after every wake
 * found the reading as old as the nap: on 2026-11-20 00:42–06:38 UTC a lid-shut
 * Mac dark-woke every ~15 min, main's deploy build acquired its grant within
 * 0.3–1.5 s of each wake, and read 653–1035 s of "staleness" of which only
 * 17–48 s were awake (report-1794949494-gejwlo) — the sampler had not missed a
 * single awake tick.
 */
export const FLEET_MEMORY_LEASE_MS = 120_000;

/** The instant admission is judged at: the wall clock and, where readable, the sleep clock. */
export interface AdmissionNow {
  wallMs: number;
  sleep: SleepStamp | null;
}

/**
 * How long the machine slept between a reading and `now`: the sleep-clock
 * difference when both were stamped in one boot, else 0 (cannot tell — the
 * wall clock then judges alone, never in the reading's favour).
 */
export function sleptSince(
  reading: FleetMemoryReading,
  now: AdmissionNow,
): number {
  if (reading.sleep === null || now.sleep === null) return 0;
  if (reading.sleep.boot !== now.sleep.boot) return 0;
  return Math.max(0, now.sleep.asleepMs - reading.sleep.asleepMs);
}

/** What the fleet is charged and what it may have, in bytes and in slots. */
export interface FleetWindow {
  /** RAM left for the fleet: RAM − wired − every non-op process's footprint. */
  allowedBytes: number;
  /** The fleet's charge: each holder's max(reservation, measured), plus the rest of the ops (`fleetCharge`). */
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
  const chargedBytes = fleetCharge(reading).bytes;
  const more = Math.floor((allowedBytes - chargedBytes) / PER_UNIT_BYTES);
  const slots = Math.min(
    cpuBudget(host).B,
    Math.max(1, reading.heldUnits + more),
  );
  return { allowedBytes, chargedBytes, slots };
}

/** The fleet's charge, split as `fleetWindow` sums it. */
export interface FleetCharge {
  bytes: number;
  /** Σ over recorded holders of max(reservation, measured tree). */
  holdersBytes: number;
  /** Their reservations not yet grown into: Σ max(0, reservation − measured). */
  headroomBytes: number;
  /** Held slots no holder marker accounts for. */
  unrecordedUnits: number;
  /** max(unrecorded slots × quantum, what the ops outside recorded holders measure). */
  restBytes: number;
}

/**
 * What the fleet is charged at one reading: every recorded holder at the
 * larger of its reservation and its measured tree, plus everything else the
 * ops hold — measured, or a whole quantum per held slot no marker accounts
 * for if that is larger. With no holder marker this is exactly the old
 * `max(heldUnits × quantum, opsBytes)`; it is never below `opsBytes`.
 */
export function fleetCharge(reading: FleetMemoryReading): FleetCharge {
  let holdersBytes = 0;
  let measuredHolders = 0;
  let recordedUnits = 0;
  for (const h of reading.holders) {
    holdersBytes += Math.max(h.reserveBytes, h.bytes);
    measuredHolders += h.bytes;
    recordedUnits += h.units;
  }
  const unrecordedUnits = Math.max(0, reading.heldUnits - recordedUnits);
  const restBytes = Math.max(
    unrecordedUnits * PER_UNIT_BYTES,
    Math.max(0, reading.opsBytes - measuredHolders),
  );
  return {
    bytes: holdersBytes + restBytes,
    holdersBytes,
    headroomBytes: holdersBytes - measuredHolders,
    unrecordedUnits,
    restBytes,
  };
}

/** The holders of a reading, grouped by work, for the words a waiter reads. */
export function describeHolders(holders: readonly HolderReading[]): string {
  const byWork = new Map<
    string,
    { n: number; units: number; reserved: number; used: number }
  >();
  for (const h of holders) {
    const g = byWork.get(h.work) ?? { n: 0, units: 0, reserved: 0, used: 0 };
    g.n++;
    g.units += h.units;
    g.reserved += Math.max(h.reserveBytes, h.bytes);
    g.used += h.bytes;
    byWork.set(h.work, g);
  }
  const gb = (b: number): string => `${(b / 1e9).toFixed(1)}`;
  return [...byWork]
    .map(
      ([work, g]) =>
        `${g.n} ${work} (${g.units} slot${g.units === 1 ? "" : "s"}, ${gb(g.used)}/${gb(g.reserved)} GB)`,
    )
    .join(", ");
}

/**
 * The capacity one acquire in `lane` may use out of a `slots`-wide window: the
 * whole window for `interactive`, and what is left of it for `background` once
 * the reserved interactive floor (`max(1, floor(slots / 3))`, the split
 * `cpuBudget` makes of `B`) is set aside — so every window, however shrunken,
 * keeps its top slot(s) for a human-blocked op.
 *
 * **A one-slot window is the interactive lane's alone** (background `0`: it
 * waits for the window to widen). Memory has room for one op; were background
 * allowed it, a human-blocked op — main's own recovery build — would queue
 * behind a 30–40 min agent build exactly when the box is under memory pressure,
 * when the human most needs it. Giving each lane a slot instead would admit
 * two ops onto room measured for one. So the background lane yields: under
 * that pressure agents wait for memory, the waiter's words say so, and the
 * memory bound is unchanged.
 *
 * The exception is a host whose static background window is one slot
 * (`B ≤ 2`: a small VPS, an 8 or 16 GB Mac — `backgroundSharesLastSlot`):
 * there a one-slot window is the steady state, not a squeeze, and background
 * kept off it would never run. So background shares it, at `low` priority
 * (`grantPriority`): it never takes the slot while an interactive op waits,
 * and an interactive op can queue behind at most one running background op.
 */
export function laneCapacity(
  slots: number,
  lane: Lane,
  host: HostFacts = thisHost(),
): number {
  if (lane === "interactive") return slots;
  const own = slots - laneSplit(slots).reservedInteractive;
  return cpuBudget(host).backgroundSharesLastSlot ? Math.max(1, own) : own;
}

/**
 * The window admission acts on when nothing measures the machine: no reading,
 * or none inside its lease (main's sampler stopped, main down). Two slots — the
 * smallest window `laneCapacity` cuts into one background slot and one reserved
 * interactive slot — so the agent fleet runs one op at a time while a human-
 * blocked op (main's own recovery build) is never queued behind it.
 *
 * Not the static ceiling `B`: `B` alone is the model that let the host swap
 * (2026-11-12, ~30 GB of ops admitted onto a host already out of memory). Not
 * the last reading's window either: a picture of the machine minutes old is
 * not a measurement. Unmeasured, admission can only prove what it can afford
 * on a host it cannot see, which is the floor — and it says so loudly
 * (host-admission's `fleet-memory-unmeasured` report), since a sampler that
 * stopped is a broken assumption, not a mode.
 */
export function unmeasuredWindow(host: HostFacts = thisHost()): number {
  return Math.min(cpuBudget(host).B, 2);
}

/** Why there is no measurement to admit by. */
export type UnmeasuredCause = "absent" | "stale";

/** What admission acts on at one instant: a measured window, or the floor. */
export type FleetAdmission =
  | {
      kind: "measured";
      window: FleetWindow;
      reading: FleetMemoryReading;
      /** Awake time left on this reading's lease before admission turns `unmeasured`. */
      leaseLeftMs: number;
    }
  | {
      kind: "unmeasured";
      cause: UnmeasuredCause;
      /** How long the machine has been awake since the last reading (`stale`), or null (`absent`). */
      ageMs: number | null;
      /**
       * The last reading's own `sampledAt` (`stale`), or null (`absent`): the
       * episode's identity — every acquire of one outage sees the same one.
       */
      sampledAt: number | null;
      /** The window admitted on meanwhile: `unmeasuredWindow`. */
      slots: number;
    };

/** Admission at `now` given the latest reading (`null`: none was ever written). */
export function fleetAdmission(
  reading: FleetMemoryReading | null,
  now: AdmissionNow,
  host: HostFacts = thisHost(),
): FleetAdmission {
  if (reading === null)
    return {
      kind: "unmeasured",
      cause: "absent",
      ageMs: null,
      sampledAt: null,
      slots: unmeasuredWindow(host),
    };
  const ageMs = now.wallMs - reading.sampledAt - sleptSince(reading, now);
  if (ageMs > FLEET_MEMORY_LEASE_MS)
    return {
      kind: "unmeasured",
      cause: "stale",
      ageMs,
      sampledAt: reading.sampledAt,
      slots: unmeasuredWindow(host),
    };
  return {
    kind: "measured",
    window: fleetWindow(reading, host),
    reading,
    leaseLeftMs: FLEET_MEMORY_LEASE_MS - ageMs,
  };
}

/** The slots an admission state allows, before the lane split. */
export function admissionSlots(admission: FleetAdmission): number {
  return admission.kind === "measured"
    ? admission.window.slots
    : admission.slots;
}
