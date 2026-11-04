/**
 * The fs-latency monitor — one tick per run. launchd runs it every 30 s (the
 * `dev.equin.fs-latency-monitor` login service, or a root LaunchDaemon for
 * attribution); it measures, appends one JSON line to `<dir>/fs-latency.jsonl`,
 * and exits. No in-process timer: launchd's schedule is the clock, and a run
 * that hangs on a stalled disk delays the next instead of piling up.
 *
 *   fs-latency-monitor --dir <monitors log dir> [--defer-to <plist>]…
 *
 * Compiled into a standalone binary (`bun build --compile`, the monitor's
 * `deps/`): it imports no repo module at run time — only the TYPE of the line
 * it writes, `WrittenTick`, which tsc holds to the reader's schema in
 * `io-health/core`.
 *
 * Per tick:
 *
 *   probes     cold `lstat` of 40 files and a cold readdir of one 500-entry
 *              directory from a private corpus, once in the foreground and
 *              once in darwinbg (the switch spawn-priority uses). 10 dirs ×
 *              500 files visited round-robin, so a probe touches a file again
 *              only every ~10 ticks: the reading is the cold cost unless the
 *              cache outlives that interval.
 *   residency  12 canary groups × 50 files, one re-read per tick. Before it,
 *              every group's resident-page fraction (mincore) beside its age
 *              since its last read — the age where residency drops IS the
 *              file cache's lifetime.
 *   kernel     vnode counters, disk ops / bytes / device time per op
 *              (IOBlockStorageDriver statistics), load average.
 *   daemons    %CPU, pid and age of the watched system daemons: a pid that
 *              changes tick after tick is a relaunch loop.
 *   readers    root only: the processes reading the most from disk since the
 *              last tick, and the fseventsd log files fseventsd holds open.
 *
 * A tick whose slowest single op exceeds STALL_MS writes `"stall": true`; as
 * root it also captures a 5 s `fs_usage -f filesys` sample (one per
 * INCIDENT_COOLDOWN_S).
 */
import { gzipSync } from "node:zlib";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type {
  ProbeReading,
  WrittenTick,
} from "@plugins/infra/plugins/host/plugins/io-health/core";
import { diskBytesRead, residentFraction, setDarwinbg } from "./native";
import { rotateLog } from "./rotate";

const STALL_MS = 1000;
const INCIDENT_COOLDOWN_S = 600;
const PROBE_DIRS = 10;
const PROBE_DIR_FILES = 500;
const LSTAT_PER_TICK = 40;
const CANARY_GROUPS = 12;
const CANARY_FILES = 50;
const CANARY_BYTES = 16_384;
const TOP_READERS = 8;
const DAEMONS = [
  "fseventsd",
  "syspolicyd",
  "XprotectService",
  "mds",
  "mds_stores",
  "corecaptured",
] as const;

/** What one run carries to the next (`fs-latency.state.json`). */
interface State {
  tick?: number;
  canary_read_at?: Record<string, number>;
  prev?: {
    t: number;
    newv: number;
    recy: number;
    rops: number;
    wops: number;
    rbytes: number;
    rtime: number;
  };
  readers_prev?: Record<string, number>;
  readers_t?: number;
  last_incident?: number;
}

