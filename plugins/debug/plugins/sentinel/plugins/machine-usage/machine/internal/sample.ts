import { cpus, totalmem } from "node:os";
import {
  peerProcUsage,
  procMemory,
} from "@plugins/framework/plugins/server-core/core";
import { readAgentBrowserStatus } from "@plugins/infra/plugins/mcp/plugins/browser/server";
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
 */
async function readKernelUsage(
  procs: PsProcess[],
): Promise<(p: PsProcess) => number> {
  if (procMemory() === null) return (p) => p.rssBytes;
  const memBytes = new Map<number, number>();
  for (const p of procs) {
    const read = peerProcUsage(p.pid);
    if (read.kind !== "read") continue;
    memBytes.set(p.pid, read.memory.physFootprintBytes);
    p.cpuTimeMs = read.cpu.ownNs / 1e6;
    p.reapedChildrenMs = read.cpu.reapedChildrenNs / 1e6;
  }
  // Read after the footprints, so a process the walk measured wins.
  const forked = await measureForkTrees(postgresForkTrees(procs));
  for (const [pid, bytes] of forked) memBytes.set(pid, bytes);
  return (p) => memBytes.get(p.pid) ?? p.rssBytes;
}

/** Every process on the machine, each with its bucket and memory reader. */
export interface AttributedProcesses {
  procs: PsProcess[];
  owner: Map<number, MachineUsageBucket>;
  memBytesOf: (p: PsProcess) => number;
}

/**
 * One `ps` over every process, each attributed to the bucket of the root it
 * descends from (the agent browser host, a running op's CLI process, a named
 * backend / agent / Postgres) or by what it runs (Chrome).
 */
export async function readAttributedProcesses(): Promise<AttributedProcesses> {
  const [ps, ops] = await Promise.all([
    spawnExpectOk(["ps", "-A", "-o", PS_COLUMNS], { timeoutMs: PS_MS }),
    listActiveWorktreeOps(),
  ]);
  const procs = parsePs(ps.stdout);
  const memBytesOf = await readKernelUsage(procs);
  const owner = attributeProcesses(procs, {
    agentBrowser: await agentBrowserRoot(),
    agentOps: ops.map((o) => o.pid),
  });
  return { procs, owner, memBytesOf };
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
