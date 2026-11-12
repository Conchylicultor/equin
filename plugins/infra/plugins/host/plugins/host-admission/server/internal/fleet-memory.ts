import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import {
  FLEET_MEMORY_LEASE_MS,
  FleetMemoryReadingSchema,
  fleetWindow,
  type FleetMemoryReading,
  type FleetWindow,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { fleetMemoryDir } from "../../data-dirs";

// The fleet memory reading as a host-wide file: one writer (main's owner
// sampler, every 30 s), read by every `cpu` grant acquire in every process.
// A file, like the duress latch: no DB, no socket, readable by a CLI with no
// backend around it. The math is `core`'s `fleetWindow`; this is only the
// channel.

const FILENAME = "fleet-memory.json";

/** Write one reading, atomically (a reader never sees half a file). */
export async function publishFleetMemory(
  reading: FleetMemoryReading,
): Promise<void> {
  const dir = fleetMemoryDir.path;
  await mkdir(dir, { recursive: true });
  const tmp = joinAppPath(dir, `${FILENAME}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(FleetMemoryReadingSchema.parse(reading)));
  await rename(tmp, joinAppPath(dir, FILENAME));
}

/**
 * The fleet window admission acts on now: `measured` from a reading inside its
 * lease, or `unmeasured` (no reading yet, or main's sampler has not written one
 * for longer than the lease) — the caller then admits on the static ceiling
 * `B`, which is all host facts alone can prove, and says so.
 */
export type FleetWindowNow =
  | { kind: "measured"; window: FleetWindow; reading: FleetMemoryReading }
  | { kind: "unmeasured"; reason: string };

export async function readFleetWindow(
  nowMs: number = Date.now(),
): Promise<FleetWindowNow> {
  let raw: string;
  try {
    raw = await readFile(joinAppPath(fleetMemoryDir.path, FILENAME), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "unmeasured", reason: "no fleet memory reading yet" };
    throw err;
  }
  // A malformed file is a writer bug: parse throws, loudly.
  const reading = FleetMemoryReadingSchema.parse(JSON.parse(raw));
  const ageMs = nowMs - reading.sampledAt;
  if (ageMs > FLEET_MEMORY_LEASE_MS) {
    return {
      kind: "unmeasured",
      reason: `the fleet memory reading is ${Math.round(ageMs / 1000)} s old (main's owner sampler is not running)`,
    };
  }
  return { kind: "measured", window: fleetWindow(reading), reading };
}
