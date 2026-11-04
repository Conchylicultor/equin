import { findingKey, type Evidence, type Finding } from "./finding";
import type { MonitorTick } from "./tick";

/**
 * Every threshold the detector applies, chosen from the monitor's recorded
 * history of the 2026-11-03/04 incident (fseventsd replaying 17 days of event
 * history for corecaptured's relaunch loop, fixed 2026-11-04 16:23 UTC) so a
 * replay of it fires and the healthy state after the fix does not. Rolling
 * one-hour windows over that log (`scripts/replay-monitor-log.ts`):
 *
 * | signal | during (2026-11-03 15:07 → 11-04 16:23) | after (11-04 17:23 → 20:05) |
 * | --- | --- | --- |
 * | fseventsd %CPU, hour median | 76–100 | 0.3–0.6 |
 * | device ms/read op, hour median of ticks ≥ 1k read ops/s | 0.12–5.8 (≥ 2 in 58 % of windows) | 0.36–0.92 |
 * | corecaptured distinct pids / hour | 6 (field logged from 16:00 only; 13–18 by launchd's count) | 0 |
 * | slowest probe op | 435 ms | 232 ms |
 *
 * Not triggers, and why: **read ops/s and MB/s** measure the workload, not
 * its health — the fleet read MORE after the fix (p50 3.6k vs 3.1k ops/s at
 * the same vnode-churn band), so a "several times baseline" rule on them
 * fires on a busy healthy hour. **Busy-hour cache lifetime** was under 60 s
 * both during and after (the fleet's own vnode churn); only a short lifetime
 * while the machine is QUIET says something else evicts pages.
 */
export const IO_HEALTH_THRESHOLDS = {
  /** Every rule reads the ticks of the trailing hour. */
  windowMs: 60 * 60_000,
  /** A sustained rule needs this many ticks in its window (20 min of the hour). */
  minTicks: 40,
  /** Hour median %CPU of one watched daemon (healthy ≤ 1 for fseventsd). */
  daemonCpuPct: 50,
  /** Once raised, it holds until the median falls below this (hysteresis: no flapping at the line). */
  daemonCpuHoldPct: 25,
  /** Hour median device ms per read op (healthy busy ≤ 0.92; ~4.6× the device's 0.43 ms lifetime mean). */
  deviceMsPerOp: 2,
  /** Once raised, it holds until the median falls below this. */
  deviceHoldMsPerOp: 1.5,
  /** A tick counts toward device latency only with this many read ops/s: an idle tick's ms/op is a handful of ops. */
  deviceMinReadOpsS: 1000,
  deviceMinBusyTicks: 20,
  /** One cold probe op over this is a stall (the monitor's own STALL_MS). */
  stallMs: 1000,
  /** Distinct pids of one daemon within the hour. A healthy daemon keeps one; corecaptured's loop made 13–18. */
  relaunchPids: 5,
  /**
   * A tick is quiet below this many new vnodes/s (busy fleet ticks run
   * 2–40k). A canary counts only when EVERY tick since it was read was quiet:
   * the fleet churns in bursts, and one burst between two quiet ticks evicts
   * the canary (2026-11-04 19:27, after the fix, would fire otherwise).
   */
  quietNewVnodesS: 500,
  /** Canaries read this long ago (s) must still be resident on a quiet machine. */
  cacheAgeMinS: 60,
  cacheAgeMaxS: 180,
  cacheMinQuietTicks: 20,
  /** Below this median residency the canaries count as evicted. */
  cacheResident: 0.5,
} as const;

/** What one tick changed. */
export interface DetectorStep {
  /** Findings that hold now and did not on the previous tick. */
  raised: Finding[];
  /** Findings that held on the previous tick and no longer do. */
  cleared: Finding[];
  /** Every finding holding now, its numbers as of this tick. */
  active: Finding[];
}

export interface IoHealthDetector {
  /**
   * Feed the next tick. Ticks must come in time order: one not newer than the
   * last is dropped and counted (`outOfOrder`) — the monitor's clock stepping
   * back is input, not a defect of the reader.
   */
  push(tick: MonitorTick): DetectorStep;
  active(): Finding[];
  /** The newest tick fed, or null before the first. */
  last(): MonitorTick | null;
  outOfOrder(): number;
}

