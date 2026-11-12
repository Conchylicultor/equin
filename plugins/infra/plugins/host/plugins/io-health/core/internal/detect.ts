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
  /**
   * A tick reclaiming this much clean memory (MB/s, the pageout daemon taking
   * file pages back) is memory demand evicting the cache: a disk-quiet tick
   * reads ≤ ~2 MB/s, so ordinary replacement of old pages by new reads stays
   * under it. Measured 2026-11-11 with the machine's RAM full (64 GB, 0.4 GB
   * free, 11 GB compressed, Chrome holding ~29 GB): 1–25 MB/s per 30 s on
   * quiet ticks, and every canary evicted within a minute. A canary evicted
   * with every tick since its read below it stays a `cache-collapse` (no
   * measured cause); with one above it, a `memory-pressure`.
   */
  memoryReclaimMbS: 4,
  /**
   * A tick's slowest rename over this is a held rename. Measured 2026-11-05 with
   * a 10 Hz probe renaming one file in its own directory: ≤ 14 ms in every
   * quiet window (p99 ~5 ms), 290–1300 ms while a `bun install` or an
   * `rm -rf node_modules` ran elsewhere on the volume, at any I/O tier.
   */
  renameStallMs: 250,
  /** Held-rename ticks in the hour before it is a finding: one install's burst is load, a stream of them is the defect. */
  renameStallTicks: 3,
  /**
   * Hour median FSEvents ids/s (one id per file event, the rate between two
   * ticks of the same fseventsd). From the monitor's log 2026-11-09 → 11-10:
   * without a runaway writer every tick stayed ≤ 39k/s (p50 0.7k, p99 19k,
   * n = 1,214, builds and checks included); with three orphaned
   * create/unlink loops (a repro's churn child, research/2026-11-10-…) a
   * healthy fseventsd took 50–150k/s for hours and grew to 82–97 GB before
   * jetsam killed it. Once it pins at one core its throughput, and so the id
   * rate, falls to 1–3k/s: this rule sees the flood in the hours BEFORE that,
   * and `daemon-cpu` takes over after. Like every rule it reads the trailing
   * hour: after a relaunch (jetsam) or once the writer stops, it holds until
   * the flood's ticks leave the window. A tick without fseventsd's pid gives
   * no rate (fseventsd not running: no FSEvents at all).
   */
  fseventsFloodIdsS: 20_000,
  /** Once raised, it holds until the median falls below this. */
  fseventsFloodHoldIdsS: 10_000,
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

function renameMax(r: MonitorTick): number {
  return Math.max(r.fg.rename_max ?? 0, r.bg.rename_max ?? 0);
}

/** The processes in uninterruptible wait on a tick, busiest first: who was stuck beside the probe. */
function blockedEvidence(r: MonitorTick): Evidence[] {
  const blocked = Object.entries(r.uninterruptible ?? {}).sort(
    (a, b) => b[1] - a[1],
  );
  return blocked.length === 0
    ? []
    : [
        {
          label: "in uninterruptible wait then",
          value: blocked
            .slice(0, 5)
            .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
            .join(", "),
        },
      ];
}

function renameStall(win: readonly MonitorTick[]): Observation[] {
  const held = win.filter((r) => renameMax(r) > T.renameStallMs);
  if (held.length < T.renameStallTicks) return [];
  const worst = held.reduce((a, b) => (renameMax(b) > renameMax(a) ? b : a));
  const tier =
    (worst.bg.rename_max ?? 0) >= (worst.fg.rename_max ?? 0)
      ? "darwinbg"
      : "foreground";
  return [
    {
      rule: "rename-stall",
      subject: "volume",
      severity: "attention",
      summary: `Renames were held up to ${fmt(renameMax(worst) / 1000, 2)} s on ${held.length} ticks of the last hour — something keeps mutating directory trees in bulk`,
      evidence: [
        { label: "slowest rename (ms)", value: fmt(renameMax(worst), 0) },
        { label: "tier", value: tier },
        { label: "held ticks in the last hour", value: String(held.length) },
        { label: "at", value: worst.iso },
        ...blockedEvidence(worst),
      ],
    },
  ];
}

/**
 * FSEvents ids/s between consecutive ticks that both read the id under the
 * same fseventsd pid. A relaunched fseventsd restarts the counter near 0
 * (after an unclean exit it destroys its history and takes a new volume
 * UUID), so a delta across a pid change, or a negative one, is no rate.
 */
