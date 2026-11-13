import { cpus, totalmem } from "node:os";
import {
  peerProcUsage,
  procMemory,
} from "@plugins/framework/plugins/server-core/core";
import { readAgentBrowserStatus } from "@plugins/infra/plugins/mcp/plugins/browser/server";
import { listCpuHolders } from "@plugins/infra/plugins/host/plugins/host-admission/server";
import type { CpuHolderMarker } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { listActiveWorktreeOps } from "@plugins/infra/plugins/worktree/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  attributeProcesses,
  machineUsage,
  parsePs,
  postgresForkTrees,
  PS_COLUMNS,
  sumByBucket,
  type MachineUsage,
  type MachineUsageBucket,
  type PsProcess,
} from "../../core";
import { measureForkTrees } from "./fork-memory/host";

const PS_MS = 5_000;

/** The agent browser host's pid while it runs — its tree is that bucket. */
async function agentBrowserRoot(): Promise<number | null> {
  const status = await readAgentBrowserStatus();
  return status.kind === "running" ? status.host.pid : null;
}

/**
 * Fills in what the kernel tells about each process beyond `ps`: its CPU time
 * at ns precision and that of the children it reaped (`reapedChildrenMs`),
 * and returns each process's memory. A Postgres process's is its private
 * memory, the cluster's shared segment charged once to its postmaster
 * (measured on the fork-memory worker); any other's is its physical footprint
 * (what Activity Monitor shows; `ps`'s resident size over-counts Bun ~6×),
 * else, for a process the kernel will not report on (another account's, or
 * exited since `ps` listed it), its resident size. This process is read first
 * through the throwing probe, so a broken binding fails the read instead of
 * degrading every process to `ps`'s numbers.
 *
 * Also each process's LIFETIME peak footprint (the kernel keeps it after the
 * memory is given back), for a `cpu` holder's recorded peak: a spike between
 * two readings is still in it. Where the kernel does not answer, the memory
 * read now stands in.
 */
async function readKernelUsage(procs: PsProcess[]): Promise<{
  memBytesOf: (p: PsProcess) => number;
  peakBytesOf: (p: PsProcess) => number;
}> {
  if (procMemory() === null)
    return { memBytesOf: (p) => p.rssBytes, peakBytesOf: (p) => p.rssBytes };
  const memBytes = new Map<number, number>();
  const peakBytes = new Map<number, number>();
  for (const p of procs) {
    const read = peerProcUsage(p.pid);
    if (read.kind !== "read") continue;
    memBytes.set(p.pid, read.memory.physFootprintBytes);
    peakBytes.set(p.pid, read.memory.peakPhysFootprintBytes);
    p.cpuTimeMs = read.cpu.ownNs / 1e6;
    p.reapedChildrenMs = read.cpu.reapedChildrenNs / 1e6;
  }
  // Read after the footprints, so a process the walk measured wins.
  const forked = await measureForkTrees(postgresForkTrees(procs));
  for (const [pid, bytes] of forked) memBytes.set(pid, bytes);
  const memBytesOf = (p: PsProcess): number =>
    memBytes.get(p.pid) ?? p.rssBytes;
  return {
    memBytesOf,
    peakBytesOf: (p) => peakBytes.get(p.pid) ?? memBytesOf(p),
  };
}

/** Every process on the machine, each with its bucket and memory reader. */
export interface AttributedProcesses {
  procs: PsProcess[];
  /** Every live `cpu` share's holder marker: their trees are agent ops too. */
  holders: CpuHolderMarker[];
  owner: Map<number, MachineUsageBucket>;
  memBytesOf: (p: PsProcess) => number;
  /** A process's lifetime peak footprint (its memory now where unknown). */
  peakBytesOf: (p: PsProcess) => number;
}

/**
 * One `ps` over every process, each attributed to the bucket of the root it
 * descends from (the agent browser host, a running op's CLI process, a named
 * backend / agent / Postgres) or by what it runs (Chrome).
 */
export async function readAttributedProcesses(): Promise<AttributedProcesses> {
  const [ps, ops, holders] = await Promise.all([
    spawnExpectOk(["ps", "-A", "-o", PS_COLUMNS], { timeoutMs: PS_MS }),
    listActiveWorktreeOps(),
    listCpuHolders(),
  ]);
  const procs = parsePs(ps.stdout);
  const { memBytesOf, peakBytesOf } = await readKernelUsage(procs);
  const owner = attributeProcesses(procs, {
    agentBrowser: await agentBrowserRoot(),
    // A share's holder is admitted work wherever it runs — an op's CLI, or a
    // backend's supervised job child (charged to its backend before, so its
    // memory sat in "the rest of the machine" while its slot reserved a
    // quantum on top).
    agentOps: [...ops.map((o) => o.pid), ...holders.map((h) => h.pid)],
  });
  return { procs, holders, owner, memBytesOf, peakBytesOf };
}

/**
 * One reading of where the machine's CPU and memory go. `%cpu` is the
 * kernel's recent decaying average, so a single read answers "now" without
 * sampling twice.
 */
export async function sampleMachineUsage(): Promise<MachineUsage> {
  const { procs, owner, memBytesOf } = await readAttributedProcesses();
  return {
    kind: "sampled",
    at: new Date().toISOString(),
    cores: cpus().length,
    totalMemBytes: totalmem(),
    groups: sumByBucket(procs, owner, memBytesOf),
  };
}

/**
 * Sampled when a tab subscribes (the health report's Machine watcher card,
 * expanded) and re-read once at subscribe, so a reopened card never shows the
 * previous opening's numbers. No timer: an open card shows one reading.
 */
export const machineUsageServed = serveValue(machineUsage, {
  source: "external",
  changes: "notified",
  loader: sampleMachineUsage,
  whileSubscribed: (_params, notify) => {
    notify();
    return () => {};
  },
});
