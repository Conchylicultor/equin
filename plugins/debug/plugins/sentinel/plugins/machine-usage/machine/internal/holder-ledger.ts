import {
  HOLDER_PEAK_WINDOW_MS,
  holderReserve,
  peaksByWork,
  type CpuHolderMarker,
  type HolderPeakRecord,
  type HolderReading,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import type { PsProcess } from "../../core";

// Each `cpu` share's memory, measured per holder: its process tree's footprint
// at every reading, its peak recorded in host-admission's holder-peak ledger
// when it ends, and its reservation derived from that ledger (`holderReserve`)
// — the per-holder half of the fleet reading every grant acquire sizes its
// window from.

/** One holder's tree at a reading. */
export interface HolderTree {
  /** Its processes' footprints now: what it is charged. */
  bytes: number;
  /** Their lifetime peak footprints, summed: what its recorded peak is read from. */
  peakBytes: number;
  /**
   * Another share of the same process was measured first and took the tree:
   * this one is charged its reservation alone, and its 0 is no peak to record.
   */
  shared: boolean;
}

/**
 * Each holder's process tree: its own process and every descendant, stopping
 * at another holder's process (a descendant that holds a share of its own is
 * measured as that holder, never twice).
 */
export function measureHolderTrees(
  procs: readonly PsProcess[],
  holders: readonly CpuHolderMarker[],
  memBytesOf: (p: PsProcess) => number,
  peakBytesOf: (p: PsProcess) => number,
): Map<CpuHolderMarker, HolderTree> {
  const children = new Map<number, PsProcess[]>();
  const byPid = new Map<number, PsProcess>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const holderPids = new Set(holders.map((h) => h.pid));
  const out = new Map<CpuHolderMarker, HolderTree>();
  for (const h of holders) {
    const root = byPid.get(h.pid);
    let bytes = 0;
    let peakBytes = 0;
    // A holder `ps` no longer lists exited between the two reads: nothing.
    const stack = root ? [root] : [];
    while (stack.length > 0) {
      const p = stack.pop()!;
      bytes += memBytesOf(p);
      peakBytes += peakBytesOf(p);
      for (const c of children.get(p.pid) ?? [])
        if (!holderPids.has(c.pid)) stack.push(c);
    }
    // One process may hold several shares (one marker each): its tree is
    // charged to the first, the others hold their reservation alone.
    const shared = [...out.keys()].some((o) => o.pid === h.pid);
    out.set(
      h,
      shared
        ? { bytes: 0, peakBytes: 0, shared: true }
        : { bytes, peakBytes, shared: false },
    );
  }
  return out;
}

/** What the tracker needs from the world: the ledger, and a clock. */
export interface HolderLedgerDeps {
  /** Every ledger record since `sinceMs` — read once, on the first reading. */
  readPeaks: (sinceMs: number) => Promise<HolderPeakRecord[]>;
  recordPeak: (record: HolderPeakRecord) => Promise<void>;
  nowMs: () => number;
}

interface Seen {
  marker: CpuHolderMarker;
  /** Ever measured as a second share of its process: never recorded. */
  shared: boolean;
  peakBytes: number;
  firstMs: number;
  lastMs: number;
  samples: number;
}

/** A holder's identity across readings: its process and when it took its share. */
function keyOf(m: CpuHolderMarker): string {
  return `${m.pid}:${m.since}:${m.work}:${m.units}`;
}

/**
 * The per-holder ledger as main's sampler keeps it: `observe` takes one
 * reading's measured holders and answers what each is reserved, recording
 * the peak of every holder that has ended since the previous reading.
 *
 * A holder's peak is the largest, across the 30 s readings that saw it, of
 * its live processes' lifetime peaks summed: a process's spike between two
 * readings is kept, and summing peaks that need not coincide errs high. What
 * it cannot see is a process that started and ended between two readings
 * (and a holder shorter than one reading is never recorded): that biases the
 * record low, but only for the reservation — what a holder is CHARGED is
 * never below what it is measured at, at every reading.
 */
export function createHolderLedger(deps: HolderLedgerDeps): {
  observe: (
    measured: ReadonlyMap<CpuHolderMarker, HolderTree>,
  ) => Promise<HolderReading[]>;
} {
  let ledger: HolderPeakRecord[] | null = null;
  const live = new Map<string, Seen>();
  return {
    observe: async (measured) => {
      const now = deps.nowMs();
      ledger ??= await deps.readPeaks(now - HOLDER_PEAK_WINDOW_MS);
      const present = new Set<string>();
      for (const [marker, { peakBytes, shared }] of measured) {
        const key = keyOf(marker);
        present.add(key);
        const seen = live.get(key);
        if (seen) {
          seen.shared ||= shared;
          seen.peakBytes = Math.max(seen.peakBytes, peakBytes);
          seen.lastMs = now;
          seen.samples++;
        } else
          live.set(key, {
            marker,
            shared,
            peakBytes,
            firstMs: now,
            lastMs: now,
            samples: 1,
          });
      }
      for (const [key, seen] of live) {
        if (present.has(key)) continue;
        live.delete(key);
        if (seen.shared) continue;
        const record: HolderPeakRecord = {
          t: new Date(seen.lastMs).toISOString(),
          work: seen.marker.work,
          units: seen.marker.units,
          lane: seen.marker.lane,
          peakBytes: seen.peakBytes,
          samples: seen.samples,
          seenMs: seen.lastMs - seen.firstMs,
        };
        await deps.recordPeak(record);
        ledger.push(record);
      }
      const peaks = peaksByWork(ledger, now);
      return [...measured].map(([marker, { bytes }]) => {
        const reserve = holderReserve(
          marker.units,
          peaks.get(marker.work) ?? [],
        );
        return {
          work: marker.work,
          units: marker.units,
          bytes,
          reserveBytes: reserve.bytes,
          reserveBasis: reserve.basis,
        };
      });
    },
  };
}
