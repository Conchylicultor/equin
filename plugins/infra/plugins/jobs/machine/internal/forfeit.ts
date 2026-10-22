import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { readFileSync, writeFileSync } from "node:fs";
import { reportServerFatalSync } from "@plugins/framework/plugins/server-core/core";
import { jobsStateDir } from "../../data-dirs";
import { HOLD_CLASSES, RUNNERS, type HoldClass } from "../../core/hold";
import {
  JOB_SLOT_FLOOR_KIND,
  type JobSlotFloorReport,
} from "../../server/internal/slot-floor";

// **FORFEIT IS ACCOUNTING, NOT RECOVERY.**
//
// Nothing in this file reclaims anything. No job row is touched, no advisory
// lock is released, no handler is stopped, nothing is retried. A forfeited slot
// is a slot we have written off for the life of this process, and the zombie
// holding it goes on holding it — which is exactly the property that keeps the
// design safe. Its advisory lock is still held by this live backend, so the
// stuck-lock sweeper provably will not reclaim its row and graphile cannot hand
// that row to a second worker.
//
// If you are here to "fix" forfeit into a reclaim: that change re-creates the
// bug this plugin's whole liveness design exists to prevent. Releasing the lock
// (or clearing `locked_at`) lets the sweeper reclaim a row whose handler is
// still running, and graphile then re-dispatches a possibly non-idempotent
// handler alongside its own zombie. The previous age-based lease did precisely
// that and stole ~25 live jobs in 8 days. A running promise cannot be
// un-awaited; the abort in deadline.ts is the only lever there is, and this
// file is what we do when the lever did not work.
//
// What the accounting buys is a question we could not otherwise answer: **how
// many slots does this runner actually still have?** That is what the floor
// check below reads, and what Debug → Queue shows as `forfeited`.

/** One written-off worker slot: which run is still sitting in it. */
export interface ForfeitedSlot {
  /** graphile job id — the key, because a slot is held by one dispatch. */
  jobId: string;
  jobName: string;
  hold: HoldClass;
  /** Which runner in the ladder this slot belongs to (`floor` / `mid` / `wide`). */
  runnerId: string;
  /** When the slot was written off (epoch ms) — the zombie instant, not the
   * dispatch instant. */
  since: number;
}

// Process state, deliberately: a forfeited slot is a fact about THIS backend's
// worker pool, and it dies with the process — which is correct, because the
// process exiting is what actually returns the slot. Persisting it would be
// claiming something about a pool that no longer exists.
const forfeited = new Map<string, ForfeitedSlot>();

/** Every slot currently written off, across every runner. */
export function getForfeitedSlots(): ForfeitedSlot[] {
  return [...forfeited.values()];
}

/** Whether this dispatch's slot has been written off. Reads process state, so
 * it is only ever true for a run this backend is itself still holding. */
export function isSlotForfeited(jobId: string): boolean {
  return forfeited.has(jobId);
}

/**
 * Write off the slot this run is holding. Called from the zombie timer, once
 * per dispatch.
 *
 * Idempotent by key: re-recording the same `jobId` overwrites its entry rather
 * than double-counting a slot that only exists once.
 */
export function recordForfeit(entry: ForfeitedSlot): void {
  forfeited.set(entry.jobId, entry);
}

/**
 * Un-write-off a slot, because the handler finally settled.
 *
 * Returns the entry that was there, or `null` if there was none — which is the
 * normal path, since every disarm calls this and almost none of them had a
 * zombie. Callers use the return value to announce the recovery only when there
 * was something to recover.
 */
export function clearForfeit(jobId: string): ForfeitedSlot | null {
  const entry = forfeited.get(jobId);
  if (!entry) return null;
  forfeited.delete(jobId);
  return entry;
}

/** How many of this runner's slots are still worth anything: its declared
 * concurrency minus what we have written off on it. Throws on an unknown id —
 * a runner id that is not in the ladder is a wiring bug, not a runtime
 * condition. */
export function usableSlots(runnerId: string): number {
  const spec = RUNNERS.find((r) => r.id === runnerId);
  if (!spec) {
    throw new Error(
      `[jobs] usableSlots: no runner "${runnerId}" in the ladder (${RUNNERS.map((r) => r.id).join(", ")})`,
    );
  }
  let lost = 0;
  for (const e of forfeited.values()) if (e.runnerId === runnerId) lost++;
  return spec.concurrency - lost;
}

// ─── The floor ────────────────────────────────────────────────────────────

/** The longest hold class — `HOLD_CLASSES` is ordered shortest → longest, and
 * this is read from it rather than spelled, like everything else derived from
 * the class table. */
