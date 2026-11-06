import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
import { processKindOf } from "@plugins/packages/plugins/process-name/core";
import type { PsProcess } from "./attribute";
import {
  MACHINE_USAGE_BUCKETS,
  MACHINE_USAGE_TOP_PROCESSES,
  type MachineUsageBucket,
  type OwnerSample,
  type OwnerUsage,
  type TopProcess,
} from "./machine-usage";

const MB = 1_048_576;

/** What the previous reading saw of one process. */
interface SeenProcess {
  ppid: number;
  cpuTimeMs: number;
  reapedChildrenMs: number | undefined;
}

/** Every process at the previous reading, and when it was taken. */
export interface CpuBaseline {
  atMs: number;
  procs: ReadonlyMap<number, SeenProcess>;
}

/**
 * The CPU a process and the children it reaped ran since the baseline, ms;
 * null without a baseline.
 *
 * - Its own time: the delta for one alive at both readings, its whole life for
 *   one that started in between (a pid whose time went backwards was reused —
 *   a new process).
 * - Its reaped children's time: the same delta, less what the previous reading
 *   already charged to its descendants that have since vanished
 *   (`vanishedSeenMs`, their own and reaped time then). What is left is each vanished child's last
 *   stretch plus the whole life of every child that came and went between two
 *   readings — the hooks, `git`s and `rg`s a `ps` snapshot never lists, which
 *   on a busy host is most of the CPU (2026-11-06: ~30 new processes a second).
 */
function cpuSince(
  p: PsProcess,
  baseline: CpuBaseline | null,
  vanishedSeenMs: number,
): number | null {
  if (baseline === null) return null;
  const before = baseline.procs.get(p.pid);
  const reused = before !== undefined && p.cpuTimeMs < before.cpuTimeMs;
  const fresh = before === undefined || reused;
  const own = fresh ? p.cpuTimeMs : p.cpuTimeMs - before.cpuTimeMs;
  let reaped = 0;
  if (p.reapedChildrenMs !== undefined) {
    if (fresh) reaped = p.reapedChildrenMs;
    else if (before.reapedChildrenMs !== undefined)
      reaped = Math.max(
        0,
        p.reapedChildrenMs - before.reapedChildrenMs - vanishedSeenMs,
      );
  }
  return own + reaped;
}

/**
 * Per surviving pid: what the baseline saw of its descendants gone since. A
 * process that exits rolls everything it reaped up into its own parent's
 * reaped time, so a vanished process's last-seen total belongs to its nearest
 * ancestor still alive — not only to its direct parent (2026-11-06: main's
 * backend restarted, and its long-lived children's whole lives reached the
 * gateway's reaped time through it — 16 cores charged in a 10 s window).
 */
function vanishedDescendantsSeen(
  procs: readonly PsProcess[],
  baseline: CpuBaseline | null,
): Map<number, number> {
  const out = new Map<number, number>();
  if (baseline === null) return out;
  const alive = new Set(procs.map((p) => p.pid));
  for (const [pid, seen] of baseline.procs) {
    if (alive.has(pid)) continue;
    let ancestor = seen.ppid;
    while (!alive.has(ancestor)) {
      const up = baseline.procs.get(ancestor);
      if (up === undefined) break;
      ancestor = up.ppid;
    }
    if (!alive.has(ancestor)) continue;
    const total = seen.cpuTimeMs + (seen.reapedChildrenMs ?? 0);
    out.set(ancestor, (out.get(ancestor) ?? 0) + total);
  }
  return out;
}

/** A macOS app's executable, whose path holds spaces: the name after MacOS/. */
const APP_EXECUTABLE = /\.app\/Contents\/MacOS\/(.+?)(?= -|$)/;

/** Path segments kept of each argument: enough to name a script's plugin. */
const KEPT_SEGMENTS = 3;

