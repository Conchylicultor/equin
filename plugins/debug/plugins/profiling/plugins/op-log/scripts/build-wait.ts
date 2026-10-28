// Where agent builds' wall time goes, per day: how long background-lane builds
// waited at the duress gate and for their host CPU grant, against their whole
// wall time. Usage:
//   ./equin run plugins/debug/plugins/profiling/plugins/op-log/scripts/build-wait.ts [days=7]
//
// The before/after ruler for the "Track: build and push speed" page
// (research/2026-10-28-global-duress-trip-on-real-trouble.md). Reads the whole
// op log (rotated files too, oldest first) through the op-log's own fold, and
// buckets each finished build by the UTC day it was requested. "Killed while
// held" counts builds whose gate wait ended `aborted`: the build died at the
// gate, usually at the 2 h background ceiling.
import { existsSync, readFileSync } from "node:fs";
import {
  foldOpLines,
  toOpRecords,
  type OpLine,
  type OpRecord,
  type WaitKind,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import {
  OP_LOG_FILE,
  readSleepNow,
} from "@plugins/debug/plugins/profiling/plugins/op-log/server";

const days = Number(process.argv[2] ?? 7);
if (!Number.isInteger(days) || days < 1)
  throw new Error("usage: build-wait.ts [days ≥ 1]");

function* opLines(): Generator<OpLine> {
  for (const file of [`${OP_LOG_FILE}.2`, `${OP_LOG_FILE}.1`, OP_LOG_FILE]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        yield JSON.parse(line) as OpLine;
      } catch (err) {
        // A torn line at a rotation boundary: the rest of the op still folds.
        if (!(err instanceof SyntaxError)) throw err;
      }
    }
  }
}

const records = toOpRecords(
  foldOpLines(opLines()).values(),
  Date.now(),
  readSleepNow(),
);

const waitMs = (r: OpRecord, kind: WaitKind): number =>
  r.waits
    .filter((w) => w.kind === kind)
    .reduce((sum, w) => sum + (w.wallMs ?? w.durationMs), 0);

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const k = (sorted.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (k - lo);
}

const since = new Date(Date.now() - days * 86_400_000)
  .toISOString()
  .slice(0, 10);
const byDay = new Map<string, OpRecord[]>();
for (const r of records) {
  if (r.kind !== "build" || r.lane !== "background") continue;
  if (r.closedBy === null) continue; // still running: its wait is not final
  const day = r.requestedAt.slice(0, 10);
  if (day < since) continue;
  byDay.set(day, [...(byDay.get(day) ?? []), r]);
}

const min = (ms: number): string => (ms / 60_000).toFixed(0);
const min1 = (ms: number): string => (ms / 60_000).toFixed(1);
console.log(
  "day         builds  wall(min)  gate(min) share  grant(min)  gate/build p50  p90    max   held  killed-held",
);
for (const [day, builds] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
  const wall = builds.reduce((s, r) => s + r.totalMs, 0);
  const gates = builds.map((r) => waitMs(r, "duress-valve"));
  const gate = gates.reduce((s, ms) => s + ms, 0);
  const grant = builds.reduce((s, r) => s + waitMs(r, "host-grant"), 0);
  const sorted = [...gates].sort((a, b) => a - b);
  const held = gates.filter((ms) => ms > 0).length;
  const killed = builds.filter((r) =>
    r.waits.some((w) => w.kind === "duress-valve" && w.result === "aborted"),
  ).length;
  console.log(
    [
      day.padEnd(10),
      String(builds.length).padStart(7),
      min(wall).padStart(10),
      min(gate).padStart(10),
      `${((100 * gate) / Math.max(wall, 1)).toFixed(0)}%`.padStart(6),
      min(grant).padStart(11),
      min1(percentile(sorted, 0.5)).padStart(15),
      min1(percentile(sorted, 0.9)).padStart(6),
      min1(sorted.at(-1) ?? 0).padStart(6),
      String(held).padStart(6),
      String(killed).padStart(12),
    ].join(" "),
  );
}
