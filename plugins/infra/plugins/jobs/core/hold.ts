import { z } from "zod";

// THE class table. One declaration of what a hold class IS — its graphile task
// identifier, its fetch priority, its work-time ceiling — plus the runner ladder
// that gives each class its slot count. Everything below the two tables is
// DERIVED from them; nothing re-types a task name, a priority, or a slot count.
//
// This lives in `core/` rather than `server/` because both runtimes need it: the
// server stamps the task and priority onto every inserted row, and Debug → Queue
// renders the class per row in the browser. It is a closed set of plain data, so
// per CLAUDE.md it is data in `core/`, not a slot. Its only import is zod.
//
// Design, measurements and the prior art behind the boundaries:
// research/2026-08-19-global-job-hold-class-reserved-slots.md.

/**
 * The timescale one RUN of a handler occupies a worker slot.
 *
 * - `instant` — no blocking I/O: indexed reads/writes and in-memory work. No
 *   network, no spawn, no model call.
 * - `seconds` — bounded by a timeout the handler passes itself (a model call
 *   with `timeoutMs`, an HTTP fetch with a deadline).
 * - `minutes` — bounded by nothing shorter than the work: a subprocess,
 *   `pg_dump`, Chromium, an archive upload, an open-ended step machine.
 */
export type HoldClass = "instant" | "seconds" | "minutes";

/** Ordered shortest → longest. */
export const HOLD_CLASSES = ["instant", "seconds", "minutes"] as const;

/** Wire/parse form of {@link HoldClass} — used by a recorded run's `hold` and any
 * other payload that carries a class across the network. */
export const HoldClassSchema = z.enum(HOLD_CLASSES);

/**
 * The graphile task identifier every job used before hold classes existed.
 *
 * It stays registered in the widest runner **forever**, so a row that was not
 * re-pointed — written mid-deploy, or by an older backend — can never be
 * stranded on a task no runner serves. It reads as `minutes`, the most
 * conservative tier, which is also where the wide runner actually runs it.
 */
export const LEGACY_JOB_TASK = "jobs.run";

export interface HoldClassSpec {
  readonly hold: HoldClass;
  /** Human label for the class (Debug → Queue, report copy). */
  readonly label: string;
  /** Graphile task identifier. The ONE spelling; nothing composes this string. */
  readonly task: string;
  /**
   * Graphile `priority` — LOWER WINS. `getJob` orders `priority asc, run_at asc`,
   * so stamping the longest class with the lowest number makes each runner prefer
   * the longest class it is allowed to serve. A class's own tier therefore fills
   * before it spills into a narrower one.
   */
  readonly priority: number;
  /**
   * Ceiling on WORK time (`durationMs - waitMs`), NOT on wall-clock hold. Hold is
   * substantially not a property of the job — a handler blocked on an admission
   * gate entered after dispatch can hold a slot for a minute to do 250 ms of work
   * — so conformance is read off work.
   *
   * This is what `debug/slow-ops` judges a job's conformance against, and the
   * floor of `queue-class-starved`'s per-class window.
   *
   * **It is NOT the deadline** — see {@link HoldClassSpec.deadlineMs}. An earlier
   * version of this comment promised that "the same number becomes the execution
   * deadline"; the commit that wrote it also shipped the evidence against it, and
   * the two are siblings rather than one number.
   */
  readonly ceilingMs: number;
  /**
   * The wall-clock HOLD at which one run of this class is given up on: the timer
   * that aborts `ctx.signal` with a `JobDeadlineExceededError`.
   *
   * **Why this is a sibling of `ceilingMs` and not the same number.** `ceilingMs`
   * bounds WORK, and work is the only quantity a class can honestly ceiling —
   * but a deadline can only ever be measured on wall-clock hold, because at the
   * moment the timer fires nothing knows yet how the elapsed time split between
   * working and waiting. Those two quantities genuinely differ, and
   * `queue-slot-blocked` was shipped precisely to report the gap: `jobs.dead-gc`
   * was measured holding a worker slot for **77 seconds to do 254 ms of work**,
   * all of the remainder blocked on `background-tx-acquire`, an admission gate it
   * entered *after* graphile had already handed it the slot. Aborting on hold at
   * the work ceiling would kill that conforming handler, and every handler like
   * it, for someone else's congestion.
   *
   * So the gap between the two numbers is not slack — it is the statement of how
   * much gate wait we are willing to believe before we stop believing the handler
   * will ever return.
   *
   * `queue-slot-hog` reports at a FRACTION of this (`slotHogDeadlineFraction`,
   * strictly below 1), which is what makes warn-before-kill structural rather
   * than a coincidence of two independently-chosen numbers.
   */
  readonly deadlineMs: number;
  /**
   * How long a due row of this class should wait for a worker slot before it is
   * picked up — a QUEUEING target, measured from `run_at` to `locked_at`. It says
   * nothing about how long the run then takes; that is `ceilingMs`.
   *
   * The prior art is GitLab's Sidekiq urgency SLOs, already the model for the
   * classes themselves: `urgency :high` gets a 10 s queueing target and
   * `urgency :low` 1 min, which are `seconds` and `minutes` here. `instant` is
   * stricter than anything GitLab states (1 s), because it has slots nothing
   * slower can reach and its measured expected wait is about 17 ms
   * (research/2026-08-19-global-job-hold-class-reserved-slots.md, the
   * Pollaczek–Khinchine table) — so a 1 s wait is already ~60× what the ladder
   * was built to give it.
   *
   * Read by `debug/queue-health`, which derives its attention line from it
   * (10×) and takes the critical line from `deadlineMs`. The ratio
   * `deadlineMs / pickupTargetMs` is 60 for every class, so "how far past its
   * own target" orders waits by severity across classes — which is how
   * `queryOldestWaiting` ranks them, the only other reader.
   */
  readonly pickupTargetMs: number;
}