/**
 * A command line, short enough to read in a list: an app's executable by its
 * name (`Google Chrome Helper (Renderer)`); otherwise the executable's file
 * name — a named process's whole name (`equin · server · main`) — then its
 * arguments, each path cut to its last segments (`bun cli/bin/index.ts check`).
 */
export function processLabel(args: string): string {
  const app = APP_EXECUTABLE.exec(args);
  if (app) return app[1]!.slice(0, 80);
  // The executable is the first word, unless it is a named one, whose name
  // holds spaces: then it runs from the last "/" before the product name.
  const named = processKindOf(args) !== null;
  const nameAt = named
    ? args.indexOf(`/${PRODUCT_NAME} · `) + 1
    : args
        .slice(0, args.indexOf(" ") === -1 ? undefined : args.indexOf(" "))
        .lastIndexOf("/") + 1;
  const short = args
    .slice(nameAt)
    .split(" ")
    .map((word) =>
      word.includes("/")
        ? word.split("/").filter(Boolean).slice(-KEPT_SEGMENTS).join("/")
        : word,
    )
    .join(" ");
  return short.slice(0, 80);
}

/**
 * One persisted window: each bucket's CPU (cores, from cumulative CPU-time
 * deltas against `baseline`, reaped children included) and memory, plus the
 * largest processes by memory and by CPU — so a window's "other" is named. Returns the next baseline too.
 */
export function summarizeOwners(opts: {
  procs: readonly PsProcess[];
  owner: ReadonlyMap<number, MachineUsageBucket>;
  memBytesOf: (p: PsProcess) => number;
  baseline: CpuBaseline | null;
  nowMs: number;
  cores: number;
}): { sample: OwnerSample; baseline: CpuBaseline } {
  const { procs, owner, memBytesOf, baseline, nowMs, cores } = opts;
  const windowMs = baseline === null ? null : nowMs - baseline.atMs;
  const perCores = (cpuMs: number | null): number | undefined =>
    cpuMs === null || windowMs === null || windowMs <= 0
      ? undefined
      : cpuMs / windowMs;

  const groups = new Map<MachineUsageBucket, OwnerUsage>(
    MACHINE_USAGE_BUCKETS.map((bucket) => [
      bucket,
      {
        bucket,
        processes: 0,
        memMb: 0,
        ...(windowMs === null ? {} : { cpuCores: 0 }),
      },
    ]),
  );
  const vanished = vanishedDescendantsSeen(procs, baseline);
  const rows: TopProcess[] = [];
  for (const p of procs) {
    const bucket = owner.get(p.pid) ?? "other";
    const g = groups.get(bucket)!;
    const memMb = memBytesOf(p) / MB;
    const cpuCores = perCores(cpuSince(p, baseline, vanished.get(p.pid) ?? 0));
    g.processes++;
    g.memMb += memMb;
    if (cpuCores !== undefined) g.cpuCores = (g.cpuCores ?? 0) + cpuCores;
    rows.push({
      bucket,
      name: processLabel(p.args),
      memMb,
      ...(cpuCores === undefined ? {} : { cpuCores }),
    });
  }

  const half = MACHINE_USAGE_TOP_PROCESSES / 2;
  const byMem = [...rows].sort((a, b) => b.memMb - a.memMb).slice(0, half);
  const byCpu = rows
    .filter((r) => !byMem.includes(r) && (r.cpuCores ?? 0) > 0)
    .sort((a, b) => (b.cpuCores ?? 0) - (a.cpuCores ?? 0))
    .slice(0, half);

  return {
    sample: {
      sampledAt: nowMs,
      ...(windowMs === null ? {} : { windowMs }),
      cores,
      owners: [...groups.values()],
      top: [...byMem, ...byCpu],
    },
    baseline: {
      atMs: nowMs,
      procs: new Map(
        procs.map((p) => [
          p.pid,
          {
            ppid: p.ppid,
            cpuTimeMs: p.cpuTimeMs,
            reapedChildrenMs: p.reapedChildrenMs,
          },
        ]),
      ),
    },
  };
}