const LONGEST_HOLD: HoldClass = HOLD_CLASSES[HOLD_CLASSES.length - 1]!;

/**
 * The runner that serves the longest hold class — **not** the runner whose id
 * happens to be `"floor"`, which is the narrowest one. "Floor" here is the
 * minimum usable-slot count below, not a runner name.
 *
 * Derived from the ladder, never spelled: nothing outside `core/hold.ts`
 * re-types a value the class table owns, and a check that hardcoded `"wide"`
 * would silently go on watching the wrong runner the day the table is edited.
 *
 * Resolved at module eval, and it THROWS if the ladder ever grows a second
 * runner serving the longest class. That is deliberate. The whole crash
 * condition below is phrased about one runner's slots; with two such runners
 * the honest condition is about their combined capacity, and the difference
 * matters — so the table edit must come back here and re-express it rather than
 * silently watching whichever one happened to be first.
 */
const LONGEST_CLASS_RUNNER = (() => {
  const serving = RUNNERS.filter((r) => r.serves.includes(LONGEST_HOLD));
  if (serving.length !== 1) {
    throw new Error(
      `[jobs] the slot floor assumes exactly ONE runner serves the longest hold class ` +
        `("${LONGEST_HOLD}"), and the ladder has ${serving.length} ` +
        `(${serving.map((r) => r.id).join(", ") || "none"}). ` +
        `Re-express the floor in forfeit.ts over the combined capacity of those runners ` +
        `before changing RUNNERS.`,
    );
  }
  return serving[0]!;
})();

/**
 * The fewest usable slots the longest-class runner may have before we stop
 * believing this process can do its job.
 *
 * **Why 2 and not 1, and why this runner.** It is the only runner that serves
 * the longest hold class, so DB forks, conversation spawns, builds and backups
 * have nowhere else to go — a shorter class always inherits a longer class's
 * idle slots, never the other way round. One usable slot means the very next
 * long job to arrive occupies the entire capacity of that class, and anything
 * else of that class waits behind a handler nobody can stop.
 *
 * The original argument for 2 ("one slot lets a long job block every monitor")
 * no longer needs making separately: the monitors are `instant`, and the
 * narrowest runner already reserves slots only they can reach, so their
 * capacity is structurally out of reach of a long job. What is left is this
 * runner's own exclusive work, and two is the smallest number at which one
 * arrival does not consume all of it.
 */
const MIN_USABLE_SLOTS = 2;

/**
 * Re-check the pool after a slot has been written off.
 *
 * Two outcomes, and they are different in kind:
 *
 * - The longest-class runner is below the floor ⇒ this process can no longer do
 *   the work only it can do. Write the report SYNCHRONOUSLY to disk and exit.
 *   Postgres drops every advisory lock during backend teardown, so the next
 *   boot's sweeper reclaims those rows cleanly and the work re-runs — which is
 *   the one thing that actually returns the slots.
 * - A NARROWER runner has gone fully forfeited ⇒ report, and stay up. Its
 *   classes still reach the wider runners (the task lists are nested), so the
 *   pool is degraded, not dead, and exiting would throw away live capacity to
 *   fix a shortage that is not fatal.
 */
export function checkSlotFloor(): void {
  const usable = usableSlots(LONGEST_CLASS_RUNNER.id);
  if (usable < MIN_USABLE_SLOTS) {
    tripFloor(usable);
    return;
  }

  for (const spec of RUNNERS) {
    if (spec.id === LONGEST_CLASS_RUNNER.id) continue;
    if (usableSlots(spec.id) > 0) continue;
    const report = describe(spec.id, "degraded", false, 0);
    console.warn(
      `[jobs] the ${spec.id} runner has no usable slots left — all ${spec.concurrency} ` +
        `are held by handlers that ignored their deadline. Its work still reaches the wider ` +
        `runners, so the pool is degraded rather than dead.`,
    );
    reportServerFatalSync({
      kind: JOB_SLOT_FLOOR_KIND,
      message: `${spec.id} runner fully forfeited — ${spec.concurrency} slots held by zombie handlers`,
      data: report,
    });
  }
}