const T = IO_HEALTH_THRESHOLDS;

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function utcClock(tSeconds: number): string {
  return `${new Date(tSeconds * 1000).toISOString().slice(11, 16)} UTC`;
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

/** A finding as a rule states it, before the detector stamps `since`. */
type Observation = Omit<Finding, "since">;

function daemonCpu(win: readonly MonitorTick[], held: Held): Observation[] {
  if (win.length < T.minTicks) return [];
  const names = new Set(win.flatMap((r) => Object.keys(r.daemon_cpu)));
  const load = median(win.map((r) => r.load1));
  const out: Observation[] = [];
  for (const name of [...names].sort()) {
    const cpu = win
      .map((r) => r.daemon_cpu[name])
      .filter((v): v is number => v !== undefined);
    const m = median(cpu);
    const bar = held.has(findingKey({ rule: "daemon-cpu", subject: name }))
      ? T.daemonCpuHoldPct
      : T.daemonCpuPct;
    if (m === null || cpu.length < T.minTicks || m < bar) continue;
    out.push({
      rule: "daemon-cpu",
      subject: name,
      severity: "attention",
      summary: `${name} has used ${fmt(m, 0)} % CPU (median) for the last hour`,
      evidence: [
        { label: "median %CPU", value: fmt(m) },
        { label: "ticks", value: String(cpu.length) },
        {
          label: "load average (median)",
          value: load === null ? "-" : fmt(load),
        },
        ...diskEvidence(win),
      ],
    });
  }
  return out;
}

function diskEvidence(win: readonly MonitorTick[]): Evidence[] {
  const ops = median(win.flatMap((r) => r.disk_read_ops_s ?? []));
  const mb = median(win.flatMap((r) => r.disk_read_mb_s ?? []));
  return [
    {
      label: "disk read ops/s (median)",
      value: ops === null ? "-" : fmt(ops, 0),
    },
    { label: "disk read MB/s (median)", value: mb === null ? "-" : fmt(mb) },
  ];
}

function busyMsPerOp(win: readonly MonitorTick[]): number[] {
  return win.flatMap((r) =>
    (r.disk_read_ops_s ?? 0) >= T.deviceMinReadOpsS &&
    typeof r.disk_read_ms_per_op === "number"
      ? [r.disk_read_ms_per_op]
      : [],
  );
}

function deviceLatency(win: readonly MonitorTick[], held: Held): Observation[] {
  const busy = busyMsPerOp(win);
  const m = median(busy);
  const bar = held.has(findingKey({ rule: "device-latency", subject: "disk" }))
    ? T.deviceHoldMsPerOp
    : T.deviceMsPerOp;
  if (m === null || busy.length < T.deviceMinBusyTicks || m < bar) return [];
  return [
    {
      rule: "device-latency",
      subject: "disk",
      severity: "attention",
      summary: `The disk takes ${fmt(m, 2)} ms per read op (median of the last hour; healthy is under 1 ms)`,
      evidence: [
        { label: "device ms/read op (median, busy ticks)", value: fmt(m, 2) },
        { label: "busy ticks (≥ 1k read ops/s)", value: String(busy.length) },
        ...diskEvidence(win),
        ...topDaemon(win),
      ],
    },
  ];
}

/** The watched daemon with the highest median CPU, as a hint at the cause. */
function topDaemon(win: readonly MonitorTick[]): Evidence[] {
  let best: { name: string; cpu: number } | null = null;
  const names = new Set(win.flatMap((r) => Object.keys(r.daemon_cpu)));
  for (const name of names) {
    const m = median(win.flatMap((r) => r.daemon_cpu[name] ?? []));
    if (m !== null && (best === null || m > best.cpu)) best = { name, cpu: m };
  }
  return best === null
    ? []
    : [
        {
          label: "busiest watched daemon",
          value: `${best.name} ${fmt(best.cpu)} % CPU`,
        },
      ];
}

function metadataStall(win: readonly MonitorTick[]): Observation[] {
  const stalls = win.filter((r) => r.max_op_ms > T.stallMs);
  if (stalls.length === 0) return [];
  const worst = stalls.reduce((a, b) => (b.max_op_ms > a.max_op_ms ? b : a));
  const tier = worst.bg.max_op >= worst.fg.max_op ? "darwinbg" : "foreground";
  return [
    {
      rule: "metadata-stall",
      subject: "probe",
      severity: "critical",
      summary: `A file-metadata op took ${fmt(worst.max_op_ms / 1000)} s (${tier}) at ${utcClock(worst.t)}`,
      evidence: [
        { label: "slowest op (ms)", value: fmt(worst.max_op_ms, 0) },
        { label: "tier", value: tier },
        {
          label: "stalled ticks in the last hour",
          value: String(stalls.length),
        },
        { label: "at", value: worst.iso },
      ],
    },
  ];
}

function procsOf(
  r: MonitorTick,
): Record<string, { pid: number; age_s: number }> {
  if (r.daemon_procs !== undefined) return r.daemon_procs;
  return r.corecaptured ? { corecaptured: r.corecaptured } : {};
}

function relaunchLoop(win: readonly MonitorTick[]): Observation[] {
  const pids = new Map<string, Map<number, number>>();
  for (const r of win) {
    for (const [name, p] of Object.entries(procsOf(r))) {
      const seen = pids.get(name) ?? new Map<number, number>();
      seen.set(p.pid, Math.max(seen.get(p.pid) ?? 0, p.age_s));
      pids.set(name, seen);
    }
  }
  const out: Observation[] = [];
  for (const [name, seen] of [...pids].sort(([a], [b]) => a.localeCompare(b))) {
    if (seen.size < T.relaunchPids) continue;
    const longest = Math.max(...seen.values());
    out.push({
      rule: "relaunch-loop",
      subject: name,
      severity: "attention",
      summary: `${name} was relaunched ${seen.size - 1} times in the last hour (no run lived past ${fmt(longest / 60)} min)`,
      evidence: [
        { label: "distinct pids", value: String(seen.size) },
        { label: "longest run seen (s)", value: fmt(longest, 0) },
        ...topDaemon(win),
      ],
    });
  }
  return out;
}

function isQuiet(r: MonitorTick): boolean {
  return r.new_vnodes_s !== undefined && r.new_vnodes_s < T.quietNewVnodesS;
}

/** The canaries of tick `i` read 60–180 s ago, keeping only those every tick since whose read was quiet. */
function quietCanaries(win: readonly MonitorTick[], i: number): number[] {
  const r = win[i]!;
  if (!isQuiet(r)) return [];
  return r.canary
    .filter((c) => c.age_s >= T.cacheAgeMinS && c.age_s < T.cacheAgeMaxS)
    .filter((c) => {
      for (let j = i - 1; j >= 0 && win[j]!.t > r.t - c.age_s - 1; j--) {
        if (!isQuiet(win[j]!)) return false;
      }
      // The window must reach back to the read, or the stretch is unknown.
      return win[0]!.t <= r.t - c.age_s;
    })
    .map((c) => c.resident);
}

function cacheCollapse(win: readonly MonitorTick[]): Observation[] {
  const perTick = win.map((_, i) => quietCanaries(win, i));
  const quiet = win.filter((_, i) => perTick[i]!.length > 0);
  if (quiet.length < T.cacheMinQuietTicks) return [];
  const resident = perTick.flat();
  const m = median(resident);
  if (m === null || m >= T.cacheResident) return [];
  const churn = median(quiet.map((r) => r.new_vnodes_s ?? 0));
  return [
    {
      rule: "cache-collapse",
      subject: "cache",
      severity: "attention",
      summary: `The file cache drops files read 1–3 min ago (${fmt(m * 100, 0)} % resident) although the machine is quiet`,
      evidence: [
        { label: "canary residency at 60–180 s (median)", value: fmt(m, 2) },
        { label: "quiet ticks", value: String(quiet.length) },
        {
          label: "new vnodes/s in them (median)",
          value: churn === null ? "-" : fmt(churn, 0),
        },
      ],
    },
  ];
}

/** The keys of the findings holding on the previous tick: a held finding clears at its rule's lower hold bar. */
type Held = ReadonlySet<string>;

const RULES: ((win: readonly MonitorTick[], held: Held) => Observation[])[] = [
  daemonCpu,
  deviceLatency,
  metadataStall,
  relaunchLoop,
  cacheCollapse,
];

/** Every rule over one window, the newest tick last. Pure. */
export function evaluateWindow(
  win: readonly MonitorTick[],
  held: Held = new Set(),
): Observation[] {
  return RULES.flatMap((rule) => rule(win, held));
}

/**
 * The detector: a trailing one-hour window of ticks, every rule re-evaluated
 * on each tick, and each finding's onset (`since`) carried across ticks for
 * as long as it holds without a break. O(window) per tick (≤ ~120 ticks).
 */
export function createIoHealthDetector(): IoHealthDetector {
  const win: MonitorTick[] = [];
  let current = new Map<string, Finding>();
  let dropped = 0;
  return {
    push(tick) {
      const last = win.at(-1);
      if (last !== undefined && tick.t <= last.t) {
        dropped++;
        return { raised: [], cleared: [], active: [...current.values()] };
      }
      win.push(tick);
      const from = tick.t - T.windowMs / 1000;
      while (win.length > 0 && win[0]!.t <= from) win.shift();
      const next = new Map<string, Finding>();
      const raised: Finding[] = [];
      for (const o of evaluateWindow(win, new Set(current.keys()))) {
        const key = findingKey(o);
        const prev = current.get(key);
        const f: Finding = {
          ...o,
          since: prev?.since ?? Math.round(tick.t * 1000),
        };
        next.set(key, f);
        if (prev === undefined) raised.push(f);
      }
      const cleared = [...current]
        .filter(([k]) => !next.has(k))
        .map(([, f]) => f);
      current = next;
      return { raised, cleared, active: [...next.values()] };
    },
    active: () => [...current.values()],
    last: () => win.at(-1) ?? null,
    outOfOrder: () => dropped,
  };
}
