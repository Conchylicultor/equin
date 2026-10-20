import { dlopen, ptr } from "bun:ffi";
import type {
  PeerMemory,
  ProcMemory,
} from "@plugins/framework/plugins/server-core/core";

// macOS phys_footprint — the real per-process memory the kernel charges against
// the memory-pressure limit, and the number Activity Monitor shows. This is the
// metric to trust: `process.memoryUsage().rss` on macOS over-counts ~6× because
// it includes resident-but-clean/reserved pages (JSC bmalloc, the 65 GB JS-VM
// Gigacage virtual reservation, GPU regions) that are not real physical cost.
// See research/2026-06-18-global-backend-rss-reduction.md (Findings + R1).
//
// We read it via libproc's proc_pid_rusage(RUSAGE_INFO_V0), which takes a pid
// directly (no mach_task_self() dance) and fills a rusage_info_v0 struct whose
// ri_phys_footprint (uint64) sits at byte offset 72:
//
//   struct rusage_info_v0 {            // offset
//     uint8_t  ri_uuid[16];            //  0
//     uint64_t ri_user_time;           // 16
//     uint64_t ri_system_time;         // 24
//     uint64_t ri_pkg_idle_wkups;      // 32
//     uint64_t ri_interrupt_wkups;     // 40
//     uint64_t ri_pageins;             // 48
//     uint64_t ri_wired_size;          // 56
//     uint64_t ri_resident_size;       // 64
//     uint64_t ri_phys_footprint;      // 72  ← target
//     uint64_t ri_proc_start_abstime;  // 80
//     uint64_t ri_proc_exit_abstime;   // 88
//   };                                 // size 96

const RUSAGE_INFO_V0 = 0;
const RESIDENT_SIZE_OFFSET = 64;
const PHYS_FOOTPRINT_OFFSET = 72;
const BUF_BYTES = 128; // ≥ sizeof(rusage_info_v0)=96, padded for forward-compat

// Lazily dlopen so this module stays importable in non-FFI contexts (it is only
// ever exercised under Bun on the server). Mirrors worktree-op.ts's flock binding.
let procPidRusage: ((pid: number, flavor: number, buf: unknown) => number) | null = null;
function bind(): typeof procPidRusage {
  if (!procPidRusage) {
    // libSystem (via libc.dylib) re-exports libproc, where proc_pid_rusage lives.
    const { symbols } = dlopen("libc.dylib", {
      proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" },
    });
    procPidRusage = symbols.proc_pid_rusage as (
      pid: number,
      flavor: number,
      buf: unknown,
    ) => number;
  }
  return procPidRusage;
}

/** One `proc_pid_rusage` read; `null` when the kernel refused it. */
function readRusage(pid: number): ProcMemory | null {
  const buf = new Uint8Array(BUF_BYTES);
  const rc = bind()!(pid, RUSAGE_INFO_V0, ptr(buf));
  if (rc !== 0) return null;
  const view = new DataView(buf.buffer);
  return {
    physFootprintBytes: Number(view.getBigUint64(PHYS_FOOTPRINT_OFFSET, true)),
    residentSizeBytes: Number(view.getBigUint64(RESIDENT_SIZE_OFFSET, true)),
  };
}

/**
 * Physical memory metrics of `pid` (defaults to this process) from one
 * `proc_pid_rusage` syscall — the desktop's memory probe, installed into
 * `core`'s `procMemory()` by `./host-probes` (bun:ffi exists on this host only).
 *
 * Returns `null` on non-macOS platforms (no phys_footprint equivalent; callers
 * fall back to `process.memoryUsage().rss`). On macOS a non-zero syscall return
 * throws — a broken FFI binding must fail loudly, never silently degrade.
 */
export function macProcMemory(pid: number = process.pid): ProcMemory | null {
  if (process.platform !== "darwin") return null;
  const read = readRusage(pid);
  if (read === null) {
    throw new Error(`proc_pid_rusage(${pid}) failed`);
  }
  return read;
}

/**
 * Another process's metrics — `core`'s `peerProcMemory()`. The kernel refuses
 * another account's process (EPERM) and one that exited since it was listed
 * (ESRCH): both are answers here. A broken binding still fails loudly through
 * `macProcMemory` on this process, which every caller reads first.
 */
export function macPeerProcMemory(pid: number): PeerMemory {
  if (process.platform !== "darwin") return { kind: "unsupported" };
  const read = readRusage(pid);
  return read === null
    ? { kind: "unreadable" }
    : { kind: "read", memory: read };
}
