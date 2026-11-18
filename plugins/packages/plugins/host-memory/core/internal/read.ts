import {
  HOST_MEMORY_PLATFORMS,
  hostMemoryFromProc,
  hostMemoryFromVmStat,
  type HostMemory,
  type HostMemoryPlatform,
} from "./host-memory";
import { parseMeminfo, parseProcVmstat } from "./proc-meminfo";
import { parseVmStat } from "./vm-stat";

/**
 * The two reads a host memory reading takes, supplied by the caller: `core/`
 * runs on every host, so it names WHAT to read (a command's stdout on macOS,
 * two files on Linux) and the caller — a desktop process — does the reading.
 * Both throw on failure (a non-zero exit, a missing file).
 */
export interface HostMemoryIo {
  /** Run `argv`, bounded well under the caller's cadence; its stdout. */
  run(argv: string[]): Promise<string>;
  /** A file's text. */
  readText(path: string): Promise<string>;
}

/** A host memory read: the reading, or the OS it cannot be read on. */
export type HostMemoryRead =
  | { kind: "read"; memory: HostMemory }
  | { kind: "unsupported"; platform: string };

function isHostMemoryPlatform(p: string): p is HostMemoryPlatform {
  return (HOST_MEMORY_PLATFORMS as readonly string[]).includes(p);
}

/**
 * Read the host's memory from its OS's own counters: `vm_stat` on macOS,
 * `/proc/meminfo` + `/proc/vmstat` on Linux. Throws when a read fails or lacks
 * a counter (a renamed line must not read as "no memory"); answers
 * `unsupported` on an OS with no reader here. `platform` is the host's
 * `process.platform`.
 */
export async function readHostMemory(
  platform: string,
  io: HostMemoryIo,
): Promise<HostMemoryRead> {
  if (!isHostMemoryPlatform(platform)) return { kind: "unsupported", platform };
  switch (platform) {
    case "darwin":
      return {
        kind: "read",
        memory: hostMemoryFromVmStat(parseVmStat(await io.run(["vm_stat"]))),
      };
    case "linux": {
      const [meminfo, vmstat] = await Promise.all([
        io.readText("/proc/meminfo"),
        io.readText("/proc/vmstat"),
      ]);
      return {
        kind: "read",
        memory: hostMemoryFromProc(
          parseMeminfo(meminfo),
          parseProcVmstat(vmstat),
        ),
      };
    }
  }
}
