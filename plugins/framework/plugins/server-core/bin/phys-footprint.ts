import {
  readProcRusage,
  readProcRusageSync,
} from "@plugins/packages/plugins/proc-rusage/core";
import type {
  PeerUsage,
  ProcMemory,
} from "@plugins/framework/plugins/server-core/core";

// A process's memory as the kernel charges it — macOS phys_footprint; on Linux
// procfs's Pss of anonymous + shared memory, in the same terms as the host's
// AnonPages + Shmem (packages/proc-rusage). macOS's footprint is the real per-process memory the kernel charges against
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
 * Physical memory metrics of `pid` (defaults to this process) from its usage
 * record (`proc_pid_rusage` on macOS, procfs on Linux) — the desktop's memory probe, installed into
 * `core`'s `procMemory()` by `./host-probes` (bun:ffi exists on this host only).
 *
 * Returns `null` on an OS with neither (callers fall back to
 * `process.memoryUsage().rss`). A refused read of this process throws — a
 * broken binding must fail loudly, never silently degrade.
 */
export function hostProcMemory(pid: number = process.pid): ProcMemory | null {
  const read = readProcRusageSync(pid);
  if (read.kind === "unsupported") return null;
  if (read.kind === "refused") {
    throw new Error(
      `[server-core] reading process ${pid}'s usage record was refused`,
    );
  }
  return read.memory;
}

/**
 * Another process's memory and CPU — `core`'s `peerProcUsage()`, shared pages
 * charged proportionally where the OS can (Linux's Pss, read off the thread).
 * The kernel refuses another account's process and one that exited since it
 * was listed: both are answers here. A broken binding still fails loudly
 * through `hostProcMemory` on this process, which every caller reads first.
 */
export async function hostPeerProcUsage(pid: number): Promise<PeerUsage> {
  const read = await readProcRusage(pid);
  switch (read.kind) {
    case "unsupported":
      return { kind: "unsupported" };
    case "refused":
      return { kind: "unreadable" };
    case "read":
      return { kind: "read", memory: read.memory, cpu: read.cpu };
  }
}
