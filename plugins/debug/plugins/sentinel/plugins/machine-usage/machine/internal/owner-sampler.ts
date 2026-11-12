import { cpus, totalmem } from "node:os";
import {
  cpuPool,
  publishFleetMemory,
} from "@plugins/infra/plugins/host/plugins/host-admission/server";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import {
  parseVmStat,
  wiredMemBytes,
} from "@plugins/packages/plugins/vm-stat/core";
import { defineTimer } from "@plugins/infra/plugins/background/plugins/timer/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { summarizeOwners, type CpuBaseline } from "../../core";
import { readAttributedProcesses } from "./sample";

// Where the machine's CPU and memory went, by owner, persisted every 30 s to
// main's `health-owners` log beside the 10 s host sample (`health-host`,
// debug/health-monitor), so a contention window can be read back as who used
// the machine, not only how loaded it was. The card's on-open reading
// (`sentinel.machine-usage`) answers "now"; this answers "then".
//
// 30 s, not the host sample's 10 s: CPU here is each process's CPU-time delta
// over the window (exact, unlike `ps`'s decaying %cpu), so a longer window
// loses nothing but resolution, and one `ps` of ~1,000 processes costs ~0.1
// CPU-s (measured 2026-11-06).
const SAMPLE_INTERVAL_MS = 30_000;

// Bounded well under the cadence, like the host sampler's own vm_stat.
const VM_STAT_MS = 5_000;

const channel = defineLogSink({
  id: "health-owners",
  description:
    "PERF sink: the machine's CPU (cores, from CPU-time deltas) and memory by owner — Chrome, agent ops, agent browser, agents, backends, Postgres, other — plus the largest processes, every 30 s, for Debug → Health.",
});

let baseline: CpuBaseline | null = null;

async function tick(): Promise<void> {
  const { procs, owner, memBytesOf } = await readAttributedProcesses();
  const next = summarizeOwners({
    procs,
    owner,
    memBytesOf,
    baseline,
    nowMs: Date.now(),
    cores: cpus().length,
  });
  baseline = next.baseline;
  channel.publish(JSON.stringify(next.sample));
  await publishFleetReading({ procs, owner, memBytesOf });
}

// The same attribution, handed to host admission: what the agent ops use
// (holders and children alike — every running op's whole tree) and what
// everything else on the machine uses, beside the kernel's wired memory and the
// `cpu` slots held. Every grant acquire sizes the fleet's window from it
// (host-admission's `fleetWindow`), so the 30 s cadence is admission's too.
async function publishFleetReading({
  procs,
  owner,
  memBytesOf,
}: Awaited<ReturnType<typeof readAttributedProcesses>>): Promise<void> {
  let opsBytes = 0;
  let otherBytes = 0;
  for (const p of procs) {
    if (owner.get(p.pid) === "agent-ops") opsBytes += memBytesOf(p);
    else otherBytes += memBytesOf(p);
  }
  const vm = await spawnExpectOk(["vm_stat"], { timeoutMs: VM_STAT_MS });
  await publishFleetMemory({
    sampledAt: Date.now(),
    ramBytes: totalmem(),
    wiredBytes: wiredMemBytes(parseVmStat(vm.stdout)),
    otherBytes,
    opsBytes,
    heldUnits: await cpuPool.held(),
  });
}

// Main-only: the machine is one, so one sampler suffices.
export const ownerSamplerTimer = defineTimer({
  name: "machine-usage.owner-sampler",
  description:
    "Samples where the machine's CPU and memory go, by owner (Chrome, agent ops, agent browser, agents, backends, Postgres, other), every 30 seconds into the health-owners log that Debug → Health charts, and hands host admission the fleet memory reading (agent ops' footprint, everyone else's, kernel wired memory, cpu slots held) every cpu grant is sized from.",
  everyMs: SAMPLE_INTERVAL_MS,
  mainOnly: true,
  profile: "invisible",
  run: tick,
});

export function startOwnerSampler(): void {
  if (ownerSamplerTimer.running) return;
  // A restart's first window would span the stopped gap: start over.
  baseline = null;
  ownerSamplerTimer.start();
}

export function stopOwnerSampler(): void {
  ownerSamplerTimer.stop();
}
