import { dlopen, ptr } from "bun:ffi";

// One process's kernel usage record: libproc's proc_pid_rusage(RUSAGE_INFO_V4),
// which takes a pid directly (no mach_task_self() dance) and fills a
// rusage_info_v4 struct (v1's fields at the same offsets, then v2-v4's):
//
//   struct rusage_info_v1 {            // offset
//     uint8_t  ri_uuid[16];            //  0
//     uint64_t ri_user_time;           // 16
//     uint64_t ri_system_time;         // 24
//     uint64_t ri_pkg_idle_wkups;      // 32
//     uint64_t ri_interrupt_wkups;     // 40
//     uint64_t ri_pageins;             // 48
//     uint64_t ri_wired_size;          // 56
//     uint64_t ri_resident_size;       // 64
//     uint64_t ri_phys_footprint;      // 72
//     uint64_t ri_proc_start_abstime;  // 80
//     uint64_t ri_proc_exit_abstime;   // 88
//     uint64_t ri_child_user_time;     // 96   (v1)
//     uint64_t ri_child_system_time;   // 104  (v1)
//     …                                //      (v1 wakeups, pageins, elapsed;
//                                      //       v2 disk io; v3 qos times)
//     uint64_t ri_logical_writes;              // 232  (v4)
//     uint64_t ri_lifetime_max_phys_footprint; // 240  (v4)
//     …                                //      (instructions, cycles, energy,
//                                      //       interval max, runnable time)
//   };                                 // size 296
//
// ri_lifetime_max_phys_footprint is the PEAK of ri_phys_footprint over the
// process's whole life: the only honest "how much memory did this run need".
// getrusage's ru_maxrss (Bun's `resourceUsage().maxRSS`) is the peak RESIDENT
// size instead, which keeps counting allocator pages the process already freed
// (MADV_FREE-reusable, JSC's "Memory Tag 240") and shared library text — on a
// type-check worker 1.8 GB against a 1.15 GB footprint
// (research/2026-11-12-global-type-check-worker-memory-split.md). Checked
// 2026-11-13: a 1 GB allocation, freed, leaves the footprint at 33 MB, the
// resident size at 1,044 MB and this peak at 1,034 MB.
//
// ri_phys_footprint is the memory the kernel charges against memory pressure
// and what Activity Monitor shows (`process.memoryUsage().rss` over-counts Bun
// ~6×: research/2026-06-18-global-backend-rss-reduction.md). The child times
// are those of every child the process reaped — already holding what each
// child reaped — the only trace a short-lived process leaves once it exited.
//
// The five times are in mach absolute-time units, NOT ns: on Apple silicon one
// unit is 125/3 ns (`mach_timebase_info`), so they are scaled by the timebase.
// Checked 2026-11-06: user + system, scaled, equals `ps -o time` to the 10 ms.

const RUSAGE_INFO_V4 = 4;
const USER_TIME_OFFSET = 16;
const SYSTEM_TIME_OFFSET = 24;
const RESIDENT_SIZE_OFFSET = 64;
const PHYS_FOOTPRINT_OFFSET = 72;
const PROC_START_ABSTIME_OFFSET = 80;
const CHILD_USER_TIME_OFFSET = 96;
const CHILD_SYSTEM_TIME_OFFSET = 104;
const LIFETIME_MAX_PHYS_FOOTPRINT_OFFSET = 240;
const BUF_BYTES = 320; // ≥ sizeof(rusage_info_v4)=296, padded for forward-compat

export type ProcRusage =
  | {
      kind: "read";
      memory: {
        physFootprintBytes: number;
        residentSizeBytes: number;
        /** The highest `physFootprintBytes` the process has had, over its life. */
        peakPhysFootprintBytes: number;
      };
      /** CPU time, ns: the process's own (user + system), and its reaped children's. */
      cpu: { ownNs: number; reapedChildrenNs: number };
      /**
       * When the process started, ns on the machine's monotonic clock (since
       * boot): a pid the kernel reused reads a different one.
       */
      startedNs: number;
    }
  /** The kernel refused: another account's process, or one gone since. */
  | { kind: "refused" }
  /** Not macOS: no such record. */
  | { kind: "unsupported" };

interface Binding {
  procPidRusage: (pid: number, flavor: number, buf: unknown) => number;
  /** ns per mach absolute-time unit. */
  nsPerTick: number;
}

// Lazily dlopen'd, so the module stays importable where it is never read.
let binding: Binding | null = null;
function bind(): Binding {
  if (!binding) {
    // libSystem (via libc.dylib) re-exports libproc, where proc_pid_rusage
    // lives, and mach_timebase_info.
    const { symbols } = dlopen("libc.dylib", {
      proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" },
      mach_timebase_info: { args: ["ptr"], returns: "i32" },
    });
    const timebase = new Uint32Array(2); // { numer, denom }
    if (symbols.mach_timebase_info(ptr(timebase)) !== 0 || timebase[1] === 0) {
      throw new Error("[proc-rusage] mach_timebase_info failed");
    }
    binding = {
      procPidRusage: symbols.proc_pid_rusage as Binding["procPidRusage"],
      nsPerTick: timebase[0]! / timebase[1]!,
    };
  }
  return binding;
}

/** One `proc_pid_rusage` read of `pid`. */
export function readProcRusage(pid: number): ProcRusage {
  if (process.platform !== "darwin") return { kind: "unsupported" };
  const { procPidRusage, nsPerTick } = bind();
  const buf = new Uint8Array(BUF_BYTES);
  if (procPidRusage(pid, RUSAGE_INFO_V4, ptr(buf)) !== 0) {
    return { kind: "refused" };
  }
  const view = new DataView(buf.buffer);
  const u64 = (offset: number) => Number(view.getBigUint64(offset, true));
  const ns = (offset: number) => u64(offset) * nsPerTick;
  return {
    kind: "read",
    memory: {
      physFootprintBytes: u64(PHYS_FOOTPRINT_OFFSET),
      residentSizeBytes: u64(RESIDENT_SIZE_OFFSET),
      peakPhysFootprintBytes: u64(LIFETIME_MAX_PHYS_FOOTPRINT_OFFSET),
    },
    cpu: {
      ownNs: ns(USER_TIME_OFFSET) + ns(SYSTEM_TIME_OFFSET),
      reapedChildrenNs:
        ns(CHILD_USER_TIME_OFFSET) + ns(CHILD_SYSTEM_TIME_OFFSET),
    },
    startedNs: ns(PROC_START_ABSTIME_OFFSET),
  };
}
