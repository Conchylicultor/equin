/**
 * Where the machine's CPU and memory go right now, by owner — the same
 * attribution the main backend persists to `health-owners` every 30 s, read on
 * demand (two `ps` readings `--window` seconds apart; default 10).
 *
 *   ./equin run plugins/debug/plugins/sentinel/plugins/machine-usage/scripts/owners-now.ts [--window 10]
 *
 * Reads each process's kernel usage record directly (packages/proc-rusage), as
 * the backend's probe does: its footprint, and its CPU with that of the
 * children it reaped. Prints the host's own busy share beside the attributed
 * one: the gap is what no listed process accounts for (another account's
 * processes' children, orphans reaped by launchd, the kernel).
 */
import { cpus } from "node:os";
import { readProcRusage } from "@plugins/packages/plugins/proc-rusage/core";
import { readAgentBrowserStatus } from "@plugins/infra/plugins/mcp/plugins/browser/server";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { listActiveWorktreeOps } from "@plugins/infra/plugins/worktree/server";
import {
  attributeProcesses,
  parsePs,
  PS_COLUMNS,
  summarizeOwners,
  type CpuBaseline,
} from "../core";

const windowArg = process.argv.indexOf("--window");
const windowSec = windowArg === -1 ? 10 : Number(process.argv[windowArg + 1]);

async function read(baseline: CpuBaseline | null) {
  const [ps, ops] = await Promise.all([
    spawnExpectOk(["ps", "-A", "-o", PS_COLUMNS], { timeoutMs: 5_000 }),
    listActiveWorktreeOps(),
  ]);
  const browser = readAgentBrowserStatus();
  const procs = parsePs(ps.stdout);
  const memBytes = new Map<number, number>();
  for (const p of procs) {
    const r = readProcRusage(p.pid);
    if (r.kind !== "read") continue;
    memBytes.set(p.pid, r.memory.physFootprintBytes);
    p.cpuTimeMs = r.cpu.ownNs / 1e6;
    p.reapedChildrenMs = r.cpu.reapedChildrenNs / 1e6;
  }
  const owner = attributeProcesses(procs, {
    agentBrowser: browser.kind === "running" ? browser.host.pid : null,
    agentOps: ops.map((o) => o.pid),
  });
  return summarizeOwners({
    procs,
    owner,
    memBytesOf: (p) => memBytes.get(p.pid) ?? p.rssBytes,
    baseline,
    nowMs: Date.now(),
    cores: cpus().length,
  });
}

/** Every core's busy ms and total ms since boot, from `os.cpus()`. */
function cpuTicks(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const { times: t } of cpus()) {
    const b = t.user + t.nice + t.sys + t.irq;
    busy += b;
    total += b + t.idle;
  }
  return { busy, total };
}

const ticks0 = cpuTicks();
const first = await read(null);
await new Promise((r) => setTimeout(r, windowSec * 1000));
const { sample } = await read(first.baseline);
const ticks1 = cpuTicks();
const hostBusyPct =
  (100 * (ticks1.busy - ticks0.busy)) / (ticks1.total - ticks0.total);

const cores = sample.cores;
const busy = sample.owners.reduce((n, o) => n + (o.cpuCores ?? 0), 0);
console.log(
  `window ${(sample.windowMs! / 1000).toFixed(1)} s · ${cores} cores · host busy ${hostBusyPct.toFixed(0)} % (${((hostBusyPct * cores) / 100).toFixed(1)} cores) · attributed ${busy.toFixed(1)} cores (${((100 * busy) / cores).toFixed(0)} %)`,
);
console.log("owner           procs   cores   mem GB");
for (const o of sample.owners) {
  console.log(
    `${o.bucket.padEnd(15)} ${String(o.processes).padStart(5)} ${(o.cpuCores ?? 0).toFixed(2).padStart(7)} ${(o.memMb / 1024).toFixed(1).padStart(8)}`,
  );
}
console.log("\nlargest / busiest:");
for (const t of sample.top) {
  console.log(
    `  ${t.bucket.padEnd(14)} ${(t.cpuCores ?? 0).toFixed(2).padStart(5)} cores ${(t.memMb / 1024).toFixed(2).padStart(6)} GB  ${t.name}`,
  );
}