function args(): { dir: string; deferTo: string[] } {
  const argv = process.argv.slice(2);
  let dir: string | undefined;
  const deferTo: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${argv[i]} needs a value`);
    if (argv[i] === "--dir") dir = v;
    else if (argv[i] === "--defer-to") deferTo.push(v);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (dir === undefined)
    throw new Error("--dir <monitors log dir> is required");
  return { dir, deferTo };
}

function run(argv: string[], check = true): string {
  const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (check && p.exitCode !== 0)
    throw new Error(
      `${argv.join(" ")} exited ${p.exitCode}: ${p.stderr.toString()}`,
    );
  // ps truncates names to a byte count, which can split a multi-byte character.
  return new TextDecoder().decode(p.stdout);
}

function timed(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

const round = (v: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

function ensureCorpus(corpus: string): void {
  const marker = join(corpus, ".complete");
  if (existsSync(marker)) return;
  const blob = crypto.getRandomValues(new Uint8Array(CANARY_BYTES));
  for (let d = 0; d < PROBE_DIRS; d++) {
    const p = join(corpus, `probe-${String(d).padStart(2, "0")}`);
    mkdirSync(p, { recursive: true });
    for (let f = 0; f < PROBE_DIR_FILES; f++)
      writeFileSync(join(p, `f${String(f).padStart(4, "0")}`), "");
  }
  for (let g = 0; g < CANARY_GROUPS; g++) {
    const p = canaryDir(corpus, g);
    mkdirSync(p, { recursive: true });
    for (let f = 0; f < CANARY_FILES; f++) writeFileSync(canary(p, f), blob);
  }
  writeFileSync(marker, "");
}

const canaryDir = (corpus: string, g: number) =>
  join(corpus, `canary-${String(g).padStart(2, "0")}`);
const canary = (dir: string, f: number) =>
  join(dir, `c${String(f).padStart(3, "0")}`);

/** Cold lstat + readdir in one tier (ms). */
function probe(corpus: string, bg: boolean, tick: number): ProbeReading {
  setDarwinbg(bg);
  let lst: number[];
  let rd: number;
  try {
    // The two tiers of a tick each get their own directory, so neither warms the other's.
    const dLstat = (2 * tick + (bg ? 1 : 0)) % PROBE_DIRS;
    const dReaddir = (dLstat + PROBE_DIRS / 2) % PROBE_DIRS;
    const base = join(corpus, `probe-${String(dLstat).padStart(2, "0")}`);
    const start =
      (Math.floor(tick / PROBE_DIRS) * LSTAT_PER_TICK) % PROBE_DIR_FILES;
    lst = [];
    for (let i = 0; i < LSTAT_PER_TICK; i++) {
      const path = join(
        base,
        `f${String((start + i) % PROBE_DIR_FILES).padStart(4, "0")}`,
      );
      lst.push(timed(() => lstatSync(path)));
    }
    const rdPath = join(corpus, `probe-${String(dReaddir).padStart(2, "0")}`);
    rd = timed(() => readdirSync(rdPath).length);
  } finally {
    setDarwinbg(false);
  }
  lst.sort((a, b) => a - b);
  return {
    lstat_p50: round(lst[Math.floor(lst.length / 2)]!, 3),
    lstat_max: round(lst.at(-1)!, 3),
    lstat_sum: round(
      lst.reduce((a, b) => a + b, 0),
      2,
    ),
    readdir500: round(rd, 2),
    max_op: round(Math.max(lst.at(-1)!, rd), 2),
  };
}

function rewarm(dir: string): void {
  const buf = new Uint8Array(CANARY_BYTES);
  for (let f = 0; f < CANARY_FILES; f++) {
    const fd = openSync(canary(dir, f), "r");
    try {
      readSync(fd, buf, 0, CANARY_BYTES, 0);
    } finally {
      closeSync(fd);
    }
  }
}

function sysctl(names: string[]): Record<string, string> {
  const vals: Record<string, string> = {};
  for (const line of run(["sysctl", ...names]).split("\n")) {
    const i = line.indexOf(":");
    if (i !== -1) vals[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return vals;
}

function int(vals: Record<string, string>, name: string): number {
  const v = Number(vals[name]);
  if (!Number.isFinite(v)) throw new Error(`sysctl ${name}: ${vals[name]}`);
  return v;
}

/** The busiest block-storage driver's cumulative statistics. */
function diskStats(): Record<string, number> {
  const out = run([
    "ioreg",
    "-c",
    "IOBlockStorageDriver",
    "-r",
    "-w0",
    "-k",
    "Statistics",
  ]);
  let best: Record<string, number> = {};
  for (const m of out.matchAll(/"Statistics" = \{([^}]*)\}/g)) {
    const kv: Record<string, number> = {};
    for (const e of m[1]!.matchAll(/"([^"]+)"=(\d+)/g))
      kv[e[1]!] = Number(e[2]);
    if ((kv["Operations (Read)"] ?? 0) > (best["Operations (Read)"] ?? 0))
      best = kv;
  }
  return best;
}

/** ps's [[dd-]hh:]mm:ss as seconds. */
function etimeS(etime: string): number {
  const dash = etime.lastIndexOf("-");
  const days = dash === -1 ? 0 : Number(etime.slice(0, dash));
  let secs = 0;
  for (const part of etime.slice(dash + 1).split(":"))
    secs = secs * 60 + Number(part);
  return secs + days * 86_400;
}

function isDaemon(name: string): name is (typeof DAEMONS)[number] {
  return (DAEMONS as readonly string[]).includes(name);
}

function daemonCpu(): Record<string, number> {
  const want: Record<string, number> = Object.fromEntries(
    DAEMONS.map((d) => [d, 0]),
  );
  for (const line of run(["ps", "-Ao", "pcpu=,comm="]).split("\n")) {
    const m = /^\s*(\S+)\s+(.+)$/.exec(line);
    if (m === null) continue;
    const name = basename(m[2]!);
    if (isDaemon(name)) want[name] = round(want[name]! + Number(m[1]), 1);
  }
  return want;
}

/** pid and age of each watched daemon that is running (its oldest process). */
function daemonProcs(): WrittenTick["daemon_procs"] {
  const procs: WrittenTick["daemon_procs"] = {};
  for (const line of run(["ps", "-Ao", "pid=,etime=,comm="]).split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (m === null) continue;
    const name = basename(m[3]!);
    if (!isDaemon(name)) continue;
    const p = { pid: Number(m[1]), age_s: etimeS(m[2]!) };
    if (procs[name] === undefined || p.age_s > procs[name].age_s)
      procs[name] = p;
  }
  return procs;
}

/**
 * Root only: disk bytes read since the last tick, by process name (MB/s): the
 * top readers, the total over every live process, and the part of it read by
 * processes born since the last tick (counted from 0, so short-lived git and
 * hook runs are not dropped at first sight).
 */
function diskReaders(
  now: number,
  state: State,
): Pick<
  WrittenTick,
  "disk_readers_mb_s" | "disk_read_attributed_mb_s" | "disk_read_born_mb_s"
> {
  const prev = state.readers_prev ?? {};
  const prevT = state.readers_t;
  const cur: Record<string, number> = {};
  const byName = new Map<string, number>();
  let born = 0;
  for (const line of run(["ps", "-Ao", "pid=,etime=,comm="], false).split(
    "\n",
  )) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (m === null) continue;
    const read = diskBytesRead(Number(m[1]));
    if (read === null) continue;
    cur[m[1]!] = read;
    const before = prev[m[1]!];
    let delta: number;
    if (before !== undefined && read >= before) delta = read - before;
    else if (prevT !== undefined && etimeS(m[2]!) < now - prevT) {
      delta = read;
      born += delta;
    } else continue;
    const name = basename(m[3]!);
    byName.set(name, (byName.get(name) ?? 0) + delta);
  }
  state.readers_prev = cur;
  state.readers_t = now;
  if (prevT === undefined || now <= prevT)
    return {
      disk_readers_mb_s: null,
      disk_read_attributed_mb_s: null,
      disk_read_born_mb_s: null,
    };
  const dt = now - prevT;
  const mbS = (b: number) => round(b / dt / 1e6, 1);
  const top = [...byName].sort((a, b) => b[1] - a[1]).slice(0, TOP_READERS);
  return {
    disk_readers_mb_s: Object.fromEntries(top.map(([n, b]) => [n, mbS(b)])),
    disk_read_attributed_mb_s: mbS(
      [...byName.values()].reduce((a, b) => a + b, 0),
    ),
    disk_read_born_mb_s: mbS(born),
  };
}

/** Root only: the `.fseventsd` log files fseventsd holds open (hex event ids). */
function fseventsdLogs(): string[] | null {
  const pid = run(["pgrep", "-x", "fseventsd"], false).trim().split(/\s+/)[0];
  if (!pid) return null;
  const out = run(["lsof", "-nP", "-p", pid, "-Fn"], false);
  const names = new Set<string>();
  for (const ln of out.split("\n"))
    if (ln.startsWith("n") && ln.includes("/.fseventsd/"))
      names.add(ln.slice(ln.lastIndexOf("/") + 1));
  return [...names].sort();
}

function maybeIncident(
  root: string,
  now: number,
  state: State,
): string | undefined {
  if (now - (state.last_incident ?? 0) < INCIDENT_COOLDOWN_S) return undefined;
  const dir = join(root, "fs-latency-incidents");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(now * 1000)
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replaceAll("-", "")
    .replace("T", "-")
    .replaceAll(":", "");
  const path = join(dir, `${stamp}.fs_usage.txt.gz`);
  const p = Bun.spawnSync(["fs_usage", "-w", "-f", "filesys", "-t", "5"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  writeFileSync(path, gzipSync(p.stdout.subarray(0, 200 * 1024 * 1024)));
  state.last_incident = now;
  return path;
}

function readState(path: string): State {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as State;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

function main(): void {
  const { dir, deferTo } = args();
  const isRoot = process.geteuid?.() === 0;
  // The user agent stands aside while a root daemon of this monitor is
  // installed: one writer per log, and the root one also attributes.
  if (!isRoot && deferTo.some((p) => existsSync(p))) return;

  const corpus = join(dir, "fs-latency-corpus");
  const statePath = join(dir, "fs-latency.state.json");
  const log = join(dir, "fs-latency.jsonl");
  mkdirSync(dir, { recursive: true });
  ensureCorpus(corpus);
  const state = readState(statePath);
  const now = Date.now() / 1000;
  const tick = state.tick ?? 0;

  const fg = probe(corpus, false, tick);
  const bg = probe(corpus, true, tick);

  const lastRead = state.canary_read_at ?? {};
  const canaries: WrittenTick["canary"] = [];
  for (let g = 0; g < CANARY_GROUPS; g++) {
    const at = lastRead[String(g)];
    if (at === undefined) continue;
    const gdir = canaryDir(corpus, g);
    const files = Array.from({ length: CANARY_FILES }, (_, f) =>
      canary(gdir, f),
    );
    canaries.push({
      age_s: round(now - at, 1),
      resident: round(residentFraction(files, CANARY_BYTES), 3),
    });
  }
  const g = tick % CANARY_GROUPS;
  rewarm(canaryDir(corpus, g));
  lastRead[String(g)] = Date.now() / 1000;

  const k = sysctl([
    "vfs.vnstats.num_newvnode_calls",
    "vfs.vnstats.num_recycledvnodes",
    "kern.num_vnodes",
    "kern.maxvnodes",
    "vm.loadavg",
  ]);
  const d = diskStats();
  const cur = {
    t: now,
    newv: int(k, "vfs.vnstats.num_newvnode_calls"),
    recy: int(k, "vfs.vnstats.num_recycledvnodes"),
    rops: d["Operations (Read)"] ?? 0,
    wops: d["Operations (Write)"] ?? 0,
    rbytes: d["Bytes (Read)"] ?? 0,
    rtime: d["Total Time (Read)"] ?? 0,
  };
  const prev = state.prev;
  let rates: Pick<
    WrittenTick,
    | "new_vnodes_s"
    | "recycled_vnodes_s"
    | "disk_read_ops_s"
    | "disk_write_ops_s"
    | "disk_read_mb_s"
    | "disk_read_ms_per_op"
  > = {};
  if (prev !== undefined && now > prev.t) {
    const dt = now - prev.t;
    const ops = cur.rops - prev.rops;
    rates = {
      new_vnodes_s: Math.round((cur.newv - prev.newv) / dt),
      recycled_vnodes_s: Math.round((cur.recy - prev.recy) / dt),
      disk_read_ops_s: Math.round(ops / dt),
      disk_write_ops_s: Math.round((cur.wops - prev.wops) / dt),
      disk_read_mb_s: round((cur.rbytes - prev.rbytes) / dt / 1e6, 1),
      disk_read_ms_per_op:
        ops > 0 ? round((cur.rtime - prev.rtime) / ops / 1e6, 3) : null,
    };
  }
  state.prev = cur;

  const load1 = Number(
    k["vm.loadavg"]!.replace(/[{}]/g, "").trim().split(/\s+/)[0],
  );
  const maxOp = Math.max(fg.max_op, bg.max_op);
  const rec: WrittenTick = {
    t: round(now, 3),
    iso: new Date(now * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
    fg,
    bg,
    max_op_ms: maxOp,
    stall: maxOp > STALL_MS,
    canary: canaries,
    vnodes: int(k, "kern.num_vnodes"),
    maxvnodes: int(k, "kern.maxvnodes"),
    ...rates,
    load1,
    daemon_cpu: daemonCpu(),
    daemon_procs: daemonProcs(),
  };
  if (isRoot) {
    Object.assign(rec, diskReaders(now, state));
    rec.fseventsd_logs = fseventsdLogs();
    if (rec.stall) {
      const path = maybeIncident(dir, now, state);
      if (path !== undefined) rec.incident = path;
    }
  }
  state.tick = tick + 1;
  state.canary_read_at = lastRead;
  writeFileSync(statePath + ".tmp", JSON.stringify(state));
  renameSync(statePath + ".tmp", statePath);
  rotateLog(dir, log, now);
  appendFileSync(log, JSON.stringify(rec) + "\n");
}

main();
