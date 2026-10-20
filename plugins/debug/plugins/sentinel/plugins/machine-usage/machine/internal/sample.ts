import { cpus, totalmem } from "node:os";
import {
  peerProcMemory,
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
  PS_COLUMNS,
  sumByBucket,
  type MachineUsage,
  type PsProcess,
} from "../../core";

const PS_MS = 5_000;

/** The agent browser host's pid while it runs — its tree is that bucket. */
function agentBrowserRoot(): number | null {
  const status = readAgentBrowserStatus();
  return status.kind === "running" ? status.host.pid : null;
}

/**
 * Each process's memory: its physical footprint (what Activity Monitor shows —
 * `ps`'s resident size over-counts Bun ~6×), else, for a process the kernel
 * will not report on (another account's, or exited since `ps` listed it),
 * its resident size. This process is read first through the throwing probe,
 * so a broken binding fails the read instead of degrading every process to
 * its resident size.
 */
function memoryReader(): (p: PsProcess) => number {
  if (procMemory() === null) return (p) => p.rssBytes;
  return (p) => {
    const read = peerProcMemory(p.pid);
    return read.kind === "read" ? read.memory.physFootprintBytes : p.rssBytes;
  };
}

/**
 * One reading of where the machine's CPU and memory go: one `ps` over every
 * process, each attributed to the bucket of the root it descends from (the
 * agent browser host, a running op's CLI process) or by what it runs (Chrome).
 * `%cpu` is the kernel's recent decaying average, so a single read answers
 * "now" without sampling twice.
 */
export async function sampleMachineUsage(): Promise<MachineUsage> {
  const [ps, ops] = await Promise.all([
    spawnExpectOk(["ps", "-A", "-o", PS_COLUMNS], { timeoutMs: PS_MS }),
    listActiveWorktreeOps(),
  ]);
  const procs = parsePs(ps.stdout);
  const owner = attributeProcesses(procs, {
    agentBrowser: agentBrowserRoot(),
    agentOps: ops.map((o) => o.pid),
  });
  return {
    kind: "sampled",
    at: new Date().toISOString(),
    cores: cpus().length,
    totalMemBytes: totalmem(),
    groups: sumByBucket(procs, owner, memoryReader()),
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
