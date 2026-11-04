/**
 * Summarise the fs-latency monitor's history, per UTC hour: cold lstat /
 * readdir per tier, slowest op, stalls, vnode churn, disk read ops/s, MB/s and
 * device ms/op, fseventsd %CPU, and the file cache's lifetime (the smallest
 * canary age whose median residency fell below 50 %); then the window's p50s.
 * Reads the rotated archives (`fs-latency-archive/*.jsonl.gz`) and the live log.
 *
 *   ./equin run plugins/infra/plugins/host/plugins/io-health/plugins/monitor/scripts/report.ts \
 *     [--hours 24 | --since 2026-11-04T03:29 [--until 2026-11-04T16:23]] [--dir <monitors log dir>]
 *
 * `--since` / `--until` are UTC ISO prefixes (`--until` exclusive). The exit
 * criterion "no file-metadata stall over 1 s across a day" is `stalls 0` over 24 h.
 */
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { monitorLogsDir } from "@plugins/debug/data-dirs";
import {
  FS_LATENCY_LOG_NAME,
  type WrittenTick,
} from "@plugins/infra/plugins/host/plugins/io-health/core";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const dir = arg("--dir") ?? monitorLogsDir.path;
const since = arg("--since");
const until = arg("--until");
const fromT = Date.now() / 1000 - Number(arg("--hours") ?? 24) * 3600;
const ARCHIVES = "fs-latency-archive";
// `fs-latency-<first>--<last>.jsonl.gz` (bin/rotate.ts), time `:` spelled `-`.
const ARCHIVE = /^fs-latency-(.+)--(.+)\.jsonl\.gz$/;
const iso = (s: string) => s.replace(/T(\d\d)-(\d\d)-(\d\d)/, "T$1:$2:$3");

const inWindow = (r: WrittenTick) =>
  (since !== undefined ? r.iso >= since : r.t >= fromT) &&
  !(until !== undefined && r.iso >= until);

/** History is read as the monitor wrote it then: older ticks may lack later fields. */
function parse(text: string): WrittenTick[] {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as WrittenTick)
    .filter(inWindow);
}

const ticks: WrittenTick[] = [];
const archiveDir = join(dir, ARCHIVES);
if (existsSync(archiveDir)) {
  for (const name of readdirSync(archiveDir).sort()) {
    const m = ARCHIVE.exec(name);
    if (m === null) continue;
    // Skip an archive that ends before the window (by its name).
    const last = iso(m[2]!);
    if (since !== undefined ? last < since : Date.parse(last) / 1000 < fromT)
      continue;
    ticks.push(
      ...parse(
        gunzipSync(readFileSync(join(archiveDir, name))).toString("utf8"),
      ),
    );
  }
}
const live = join(dir, FS_LATENCY_LOG_NAME);
if (existsSync(live)) ticks.push(...parse(readFileSync(live, "utf8")));

