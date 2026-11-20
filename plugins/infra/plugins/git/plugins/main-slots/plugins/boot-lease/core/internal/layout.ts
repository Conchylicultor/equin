// A main slot's lease, as files — the one spelling every holder writes and
// every reader reads: main-slots' own leases (`../../../../core`), this
// plugin's synchronous boot hold, and the guard bootstrap's copy
// (`tooling/guards/bin/bootstrap.ts`, which may import nothing from the repo;
// its test holds the copy to these values).
//
// All of it lives in the slot's ADMIN DIR — `<git dir>/<lock dir>/`, per
// checkout (a linked worktree has its own git dir), inside the git dir so git
// never lists it and no check's tree hash sees it.

import {
  awakeBetween,
  isSleepStamp,
  type SleepStamp,
} from "@plugins/packages/plugins/sleep-clock/plugins/stamp/core";

/** The lock file: a shared flock while code runs from the slot, exclusive while a build writes it. */
export const SLOT_LOCK_FILE = "tree.lock";

/** The dir of holder records beside it: one `<pid>.<n>.json` per lease. */
export const SLOT_LEASES_DIR = "leases";

/** The stamp a linked worktree is made a main slot with (`stampMainSlot`, `infra/paths`). */
export const MAIN_SLOT_STAMP = "main-slot";

/**
 * When main's OWN app was last served from the slot (`markSlotServed`,
 * written as main's `current/<main namespace>` is pointed at it): an ISO
 * instant. The most recent one among the repo's slots is the slot main's link
 * names — what a reader that cannot resolve the data root (the guard
 * bootstrap) reads instead of the link. Never written for a composition.
 */
export const MAIN_SLOT_SERVED_FILE = "main-slot-served";

/**
 * When the slot stopped serving every app — `{at, reportAfterMs}`, written by
 * whoever saw its last app leave (`stampUnservedSlots`, main-slots core), and
 * removed when a build takes the slot or an app is served from it again. A
 * lease released past `at + reportAfterMs` leaves a drain record
 * ({@link SLOT_DRAIN_LOG_DIR}); the threshold travels in the stamp so the
 * release path reads no config.
 */
export const SLOT_UNSERVED_FILE = "main-slot-unserved";

/**
 * The slot is handed to a build (`runInBuildSlot`, main-slots cli) between
 * the hander releasing its lease and the build child claiming it:
 * `{handoff, pid, hold}` — the handoff id the child must present, the
 * hander's pid, and how the hander holds the mark (`hold: "lock"`: while it
 * holds {@link slotHandedLockFile}; unheld or gone, it is stale). A mark with
 * no `hold` is the pre-lock format, standing while its pid lives — read still,
 * since the hander runs the older code main serves (main-slots core
 * `handoff.ts`).
 */
export const SLOT_HANDED_FILE = "main-slot-handed";

/**
 * The hander's flock for one handoff, held exclusively from before it writes
 * {@link SLOT_HANDED_FILE} until it lets the handoff go — so a SIGKILLed
 * hander's mark goes stale with it, whatever process later reuses its pid.
 * One file per handoff: a hander still holding its own after the build
 * claimed the slot never blocks the next handoff.
 */
export function slotHandedLockFile(handoff: string): string {
  return `main-slot-handed.${handoff}.lock`;
}

/** Drain records: one `<pid>.<n>.json` per lease released past its slot's switch. */
export const SLOT_DRAIN_LOG_DIR = "drain-log";

/**
 * Who holds a slot — a closed set, so a report can say what each holder is.
 *
 * - `backend` — a namespace's serving runtime, for its whole life;
 * - `central` — THE central runtime (one per machine), for its whole life;
 * - `exec-child` — a `./equin` process running from the slot (a supervised
 *   child of the backend, main's convergence run), for its whole life;
 * - `agent-boot` / `guard` — an agent host booting, a guard hook loading:
 *   only while they load code;
 * - `build` — a build checking out and building into the slot (exclusive),
 *   then — once it hands the slot to the backend it is about to restart —
 *   shared until it exits;
 * - `build-relay` — a `./equin build` running from a slot it was not handed
 *   (main's convergence run, a relayed Build-button or hand-run build): it
 *   hands the build to another slot and waits for it, so it holds the slot it
 *   runs from past the switch it causes, by design, until it exits — never a
 *   slow drain ({@link drainRecordFor}).
 */
export const SLOT_HOLDER_KINDS = [
  "backend",
  "central",
  "exec-child",
  "agent-boot",
  "guard",
  "build",
  "build-relay",
] as const;

export type SlotHolderKind = (typeof SLOT_HOLDER_KINDS)[number];

