import { watch, type FSWatcher } from "node:fs";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import type {
  CapacityFeed,
  CapacityFollow,
} from "@plugins/packages/plugins/host-semaphore/server";
import {
  admissionSlots,
  fleetAdmission,
  FLEET_MEMORY_LEASE_MS,
  FleetMemoryReadingSchema,
  laneCapacity,
  type FleetAdmission,
  type FleetMemoryReading,
  type Lane,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { fleetMemoryDir } from "../../data-dirs";

// The fleet memory reading as a host-wide file: one writer (main's owner
// sampler, every 30 s), read by every `cpu` grant acquire in every process —
// and FOLLOWED by every one that waits. A file, like the duress latch: no DB,
// no socket, readable by a CLI with no backend around it. The math is `core`'s
// `fleetAdmission`; this is only the channel.

const FILENAME = "fleet-memory.json";

/** Write one reading, atomically (a reader never sees half a file). */
export async function publishFleetMemory(
  reading: FleetMemoryReading,
  dir: AppPath = fleetMemoryDir.path,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = joinAppPath(dir, `${FILENAME}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(FleetMemoryReadingSchema.parse(reading)));
  await rename(tmp, joinAppPath(dir, FILENAME));
}

/** The latest reading, or `null` when none was ever written. */
async function readFleetReading(
  dir: AppPath,
): Promise<FleetMemoryReading | null> {
  let raw: string;
  try {
    raw = await readFile(joinAppPath(dir, FILENAME), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  // A malformed file is a writer bug: parse throws, loudly.
  return FleetMemoryReadingSchema.parse(JSON.parse(raw));
}

/** What admission acts on now, from the file on disk. */
async function readFleetAdmission(dir: AppPath): Promise<FleetAdmission> {
  return fleetAdmission(await readFleetReading(dir), Date.now());
}

/**
 * The `cpu` pool capacity one acquire in `lane` may use, as a feed the acquire
 * follows while it waits (`AcquireHooks.capacity`): `laneCapacity` of the
 * admission window, re-derived on every write of the reading and once more
 * when the reading's lease runs out — so a waiter hears the window widen (or
 * shrink, or fall to the unmeasured floor) the moment it does, instead of
 * waiting inside the window it queued in.
 *
 * `onAdmission` hears every admission state the feed acts on (the first, then
 * each one that moves the capacity), for the words a waiter shows and for the
 * unmeasured report.
 *
 * Push-based: one non-persistent `fs.watch` on the reading's directory per
 * waiting acquire (the reading is renamed into place, which the directory
 * reports), plus one timer for the lease's end — a deadline the reading
 * itself names, not a poll.
 */
export function fleetCapacity(
  lane: Lane,
  onAdmission: (admission: FleetAdmission) => void,
  dir: AppPath = fleetMemoryDir.path,
): CapacityFeed {
  const capacityOf = (a: FleetAdmission): number =>
    laneCapacity(admissionSlots(a), lane);
  return {
    read: async () => {
      const admission = await readFleetAdmission(dir);
      onAdmission(admission);
      return capacityOf(admission);
    },
    follow: async (onMove, onFail) => {
      // `fs.watch` throws ENOENT on a missing directory, and the directory
      // appears only with main's first reading — mint it so the watch hears it.
      await mkdir(dir, { recursive: true });
      let stopped = false;
      // What was last handed out: the capacity (a move is a change of it) and
      // the admission's kind (measured ↔ unmeasured is news even at one
      // capacity — the unmeasured report rides it).
      let delivered:
        { capacity: number; kind: FleetAdmission["kind"] } | undefined;
      let leaseEnd: ReturnType<typeof setTimeout> | undefined;
      // Until the first evaluation has settled, its failure is the follow's
      // own (thrown to the caller); after, a failed re-read fails the wait.
      let starting = true;
      const fail = (err: unknown): void => {
        if (stopped) return;
        stop();
        onFail(err);
      };
      const evaluate = async (): Promise<void> => {
        const admission = await readFleetAdmission(dir);
        if (stopped) return;
        clearTimeout(leaseEnd);
        // The lease ends with no write when the sampler has stopped: that
        // instant is when admission turns unmeasured, so be there for it.
        // Never later than one lease from now, so a reading stamped in the
        // future cannot overflow the timer into a re-read loop.
        if (admission.kind === "measured")
          leaseEnd = setTimeout(
            () => reread.trigger(),
            Math.min(
              Math.max(0, admission.expiresAtMs - Date.now()),
              FLEET_MEMORY_LEASE_MS,
            ) + 1,
          ).unref();
        const capacity = capacityOf(admission);
        const previous = delivered;
        if (previous?.capacity === capacity && previous.kind === admission.kind)
          return;
        delivered = { capacity, kind: admission.kind };
        onAdmission(admission);
        if (previous !== undefined && previous.capacity !== capacity)
          onMove(capacity);
      };
      // Every evaluation, the first included, runs through this one coalescer:
      // one at a time, so an older read can never land after a newer one and
      // put back a window that has since moved.
      const reread = createCoalescer({
        run: () =>
          evaluate().catch((err: unknown) => {
            if (starting) throw err;
            fail(err);
          }),
      });
      // Not persistent: the watch must never keep a process alive on its own.
      const watcher: FSWatcher = watch(
        dir,
        { persistent: false },
        (_event, filename) => {
          // A null filename is a platform edge: re-read, it costs one read.
          if (filename === null || filename === FILENAME) reread.trigger();
        },
      );
      // Losing the watch would leave the waiter in a window nothing updates —
      // the very defect this feed exists for. Fail the wait, loudly.
      watcher.on("error", fail);
      function stop(): void {
        stopped = true;
        clearTimeout(leaseEnd);
        watcher.close();
      }
      // Armed before this first read, so no write falls between the two.
      try {
        await reread.run();
      } catch (err) {
        stop();
        throw err;
      } finally {
        starting = false;
      }
      if (delivered === undefined)
        throw new Error(
          "fleetCapacity: the first evaluation delivered nothing",
        );
      const latest = delivered;
      const follow: CapacityFollow = {
        // The latest delivered, read when the caller reads it: a write that
        // landed while the first read ran is evaluated after it.
        get capacity() {
          return (delivered ?? latest).capacity;
        },
        stop: async () => {
          stop();
          await reread.settled();
        },
      };
      return follow;
    },
  };
}

/**
 * Claim the right to report one unmeasured episode, host-wide: true for the
 * first acquire of the episode on the whole machine, false for every other.
 * An episode is the reading it outlived (`sampledAt`), or none ever written —
 * so an outage of hours files one report, not one per build, check and test of
 * every agent (which would fill the report outbox's cap and crowd out every
 * other process's reports while main is down).
 *
 * The claim is an exclusive create of a marker beside the reading: atomic
 * across processes, and gone with the directory when it is reclaimed.
 */
export async function claimUnmeasuredEpisode(
  admission: Extract<FleetAdmission, { kind: "unmeasured" }>,
  dir: AppPath = fleetMemoryDir.path,
): Promise<boolean> {
  const episode =
    admission.sampledAt === null ? "absent" : `stale-${admission.sampledAt}`;
  await mkdir(dir, { recursive: true });
  try {
    const marker = await open(
      joinAppPath(dir, `unmeasured-${episode}.reported`),
      "wx",
    );
    await marker.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}