function pct(xs: (number | null | undefined)[], q: number): number | null {
  const s = xs
    .filter((x): x is number => typeof x === "number")
    .sort((a, b) => a - b);
  return s.length === 0
    ? null
    : s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

function lifetime(ts: WrittenTick[]): string {
  const byAge = new Map<number, number[]>();
  for (const r of ts)
    for (const c of r.canary ?? []) {
      const age = Math.floor(c.age_s / 30) * 30;
      byAge.set(age, [...(byAge.get(age) ?? []), c.resident]);
    }
  if (byAge.size === 0) return "-";
  const ages = [...byAge.keys()].sort((a, b) => a - b);
  for (const age of ages)
    if (pct(byAge.get(age)!, 0.5)! < 0.5) return `<${age + 30}s`;
  return `>${ages.at(-1)}s`;
}

const f = (v: number | null) =>
  v === null ? "-" : v < 100 ? v.toFixed(2) : v.toFixed(0);
const col = (v: string | number, w: number) => String(v).padStart(w);

const hours = new Map<string, WrittenTick[]>();
for (const r of ticks) {
  const h = r.iso.slice(0, 13);
  hours.set(h, [...(hours.get(h) ?? []), r]);
}

console.log(
  `${"hour (UTC)".padEnd(13)} ${col("n", 4)} ${col("fg lstat", 8)} ${col("bg lstat", 8)} ${col("fg rd500", 8)} ${col("bg rd500", 8)} ${col("bg rdmax", 8)} ` +
    `${col("max op", 8)} ${col("stalls", 6)} ${col("newvn/s", 7)} ${col("rd ops/s", 8)} ${col("rd MB/s", 7)} ${col("ms/op", 6)} ${col("fsev%", 5)} ${col("cache", 7)}`,
);
for (const [h, ts] of hours) {
  console.log(
    `${h.padEnd(13)} ${col(ts.length, 4)} ` +
      `${col(
        f(
          pct(
            ts.map((r) => r.fg.lstat_p50),
            0.5,
          ),
        ),
        8,
      )} ${col(
        f(
          pct(
            ts.map((r) => r.bg.lstat_p50),
            0.5,
          ),
        ),
        8,
      )} ` +
      `${col(
        f(
          pct(
            ts.map((r) => r.fg.readdir500),
            0.5,
          ),
        ),
        8,
      )} ${col(
        f(
          pct(
            ts.map((r) => r.bg.readdir500),
            0.5,
          ),
        ),
        8,
      )} ` +
      `${col(f(Math.max(...ts.map((r) => r.bg.readdir500))), 8)} ${col(f(Math.max(...ts.map((r) => r.max_op_ms))), 8)} ` +
      `${col(ts.filter((r) => r.stall).length, 6)} ${col(
        f(
          pct(
            ts.map((r) => r.new_vnodes_s),
            0.5,
          ),
        ),
        7,
      )} ` +
      `${col(
        f(
          pct(
            ts.map((r) => r.disk_read_ops_s),
            0.5,
          ),
        ),
        8,
      )} ${col(
        f(
          pct(
            ts.map((r) => r.disk_read_mb_s),
            0.5,
          ),
        ),
        7,
      )} ` +
      `${col(
        f(
          pct(
            ts.map((r) => r.disk_read_ms_per_op),
            0.5,
          ),
        ),
        6,
      )} ` +
      `${col(
        f(
          pct(
            ts.map((r) => r.daemon_cpu?.fseventsd),
            0.5,
          ),
        ),
        5,
      )} ${col(lifetime(ts), 7)}`,
  );
}
if (ticks.length > 0) {
  const worst = ticks.reduce((a, b) => (b.max_op_ms > a.max_op_ms ? b : a));
  const p50 = (pick: (r: WrittenTick) => number | null | undefined) =>
    pct(ticks.map(pick), 0.5);
  console.log(
    `\nwindow: ${ticks[0]!.iso} → ${ticks.at(-1)!.iso}, p50: rd ops/s ${p50((r) => r.disk_read_ops_s)}, ` +
      `rd MB/s ${p50((r) => r.disk_read_mb_s)}, ms/op ${p50((r) => r.disk_read_ms_per_op)}, new vnodes/s ${p50((r) => r.new_vnodes_s)}, ` +
      `fseventsd %CPU ${p50((r) => r.daemon_cpu?.fseventsd)}`,
  );
  console.log(
    `window: ${ticks.length} ticks, stalls (> threshold) ${ticks.filter((r) => r.stall).length}, ` +
      `slowest op ${worst.max_op_ms.toFixed(0)} ms at ${worst.iso}, cache lifetime ${lifetime(ticks)}`,
  );
  if (ticks.some((r) => typeof r.disk_read_attributed_mb_s === "number"))
    console.log(
      `window p50: rd MB/s by live processes ${p50((r) => r.disk_read_attributed_mb_s)} ` +
        `(of which born mid-tick ${p50((r) => r.disk_read_born_mb_s)}); the rest of rd MB/s is processes ` +
        "gone before a tick saw them, and the kernel",
    );
}
console.log(
  "(latencies in ms; lstat = p50 of 40 cold lstats; rd500 = one cold 500-entry readdir)",
);