/**
 * What a live holder's lease means for its slot:
 *
 * - `pins` — the holder IS an app living in the slot: the slot serves while
 *   it holds it, whatever links and specs say. Central: one per machine, it
 *   keeps the slot it booted from until a deploy restarts it (an adopted
 *   deploy keeps it there for as many builds as its code is unchanged), and
 *   its spec is no proof of where it runs — a build on a branch from before
 *   slots rewrites it to the repo root on every build. Counted as draining,
 *   its slot filled the leak limit and stalled main's deploys (2026-11-18).
 * - `drains` — must let go soon after its slot's last app left: past the
 *   threshold it is a slow drain, reported;
 * - `outlives` — holds past the switch it causes, by design (`build-relay`):
 *   draining, never reported.
 */
export type SlotHolderRole = "pins" | "drains" | "outlives";

/**
 * Every holder kind's role — total over {@link SLOT_HOLDER_KINDS}, so a new
 * kind does not compile until it says whether it pins, drains or outlives.
 */
const SLOT_HOLDER_ROLES = {
  backend: "drains",
  central: "pins",
  "exec-child": "drains",
  "agent-boot": "drains",
  guard: "drains",
  build: "drains",
  "build-relay": "outlives",
} as const satisfies Record<SlotHolderKind, SlotHolderRole>;

export function slotHolderRole(kind: SlotHolderKind): SlotHolderRole {
  return SLOT_HOLDER_ROLES[kind];
}

export type SlotLeaseMode = "shared" | "exclusive";

/** One holder record, as written at acquire. */
export interface SlotHolder {
  pid: number;
  kind: SlotHolderKind;
  mode: SlotLeaseMode;
  /** ISO instant the lease was granted. */
  acquiredAt: string;
  /**
   * What the holder is, in words a report names it by: a supervised child's
   * job name (`worktree.prepare`), a CLI process's verb (`run <script>` for
   * a `./equin run`), a backend's namespace, a build's id. `null` on a record written without one (the
   * guard bootstrap's copy).
   */
  label: string | null;
}

/** A record's text: one JSON line. */
export function renderHolder(holder: SlotHolder): string {
  return `${JSON.stringify(holder)}\n`;
}

/** A record's text back, or throws naming the file. */
export function parseHolder(file: string, text: string): SlotHolder {
  const parsed = JSON.parse(text) as Partial<SlotHolder> | null;
  if (
    parsed === null ||
    typeof parsed.pid !== "number" ||
    (parsed.label !== undefined &&
      parsed.label !== null &&
      typeof parsed.label !== "string") ||
    typeof parsed.acquiredAt !== "string" ||
    (parsed.mode !== "shared" && parsed.mode !== "exclusive") ||
    !SLOT_HOLDER_KINDS.includes(parsed.kind as SlotHolderKind)
  ) {
    throw new Error(`main-slots: holder record ${file} is malformed: ${text}`);
  }
  return { ...(parsed as SlotHolder), label: parsed.label ?? null };
}

/** The {@link SLOT_UNSERVED_FILE} stamp. */
export interface UnservedStamp {
  /** ISO instant the slot's last app left it. */
  at: string;
  /** Past `at` by more than this much AWAKE time, a releasing holder is reported. */
  reportAfterMs: number;
  /**
   * The sleep clock at `at` — what lets a later reader take the machine's
   * sleep out of the span ({@link heldPastSwitch}). `null`: the platform
   * cannot tell, or a stamp written before it was recorded.
   */
  asleep: SleepStamp | null;
}

export function renderUnserved(stamp: UnservedStamp): string {
  return `${JSON.stringify(stamp)}\n`;
}

export function parseUnserved(file: string, text: string): UnservedStamp {
  const parsed = JSON.parse(text) as Partial<UnservedStamp> | null;
  if (
    parsed === null ||
    typeof parsed.at !== "string" ||
    Number.isNaN(Date.parse(parsed.at)) ||
    typeof parsed.reportAfterMs !== "number" ||
    (parsed.asleep !== undefined &&
      parsed.asleep !== null &&
      !isSleepStamp(parsed.asleep))
  ) {
    throw new Error(`main-slots: unserved stamp ${file} is malformed: ${text}`);
  }
  return {
    at: parsed.at,
    reportAfterMs: parsed.reportAfterMs,
    // A stamp written before the sleep clock was recorded: the wall clock.
    asleep: parsed.asleep ?? null,
  };
}

/** How long a holder has kept a slot past its switch, with the machine's sleep taken out. */
export interface HeldPastSwitch {
  /** Wall-clock span from the switch to `now`. */
  heldPastSwitchMs: number;
  /** The machine's sleep inside it; `null` when it cannot be told (no mark, another boot, no sleep clock). */
  sleptMs: number | null;
  /** The span less that sleep — what the threshold is judged on. */
  awakeMs: number;
}