export const HOLD_SPECS: Readonly<Record<HoldClass, HoldClassSpec>> = {
  instant: {
    hold: "instant",
    label: "Instant",
    task: "jobs.run.instant",
    priority: 2,
    ceilingMs: 10_000,
    deadlineMs: 60_000,
    pickupTargetMs: 1_000,
  },
  seconds: {
    hold: "seconds",
    label: "Seconds",
    task: "jobs.run.seconds",
    priority: 1,
    ceilingMs: 120_000,
    deadlineMs: 600_000,
    pickupTargetMs: 10_000,
  },
  minutes: {
    hold: "minutes",
    label: "Minutes",
    task: "jobs.run.minutes",
    priority: 0,
    ceilingMs: 1_800_000,
    deadlineMs: 3_600_000,
    pickupTargetMs: 60_000,
  },
};

export interface RunnerSpec {
  readonly id: string;
  /** The classes this runner's `taskList` serves. Nested, shortest-first: a
   * shorter class always inherits a longer class's idle slots, so the only
   * capacity ever stranded is the floor itself. */
  readonly serves: readonly HoldClass[];
  readonly concurrency: number;
  /** The one runner that also serves {@link LEGACY_JOB_TASK}. */
  readonly legacy?: boolean;
}

/**
 * The runner ladder. Three graphile runners with nested task lists, so the
 * reservation happens at FETCH rather than after dispatch: graphile's fetch query
 * partitions on `task_id = any($2::int[])`, and a runner physically cannot see a
 * task identifier absent from its own `taskList`. An in-process gate entered
 * after graphile hands over a job turns one stuck job into N stuck slots — the
 * lesson `serial` exists to encode.
 *
 * Ceilings fall out of the nesting: `minutes ≤ 4` (unchanged from the old single
 * pool), `seconds ≤ 6`, `instant ≤ 8`. Two slots are permanently unreachable by
 * anything that can run for minutes.
 */
export const RUNNERS: readonly RunnerSpec[] = [
  { id: "floor", serves: ["instant"], concurrency: 2 },
  { id: "mid", serves: ["instant", "seconds"], concurrency: 2 },
  {
    id: "wide",
    serves: ["instant", "seconds", "minutes"],
    concurrency: 4,
    legacy: true,
  },
];

/** Total worker slots across every runner. The size of the whole pool — what
 * `queue-health` measures saturation against, and what the job-lock connection
 * pool must be sized to. */
export const TOTAL_JOB_SLOTS: number = RUNNERS.reduce(
  (sum, r) => sum + r.concurrency,
  0,
);

/** Every graphile task identifier a Singularity job row can carry: one per class
 * plus the legacy task. Composed by the queue-scoping SQL rather than re-typed. */
export const ALL_JOB_TASKS: readonly string[] = [
  ...HOLD_CLASSES.map((hold) => HOLD_SPECS[hold].task),
  LEGACY_JOB_TASK,
];

/** The graphile task identifier a row of this class is inserted on. */
export function taskFor(hold: HoldClass): string {
  return HOLD_SPECS[hold].task;
}

/** The graphile `priority` (lower wins) stamped onto a row of this class. */
export function priorityFor(hold: HoldClass): number {
  return HOLD_SPECS[hold].priority;
}

/** The class's ceiling on WORK time — see {@link HoldClassSpec.ceilingMs}. */
export function ceilingMsFor(hold: HoldClass): number {
  return HOLD_SPECS[hold].ceilingMs;
}

/** The class's wall-clock HOLD deadline — see {@link HoldClassSpec.deadlineMs}.
 * The number the dispatch timer arms on, and the number every consumer that
 * wants to say something about the deadline must read rather than restate. */
export function deadlineMsFor(hold: HoldClass): number {
  return HOLD_SPECS[hold].deadlineMs;
}

/** The class's queueing target — see {@link HoldClassSpec.pickupTargetMs}. */
export function pickupTargetMsFor(hold: HoldClass): number {
  return HOLD_SPECS[hold].pickupTargetMs;
}

/** How many worker slots a row of this class can ever reach, summed over every
 * runner whose task list serves it. `instant` 8, `seconds` 6, `minutes` 4. */
export function reachableSlots(hold: HoldClass): number {
  return RUNNERS.filter((r) => r.serves.includes(hold)).reduce(
    (sum, r) => sum + r.concurrency,
    0,
  );
}

/**
 * The class a graphile task identifier belongs to. {@link LEGACY_JOB_TASK} maps
 * to `minutes` — the most conservative tier, and the one it actually runs in
 * (the wide runner). Throws on anything else: an unknown identifier inside the
 * job scope is a wiring bug, not a runtime condition.
 */
export function holdForTask(task: string): HoldClass {
  if (task === LEGACY_JOB_TASK) return "minutes";
  const hold = HOLD_CLASSES.find((h) => HOLD_SPECS[h].task === task);
  if (!hold)
    throw new Error(`[jobs] unknown graphile task identifier: ${task}`);
  return hold;
}
