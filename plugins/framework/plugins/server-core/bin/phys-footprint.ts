import { readProcRusage } from "@plugins/packages/plugins/proc-rusage/core";
import type {
  PeerUsage,
  ProcMemory,
} from "@plugins/framework/plugins/server-core/core";

// macOS phys_footprint — the real per-process memory the kernel charges against
// the memory-pressure limit, and the number Activity Monitor shows. This is the
// metric to trust: `process.memoryUsage().rss` on macOS over-counts ~6× because
// it includes resident-but-clean/reserved pages (JSC bmalloc, the 65 GB JS-VM
// Gigacage virtual reservation, GPU regions) that are not real physical cost.
// See research/2026-06-18-global-backend-rss-reduction.md (Findings + R1).
//
// Read from the process's kernel usage record (packages/proc-rusage), which
// also carries its CPU time and its reaped children's — what `peerProcUsage`
// hands on.

/**
 * Physical memory metrics of `pid` (defaults to this process) from one
 * `proc_pid_rusage` syscall — the desktop's memory probe, installed into
 * `core`'s `procMemory()` by `./host-probes` (bun:ffi exists on this host only).
 *
 * Returns `null` on non-macOS platforms (no phys_footprint equivalent; callers
 * fall back to `process.memoryUsage().rss`). On macOS a refused read throws — a
 * broken FFI binding must fail loudly, never silently degrade.
 */
export function macProcMemory(pid: number = process.pid): ProcMemory | null {
  const read = readProcRusage(pid);
  if (read.kind === "unsupported") return null;
  if (read.kind === "refused") {
    throw new Error(`proc_pid_rusage(${pid}) failed`);
  }
  return read.memory;
}

/**
 * Another process's memory and CPU — `core`'s `peerProcUsage()`. The kernel
 * refuses another account's process (EPERM) and one that exited since it was
 * listed (ESRCH): both are answers here. A broken binding still fails loudly
 * through `macProcMemory` on this process, which every caller reads first.
 */
export function macPeerProcUsage(pid: number): PeerUsage {
  const read = readProcRusage(pid);
  switch (read.kind) {
    case "unsupported":
      return { kind: "unsupported" };
    case "refused":
      return { kind: "unreadable" };
    case "read":
      return { kind: "read", memory: read.memory, cpu: read.cpu };
  }
}
