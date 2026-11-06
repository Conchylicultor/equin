import { cpus } from "node:os";
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
}

// Main-only: the machine is one, so one sampler suffices.
export const ownerSamplerTimer = defineTimer({
  name: "machine-usage.owner-sampler",
  description:
    "Samples where the machine's CPU and memory go, by owner (Chrome, agent ops, agent browser, agents, backends, Postgres, other), every 30 seconds into the health-owners log that Debug → Health charts.",
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