function fseventsRates(win: readonly MonitorTick[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < win.length; i++) {
    const a = win[i - 1]!;
    const b = win[i]!;
    if (a.fsevents_event_id === undefined || b.fsevents_event_id === undefined)
      continue;
    const pa = a.daemon_procs?.fseventsd?.pid;
    const pb = b.daemon_procs?.fseventsd?.pid;
    if (pa === undefined || pa !== pb) continue;
    const d = b.fsevents_event_id - a.fsevents_event_id;
    if (d < 0) continue;
    out.push(d / (b.t - a.t));
  }
  return out;
}

function fseventsFlood(win: readonly MonitorTick[], held: Held): Observation[] {
  const rates = fseventsRates(win);
  const m = median(rates);
  const bar = held.has(
    findingKey({ rule: "fsevents-flood", subject: "fsevents" }),
  )
    ? T.fseventsFloodHoldIdsS
    : T.fseventsFloodIdsS;
  if (m === null || rates.length < T.minTicks || m < bar) return [];
  const cpu = median(win.flatMap((r) => r.daemon_cpu["fseventsd"] ?? []));
  const rss = win.at(-1)?.daemon_procs?.fseventsd?.rss_mb;
  return [
    {
      rule: "fsevents-flood",
      subject: "fsevents",
      severity: "attention",
      summary: `Something generates ${fmt(m / 1000, 0)}k file events per second (median of the last hour; no hour without a runaway writer reached 20k)`,
      evidence: [
        { label: "FSEvents ids/s (median)", value: fmt(m, 0) },
        {
          label: "FSEvents ids/s (max tick)",
          value: fmt(Math.max(...rates), 0),
        },
        { label: "ticks", value: String(rates.length) },
        {
          label: "fseventsd %CPU (median)",
          value: cpu === null ? "-" : fmt(cpu),
        },
        {
          label:
            "fseventsd resident MB (ps; most of a grown one is compressed)",
          value: rss === undefined ? "-" : String(rss),
        },
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

/** One canary read 60–180 s before a tick, every tick since its read disk-quiet. */
interface QuietCanary {
  resident: number;
  /** Memory demand reclaimed the file cache on some tick since the read. */
  reclaimed: boolean;
}

/**
 * The canaries of tick `i` read 60–180 s ago, keeping only those every tick
 * since whose read was disk-quiet, each marked with whether memory demand
 * reclaimed the cache in that stretch. A tick that measured no reclaim (the
 * history before 2026-11-11) does not mark it: the eviction stays one no
 * measured cause explains (`cache-collapse`).
 */
function quietCanaries(win: readonly MonitorTick[], i: number): QuietCanary[] {
  const r = win[i]!;
  if (!isQuiet(r)) return [];
  const out: QuietCanary[] = [];
  for (const c of r.canary) {
    if (c.age_s < T.cacheAgeMinS || c.age_s >= T.cacheAgeMaxS) continue;
    // The window must reach back to the read, or the stretch is unknown.
    if (win[0]!.t > r.t - c.age_s) continue;
    let quiet = true;
    let reclaimed = false;
    for (let j = i; j >= 0 && win[j]!.t > r.t - c.age_s - 1; j--) {
      if (j < i && !isQuiet(win[j]!)) quiet = false;
      // A tick's rate covers the stretch since the tick before it: only the
      // ticks after the read say what happened to the canary.
      const reclaim = win[j]!.memory?.file_reclaim_mb_s;
      if (win[j]!.t > r.t - c.age_s && reclaim !== undefined)
        reclaimed ||= reclaim >= T.memoryReclaimMbS;
    }
    if (quiet) out.push({ resident: c.resident, reclaimed });
  }
  return out;
}

/** The disk-quiet canaries of every tick in the window, those of one cause. */
function evictedCanaries(
  win: readonly MonitorTick[],
  reclaimed: boolean,
): { residency: number; ticks: MonitorTick[] } | null {
  const perTick = win.map((_, i) =>
    quietCanaries(win, i).filter((c) => c.reclaimed === reclaimed),
  );
  const ticks = win.filter((_, i) => perTick[i]!.length > 0);
  if (ticks.length < T.cacheMinQuietTicks) return null;
  const m = median(perTick.flat().map((c) => c.resident));
  if (m === null || m >= T.cacheResident) return null;
  return { residency: m, ticks };
}

function cacheCollapse(win: readonly MonitorTick[]): Observation[] {
  const evicted = evictedCanaries(win, false);
  if (evicted === null) return [];
  const churn = median(evicted.ticks.map((r) => r.new_vnodes_s ?? 0));
  const unmeasured = evicted.ticks.filter(
    (r) => r.memory?.file_reclaim_mb_s === undefined,
  ).length;
  return [
    {
      rule: "cache-collapse",
      subject: "cache",
      severity: "attention",
      summary: `The file cache drops files read 1–3 min ago (${fmt(evicted.residency * 100, 0)} % resident) with the disk quiet and no memory reclaim measured`,
      evidence: [
        {
          label: "canary residency at 60–180 s (median)",
          value: fmt(evicted.residency, 2),
        },
        { label: "quiet ticks", value: String(evicted.ticks.length) },
        {
          label: "new vnodes/s in them (median)",
          value: churn === null ? "-" : fmt(churn, 0),
        },
        {
          label: "of them, ticks that measured no memory reclaim",
          value: String(unmeasured),
        },
      ],
    },
  ];
}

const PRESSURE_LEVEL: Record<number, string> = {
  1: "normal",
  2: "warning",
  4: "critical",
};

function gb(mb: number): string {
  return `${fmt(mb / 1000)} GB`;
}

/**
 * Memory demand evicts the file cache: the same symptom as `cache-collapse`
 * (canaries read 1–3 min ago gone on a disk-quiet machine), with its cause
 * measured — the pageout daemon reclaimed the cache on the ticks since their
 * read. Names who holds the memory, as of the newest tick.
 */
function memoryPressure(win: readonly MonitorTick[]): Observation[] {
  const evicted = evictedCanaries(win, true);
  if (evicted === null) return [];
  const reclaim = median(
    evicted.ticks.flatMap((r) => r.memory?.file_reclaim_mb_s ?? []),
  );
  const alloc = median(
    evicted.ticks.flatMap((r) => r.memory?.zero_fill_mb_s ?? []),
  );
  const mem = win.findLast((r) => r.memory !== undefined)!.memory!;
  const top = Object.entries(mem.top_footprint_mb)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  return [
    {
      rule: "memory-pressure",
      subject: "memory",
      severity: "attention",
      summary: `Memory demand evicts files read 1–3 min ago from the file cache (${fmt(evicted.residency * 100, 0)} % resident): it reclaims ${reclaim === null ? "-" : fmt(reclaim, 0)} MB/s of it with the disk quiet`,
      evidence: [
        {
          label: "canary residency at 60–180 s (median)",
          value: fmt(evicted.residency, 2),
        },
        { label: "disk-quiet ticks", value: String(evicted.ticks.length) },
        {
          label: "file cache reclaimed MB/s (median)",
          value: reclaim === null ? "-" : fmt(reclaim),
        },
        {
          label: "new memory allocated MB/s (median zero-fill)",
          value: alloc === null ? "-" : fmt(alloc, 0),
        },
        {
          label: "available / pressure level",
          value: `${mem.available_pct} % / ${PRESSURE_LEVEL[mem.pressure_level] ?? String(mem.pressure_level)}`,
        },
        {
          label: "file cache / anonymous / compressor / swap",
          value: [
            mem.file_cache_mb,
            mem.anonymous_mb,
            mem.compressor_mb,
            mem.swap_used_mb,
          ]
            .map(gb)
            .join(" / "),
        },
        {
          label: "largest memory users (footprint)",
          value:
            top.length === 0
              ? "-"
              : top.map(([n, mb]) => `${n} ${gb(mb)}`).join(", "),
        },
      ],
    },
  ];
}

const ROOT_PROBLEM_SUMMARY = {
  empty: "its plist is empty",
  invalid: "its plist does not parse",
  "not-loaded": "launchd has not loaded it",
  "not-writing": "it is loaded but wrote no tick lately",
} as const;

/**
 * The newest tick says the root daemon is installed and not writing: the user
 * agent ticks in its place, so disk health stays watched, but the opt-in the
 * user made (attribution) silently does nothing. Holds for exactly as long as
 * the user agent keeps saying so — a root tick clears it.
 */
function rootDaemon(win: readonly MonitorTick[]): Observation[] {
  const r = win.at(-1)?.root_daemon;
  if (r === undefined) return [];
  return [
    {
      rule: "root-daemon",
      subject: "root-daemon",
      severity: "attention",
      summary: `The fs-latency monitor's root daemon is installed but not running: ${ROOT_PROBLEM_SUMMARY[r.problem]} — the user agent is watching in its place, without attribution`,
      evidence: [
        { label: "problem", value: r.problem },
        { label: "plist", value: r.plist },
        { label: "its log", value: r.stdio },
        { label: "reinstall (from any directory)", value: r.fix },
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
  renameStall,
  relaunchLoop,
  cacheCollapse,
  memoryPressure,
  fseventsFlood,
  rootDaemon,
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
