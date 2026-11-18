import {
  meminfoAvailableBytes,
  meminfoKernelBytes,
  meminfoProcessBytes,
  type Meminfo,
} from "./proc-meminfo";
import {
  availableMemBytes,
  processMemBytes,
  wiredMemBytes,
  type VmStat,
} from "./vm-stat";

// The host's memory, one shape on every OS equin runs on: what the host
// sampler (debug/health-monitor) charts and what main's owner sampler
// (debug/sentinel/machine-usage) hands host admission. Derived here from the
// OS's own counters — `vm_stat` on macOS, `/proc/meminfo` + `/proc/vmstat` on
// Linux — so no consumer reads either format itself, and a new OS is one more
// arm here rather than a `process.platform` check at every caller.

/** The platforms whose memory can be read (`readHostMemory`). */
export const HOST_MEMORY_PLATFORMS = ["darwin", "linux"] as const;
export type HostMemoryPlatform = (typeof HOST_MEMORY_PLATFORMS)[number];

export interface HostMemory {
  platform: HostMemoryPlatform;
  /** What the system can hand out without swapping (macOS free + speculative + inactive; Linux MemAvailable). */
  availableBytes: number;
  /** Kernel memory in no process's footprint (macOS wired pages; Linux RAM neither free, on a page LRU nor reclaimable slab — slab, stacks, page tables, vmalloc, huge pages, zswap/zram pools, drivers). */
  kernelBytes: number;
  /** RAM processes hold (macOS anonymous + compressor pages; Linux AnonPages + Shmem). */
  processBytes: number;
  /** RAM the memory compressor occupies (macOS compressor pages; Linux the zswap pool, 0 without one). */
  compressorBytes: number;
  /**
   * Cumulative counters since boot, for rates: pages swapped in / out, and
   * pages compressed / decompressed (0 where the OS has no compressor). Pages
   * are the OS's own (16 KB on Apple Silicon macOS, 4 KB on most Linux).
   * `null` where the OS does not state them (a Linux kernel without VM event
   * counters, a sandbox's thin /proc/vmstat): charts lose their rates, but the
   * memory reading admission needs does not depend on them.
   */
  counters: HostMemoryCounters | null;
}

export interface HostMemoryCounters {
  swapIns: number;
  swapOuts: number;
  compressions: number;
  decompressions: number;
}

/** macOS: one `vm_stat` reading. */
export function hostMemoryFromVmStat(vm: VmStat): HostMemory {
  return {
    platform: "darwin",
    availableBytes: availableMemBytes(vm),
    kernelBytes: wiredMemBytes(vm),
    processBytes: processMemBytes(vm),
    compressorBytes:
      (vm.map["Pages occupied by compressor"] ?? 0) * vm.pageSize,
    counters: {
      swapIns: vm.map["Swapins"] ?? 0,
      swapOuts: vm.map["Swapouts"] ?? 0,
      compressions: vm.map["Compressions"] ?? 0,
      decompressions: vm.map["Decompressions"] ?? 0,
    },
  };
}

/**
 * Linux: `/proc/meminfo` and `/proc/vmstat`. The counters are stated when
 * `/proc/vmstat` has `pswpin` / `pswpout`, else null; zswap's (`zswpout` /
 * `zswpin`) are 0 where the kernel has none.
 */
export function hostMemoryFromProc(
  meminfo: Meminfo,
  vmstat: Record<string, number>,
): HostMemory {
  const swapIns = vmstat["pswpin"];
  const swapOuts = vmstat["pswpout"];
  return {
    platform: "linux",
    availableBytes: meminfoAvailableBytes(meminfo),
    kernelBytes: meminfoKernelBytes(meminfo),
    processBytes: meminfoProcessBytes(meminfo),
    compressorBytes: meminfo["Zswap"] ?? 0,
    counters:
      swapIns === undefined || swapOuts === undefined
        ? null
        : {
            swapIns,
            swapOuts,
            compressions: vmstat["zswpout"] ?? 0,
            decompressions: vmstat["zswpin"] ?? 0,
          },
  };
}
