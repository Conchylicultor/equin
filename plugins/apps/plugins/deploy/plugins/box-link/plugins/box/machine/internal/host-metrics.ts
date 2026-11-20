import { cpus, loadavg, totalmem, uptime } from "node:os";
import { statfs } from "node:fs/promises";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import {
  readHostMemory,
  type HostMemoryIo,
} from "@plugins/packages/plugins/host-memory/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import type { BoxHostMetrics } from "@plugins/apps/plugins/deploy/plugins/box-link/core";

/** Cumulative CPU time, all cores: how much of it was busy, out of how much. */
export interface CpuTicks {
  busy: number;
  total: number;
}

/**
 * The aggregate `cpu` line of Linux's `/proc/stat` as busy / total ticks.
 * Idle is `idle + iowait` (a core waiting on the disk runs nothing); busy is
 * everything else, `steal` included — on a shared VPS time the hypervisor
 * gave another guest is time this box did not get. Throws on a file without
 * the line (a changed format must not read as an idle box).
 */
export function parseProcStatCpu(text: string): CpuTicks {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (line === undefined) {
    throw new Error("box-link: /proc/stat has no aggregate `cpu` line");
  }
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((n) => !Number.isFinite(n))) {
    throw new Error(`box-link: unreadable /proc/stat cpu line: ${line}`);
  }
  // user nice system idle iowait irq softirq steal [guest guest_nice] — guest
  // time is already counted in user / nice, so it is not added again.
  const [
    user,
    nice,
    system,
    idle,
    iowait = 0,
    irq = 0,
    softirq = 0,
    steal = 0,
  ] = fields as [number, number, number, number, ...number[]];
  const idleAll = idle + iowait;
  const busy = user + nice + system + irq + softirq + steal;
  return { busy, total: busy + idleAll };
}

/** The `os.cpus()` tick counters summed over every core (macOS, any non-Linux). */
function osCpuTicks(): CpuTicks {
  let busy = 0;
  let total = 0;
  for (const { times } of cpus()) {
    const b = times.user + times.nice + times.sys + times.irq;
    busy += b;
    total += b + times.idle;
  }
  return { busy, total };
}

/** Busy share (0–100) between two readings; `null` when no time passed. */
export function busyPctBetween(prev: CpuTicks, next: CpuTicks): number | null {
  const total = next.total - prev.total;
  if (total <= 0) return null;
  const pct = ((next.busy - prev.busy) / total) * 100;
  return Math.min(100, Math.max(0, pct));
}

async function readCpuTicks(): Promise<CpuTicks> {
  return process.platform === "linux"
    ? parseProcStatCpu(await readFile("/proc/stat", "utf8"))
    : osCpuTicks();
}

// `vm_stat` (macOS — a demo's stand-in box) bounded well under the beat.
const memoryIo: HostMemoryIo = {
  run: async (argv) => (await spawnExpectOk(argv, { timeoutMs: 5_000 })).stdout,
  readText: (path) => readFile(path, "utf8"),
};

/**
 * One stream's sampler: each `read()` measures the host now, its CPU busy
 * share over the time since the previous `read()` of THIS sampler (`null` on
 * the first). Memory is what `packages/host-memory` reads (in use = total
 * minus what the system can hand out); disk the filesystem holding the
 * install (`REPO_ROOT`). Throws on a host it cannot read — a failed beat ends
 * the stream loudly rather than sending made-up meters.
 */
export function createHostSampler(): { read(): Promise<BoxHostMetrics> } {
  let prev: CpuTicks | null = null;
  return {
    async read() {
      const [ticks, memory, disk] = await Promise.all([
        readCpuTicks(),
        readHostMemory(process.platform, memoryIo),
        statfs(REPO_ROOT),
      ]);
      if (memory.kind === "unsupported") {
        throw new Error(
          `box-link: cannot read host memory on ${memory.platform}`,
        );
      }
      const busyPct = prev === null ? null : busyPctBetween(prev, ticks);
      prev = ticks;
      const memTotal = totalmem();
      // df's arithmetic: used blocks, and a total of used + what an
      // unprivileged process may still write (root's reserve left out).
      const diskUsed = (disk.blocks - disk.bfree) * disk.bsize;
      const diskTotal = diskUsed + disk.bavail * disk.bsize;
      return {
        cpu: {
          busyPct,
          cores: cpus().length,
          load1: loadavg()[0] ?? 0,
        },
        mem: {
          used: Math.max(0, memTotal - memory.memory.availableBytes),
          total: memTotal,
        },
        disk: {
          used: diskUsed,
          total: diskTotal,
        },
        uptimeSec: Math.round(uptime()),
      };
    },
  };
}