function tripFloor(usable: number): void {
  const trips = recordTrip();
  const suppressed = trips > MAX_TRIPS_PER_WINDOW;

  const report = describe(
    LONGEST_CLASS_RUNNER.id,
    suppressed ? "degraded" : "crashed",
    suppressed,
    trips,
  );
  const summary =
    `[jobs] the ${LONGEST_CLASS_RUNNER.id} runner — the only one serving ${LONGEST_HOLD} work — ` +
    `has ${usable} usable slot(s) of ${LONGEST_CLASS_RUNNER.concurrency}; the rest are held by ` +
    `handlers that ignored their deadline`;

  if (suppressed) {
    // An automatic restart that fixes nothing is worse than an honest wedge:
    // after this many trips in the window, the next boot would almost certainly
    // reach the same state, and a backend that keeps vanishing is harder to
    // diagnose than one that is up and loudly broken.
    console.error(
      `${summary}. STAYING UP: this worktree has already tripped the floor ${trips} time(s) ` +
        `within the last ${LATCH_WINDOW_MS} ms, so the exit is suppressed — another restart ` +
        `would not fix what is holding these slots.`,
    );
    reportServerFatalSync({
      kind: JOB_SLOT_FLOOR_KIND,
      message: `${LONGEST_CLASS_RUNNER.id} runner below its slot floor — restart suppressed by the anti-loop latch`,
      data: report,
    });
    return;
  }

  console.error(`${summary}. Exiting so Postgres drops the locks.`);
  // Synchronous by contract — `reportServerFatalSync` has completed its durable
  // write (one appended JSONL line, replayed on the next boot) before it
  // returns, which is the only reason a report can exist at all on this path.
  reportServerFatalSync({
    kind: JOB_SLOT_FLOOR_KIND,
    message: `${LONGEST_CLASS_RUNNER.id} runner below its slot floor (${usable}/${LONGEST_CLASS_RUNNER.concurrency} usable) — backend exited`,
    data: report,
  });
  process.exit(1);
}

function describe(
  runnerId: string,
  action: "crashed" | "degraded",
  restartSuppressed: boolean,
  tripsThisWindow: number,
): JobSlotFloorReport {
  const spec = RUNNERS.find((r) => r.id === runnerId)!;
  const now = Date.now();
  return {
    action,
    restartSuppressed,
    runnerId,
    serves: [...spec.serves],
    usable: usableSlots(runnerId),
    concurrency: spec.concurrency,
    minUsableSlots: MIN_USABLE_SLOTS,
    holders: getForfeitedSlots()
      .filter((e) => e.runnerId === runnerId)
      .map((e) => ({
        jobId: e.jobId,
        jobName: e.jobName,
        hold: e.hold,
        heldMs: now - e.since,
      })),
    tripsThisWindow,
    maxTripsPerWindow: MAX_TRIPS_PER_WINDOW,
    windowMs: LATCH_WINDOW_MS,
  };
}

// ─── The anti-loop latch ──────────────────────────────────────────────────
//
// See `jobs/data-dirs/index.ts` for why a duration is legitimate HERE and
// nowhere else in this plugin: it governs our own restart policy and makes no
// claim about whether any worker is alive.

const LATCH_WINDOW_MS = 3_600_000;
const MAX_TRIPS_PER_WINDOW = 3;

function latchFile(): string {
  return jobsStateDir.file(`${runtimeNamespace()}.json`);
}

/**
 * Record that this worktree has tripped the floor, and return how many trips
 * (including this one) fall inside the window.
 *
 * Written BEFORE the exit and synchronously, for the same reason the report is:
 * there is no "after". A failure to read or write is not fatal — the cost is
 * that the budget is re-armed, which risks one extra restart of a backend whose
 * widest runner is already dead. Losing the exit itself would be worse, so this
 * never throws into the caller.
 */
function recordTrip(): number {
  const now = Date.now();
  let trips: number[] = [];
  try {
    const raw = readFileSync(latchFile(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { trips?: unknown }).trips)
    ) {
      trips = (parsed as { trips: unknown[] }).trips.filter(
        (t): t is number => typeof t === "number",
      );
    }
  } catch (err) {
    // ENOENT is the ordinary first-ever case. Anything else (a truncated file
    // from a kill mid-write, a corrupt line) is reported and treated as an
    // empty history — the latch is a backstop, and refusing to exit because we
    // could not read it would be the worse failure.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[jobs] floor latch unreadable, treating as empty:`, err);
    }
  }

  const recent = trips.filter((t) => now - t < LATCH_WINDOW_MS);
  recent.push(now);
  try {
    jobsStateDir.ensure();
    writeFileSync(latchFile(), JSON.stringify({ trips: recent }));
    // eslint-disable-next-line promise-safety/no-bare-catch -- every failure mode here (dir creation, disk IO, a kill mid-write) maps to the same handling, and this runs on the way OUT: the caller's next statement is process.exit(1). Rethrowing would replace a deliberate exit with an unhandled rejection and lose the exit itself, which is strictly worse than losing one latch entry — the cost of that loss is bounded at one extra restart of a backend whose widest runner is already dead. Same crash-path argument as reports/plugins/engine/server/internal/buffer.ts.
  } catch (err) {
    console.warn(`[jobs] floor latch not persisted:`, err);
  }
  return recent.length;
}
