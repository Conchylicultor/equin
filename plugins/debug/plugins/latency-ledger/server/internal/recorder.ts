import { onResourceDelivery } from "@plugins/framework/plugins/server-core/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { createShedBuffer } from "@plugins/infra/plugins/host/plugins/duress/plugins/shed/server";
import { isUnderDuress } from "@plugins/infra/plugins/host/plugins/duress/plugins/latch/server";
import {
  onHealthSample,
  onHostSample,
  onStackSamples,
} from "@plugins/debug/plugins/health-monitor/server";
import {
  addSample,
  emptyAcc,
  isEmptyAcc,
  minuteStartOf,
  type HistogramAcc,
  type LatencyMetric,
} from "../../core";
import {
  mergeHostMinute,
  mergeMetricMinute,
  writeThreadMinute,
  type HostMinute,
  type MetricMinute,
  type ThreadMinute,
} from "./store";
import { noteFlushedMinute } from "./summary-resource";
import { ownerOfSample, samplePeriodMs } from "./thread-owners";

// The server half of the ledger: it listens to three things that already happen —
// every delivery to a tab, every 10 s health sample, every drained batch of stack
// samples — adds them to this minute's in-memory counters, and writes the minute
// when it is over. One small write per metric per minute, however busy the app is.
//
// No timer of its own, and deliberately not a job: the minute rolls on the health
// sampler's tick (and on any event that arrives in a new minute), and the counters
// live in THIS process — a job runs wherever the job runner is, which the planned
// serving/background split moves to another process.

const TOP_OWNERS = 20;

interface MinuteState {
  minuteStart: number;
  metrics: Map<LatencyMetric, HistogramAcc>;
  host: HostMinute;
  threadSamples: number;
  threadPeriods: number[];
  threadOwners: Map<string, number>;
}

function newMinute(minuteStart: number): MinuteState {
  return {
    minuteStart,
    metrics: new Map(),
    host: {
      minuteStart,
      duress: false,
      maxDecompressionsPerSec: null,
      minFreeMemMb: null,
      maxLoad1: null,
      sleptMs: 0,
    },
    threadSamples: 0,
    threadPeriods: [],
    threadOwners: new Map(),
  };
}

type FlushItem =
  | { type: "metric"; row: MetricMinute }
  | { type: "host"; row: HostMinute }
  | { type: "thread"; row: ThreadMinute };

async function persist(item: FlushItem): Promise<void> {
  if (item.type === "metric") await mergeMetricMinute(item.row);
  else if (item.type === "host") await mergeHostMinute(item.row);
  else await writeThreadMinute(item.row);
}

// Observability writes yield to a machine in trouble: during a duress episode the
// first minutes of each kind are written at once, the rest are held in memory and
// written — under their own minute — once the episode clears. Nothing is lost;
// the pressure minutes are exactly the ones this ledger exists to see.
const shed = createShedBuffer<FlushItem>({
  kind: "latency-ledger",
  cascadeKeyOf: (item) =>
    item.type === "metric" ? `metric:${item.row.metric}` : item.type,
  replay: async (items) => {
    for (const item of items) await persist(item);
  },
});

let state: MinuteState | null = null;
let stops: Array<() => void> = [];

function topOwners(owners: Map<string, number>): Record<string, number> {
  const sorted = [...owners.entries()].sort((a, b) => b[1] - a[1]);
  const out: Record<string, number> = {};
  let other = 0;
  sorted.forEach(([owner, n], i) => {
    if (i < TOP_OWNERS) out[owner] = n;
    else other += n;
  });
  if (other > 0) out.other = (out.other ?? 0) + other;
  return out;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

async function flush(done: MinuteState): Promise<void> {
  const items: FlushItem[] = [{ type: "host", row: done.host }];
  for (const [metric, acc] of done.metrics) {
    if (isEmptyAcc(acc)) continue;
    items.push({
      type: "metric",
      row: { metric, minuteStart: done.minuteStart, acc },
    });
  }
  if (done.threadSamples > 0) {
    items.push({
      type: "thread",
      row: {
        minuteStart: done.minuteStart,
        samples: done.threadSamples,
        periodMs: median(done.threadPeriods),
        owners: topOwners(done.threadOwners),
      },
    });
  }
  for (const item of items) {
    if (!shed.admit(item).persist) continue;
    await persist(item);
  }
  noteFlushedMinute(done.minuteStart);
}

/** The current minute's counters, rolling (and writing) the previous one first. */
function current(now: number): MinuteState {
  const minuteStart = minuteStartOf(now);
  if (state === null) {
    state = newMinute(minuteStart);
  } else if (minuteStart > state.minuteStart) {
    const done = state;
    state = newMinute(minuteStart);
    void runTracked("latency-ledger:flush", () => flush(done));
  }
  return state;
}

function accFor(s: MinuteState, metric: LatencyMetric): HistogramAcc {
  let acc = s.metrics.get(metric);
  if (!acc) {
    acc = emptyAcc();
    s.metrics.set(metric, acc);
  }
  return acc;
}

function maxOf(a: number | null, b: number): number {
  return a === null ? b : Math.max(a, b);
}
function minOf(a: number | null, b: number): number {
  return a === null ? b : Math.min(a, b);
}

export function startLatencyRecorder(): void {
  if (stops.length > 0) return;
  stops = [
    onResourceDelivery((_key, { latencyMs }) => {
      addSample(accFor(current(Date.now()), "deliver-server"), latencyMs);
    }),
    onHealthSample((sample) => {
      const s = current(sample.sampledAt);
      s.host.duress ||= isUnderDuress();
      const slept = sample.sleptMs ?? sample.wallJumpMs;
      if (slept !== undefined) {
        // The sampler emptied this window's lag reading; there is nothing to add,
        // and the minute is marked so every other metric's samples are left out.
        s.host.sleptMs += slept;
        return;
      }
      addSample(accFor(s, "thread-lag"), sample.eventLoopMaxMs);
    }),
    onHostSample((sample) => {
      const s = current(sample.sampledAt);
      s.host.maxLoad1 = maxOf(s.host.maxLoad1, sample.loadAvg1);
      s.host.minFreeMemMb = minOf(s.host.minFreeMemMb, sample.freeMemMb);
      if (sample.decompressionsPerSec !== undefined) {
        s.host.maxDecompressionsPerSec = maxOf(
          s.host.maxDecompressionsPerSec,
          sample.decompressionsPerSec,
        );
      }
    }),
    onStackSamples((samples) => {
      const s = current(Date.now());
      s.threadSamples += samples.length;
      const period = samplePeriodMs(samples);
      if (period !== null) s.threadPeriods.push(period);
      for (const sample of samples) {
        const owner = ownerOfSample(sample);
        s.threadOwners.set(owner, (s.threadOwners.get(owner) ?? 0) + 1);
      }
    }),
  ];
}

export async function stopLatencyRecorder(): Promise<void> {
  for (const stop of stops) stop();
  stops = [];
  // Write the partial minute rather than lose it to a restart — main restarts
  // several times a day, and the minutes around a restart are the interesting ones.
  const done = state;
  state = null;
  if (done !== null) await flush(done);
}