/**
 * The span a holder has kept the slot past its switch, judged on AWAKE time.
 * A sleeping Mac runs nothing — no job holding the slot, and no build that
 * needs one — but the wall clock keeps going: a supervised child that started
 * before a night of dark wakes (≈1 min awake every 15) "held" its slot for
 * hours while it ran for minutes (report-1794976612-es42jy: 7384 s on the wall,
 * ~7 min awake). Pure: the sleep clock now is passed in. Where it cannot be
 * told, the wall clock — the behaviour before.
 */
export function heldPastSwitch(
  stamp: UnservedStamp,
  now: Date,
  asleepNow: SleepStamp | null,
): HeldPastSwitch {
  const span = awakeBetween(
    { wallMs: Date.parse(stamp.at), sleep: stamp.asleep },
    { wallMs: now.getTime(), sleep: asleepNow },
  );
  return {
    heldPastSwitchMs: span.wallMs,
    sleptMs: span.sleptMs,
    awakeMs: span.awakeMs,
  };
}

/** One drain record: a holder that kept a no-longer-serving slot past the threshold. */
export interface DrainRecord {
  kind: SlotHolderKind;
  label: string | null;
  pid: number;
  /** How long after the slot stopped serving the holder let it go (wall clock). */
  heldPastSwitchMs: number;
  /**
   * The machine's sleep inside that span ({@link heldPastSwitch}); `null` when
   * it cannot be told — a record written before it existed, or by the guard
   * bootstrap's copy, which reads no sleep clock.
   */
  sleptMs: number | null;
  /** The threshold its AWAKE time was past (the stamp's `reportAfterMs`). */
  thresholdMs: number;
  /** The slot's root. */
  slot: string;
  /** The commit the slot was checked out at (`null`: its HEAD named none). */
  commit: string | null;
  /** ISO instant of the release (found dead: when it was last seen alive). */
  releasedAt: string;
  /**
   * `true`: the holder was SIGKILLed while holding (no release ran) and found
   * dead by a later reader — `heldPastSwitchMs` is then a LOWER bound: it was
   * last seen alive that long after the switch (its record's mtime), and
   * died some time after.
   */
  foundDead: boolean;
}

export function renderDrainRecord(record: DrainRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function parseDrainRecord(file: string, text: string): DrainRecord {
  const p = JSON.parse(text) as Partial<DrainRecord> | null;
  if (
    p === null ||
    !SLOT_HOLDER_KINDS.includes(p.kind as SlotHolderKind) ||
    (p.label !== null && typeof p.label !== "string") ||
    typeof p.pid !== "number" ||
    typeof p.heldPastSwitchMs !== "number" ||
    typeof p.thresholdMs !== "number" ||
    typeof p.slot !== "string" ||
    (p.commit !== null && typeof p.commit !== "string") ||
    typeof p.releasedAt !== "string" ||
    (p.foundDead !== undefined && typeof p.foundDead !== "boolean") ||
    (p.sleptMs !== undefined &&
      p.sleptMs !== null &&
      typeof p.sleptMs !== "number")
  ) {
    throw new Error(`main-slots: drain record ${file} is malformed: ${text}`);
  }
  // A record written before `foundDead` existed was a release; before
  // `sleptMs`, nobody knew the sleep.
  return {
    ...(p as DrainRecord),
    foundDead: p.foundDead ?? false,
    sleptMs: p.sleptMs ?? null,
  };
}

/**
 * The drain record a release at `now` leaves, or `null` when it owes none:
 * the slot still serves (no stamp), the holder does not drain (it pins its
 * slot, or outlives the switch by design), or it let go within the
 * threshold of AWAKE time ({@link heldPastSwitch}). Pure — both release paths
 * (sync and async) decide with it.
 */
export function drainRecordFor(i: {
  stamp: UnservedStamp | null;
  holder: SlotHolder;
  slot: string;
  commit: string | null;
  now: Date;
  /** The sleep clock at `now` (`sleepStampNow()`); `null`: cannot be told. */
  asleepNow: SleepStamp | null;
  /** The holder was found dead at `now`, not released (see {@link DrainRecord.foundDead}). */
  foundDead?: boolean;
}): DrainRecord | null {
  if (i.stamp === null || slotHolderRole(i.holder.kind) !== "drains")
    return null;
  const held = heldPastSwitch(i.stamp, i.now, i.asleepNow);
  if (held.awakeMs <= i.stamp.reportAfterMs) return null;
  return {
    kind: i.holder.kind,
    label: i.holder.label,
    pid: i.holder.pid,
    heldPastSwitchMs: held.heldPastSwitchMs,
    sleptMs: held.sleptMs,
    thresholdMs: i.stamp.reportAfterMs,
    slot: i.slot,
    commit: i.commit,
    releasedAt: i.now.toISOString(),
    foundDead: i.foundDead ?? false,
  };
}

/** The commit a git `HEAD` file names when detached (a slot always is); `null` otherwise. */
export function detachedHeadOf(text: string): string | null {
  const t = text.trim();
  return /^[0-9a-f]{40,64}$/.test(t) ? t : null;
}
