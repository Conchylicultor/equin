import {
  readFile,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import type { ProcRusage } from "./proc-rusage";

// The Linux arms of `readProcRusageSync` / `readProcRusage`: one process's
// memory and CPU from procfs. Two readings, because the one in the terms of
// the host's own memory reading costs a page-table walk:
//
// - **Counted (`readProcRusageSync`, O(1))**: `/proc/<pid>/status`'s
//   `RssAnon + RssShmem` — the process's anonymous and shared-memory pages in
//   RAM, read off the kernel's per-process counters (no walk), a page shared
//   with other processes counted WHOLE in each (`sharedPages: "whole"`). Right
//   for one process on its own — this process's footprint on every profiler
//   span, a child's peak at exit — where nothing is summed.
// - **Proportional (`readProcRusage`, async)**: `/proc/<pid>/smaps_rollup`'s
//   `Pss_Anon + Pss_Shmem` — the same pages, a page shared by N processes
//   charged 1/N to each (`sharedPages: "proportional"`). Summed over every
//   process, that is the machine's `AnonPages` plus the mapped part of `Shmem`
//   (packages/host-memory's `processBytes`): the same pages counted once, so a
//   set of processes' sum can be subtracted from the machine-wide figure.
//   `ps`'s resident size cannot: it adds file-backed pages (the binary's text,
//   mapped libraries — page cache the kernel drops at will) and counts a shared
//   page once per process mapping it (Postgres's shared buffers, a forked
//   parent's copy-on-write pages). Swapped-out pages are in neither side.
//   The kernel walks the process's page tables to answer, under its mmap
//   lock — time growing with its resident size — so it is read off the
//   thread (async), never on a backend's event loop. A kernel whose rollup
//   states no `Pss_Anon` (older kernels) answers `unsupported`: no reading in
//   these terms exists there.
// - **Peak**: Linux keeps no peak of either, only of the whole resident size
//   (`VmHWM`, beside `VmRSS` now). The peak is the memory now plus how far the
//   resident size has fallen since its peak (`VmHWM − VmRSS`): what the process
//   gave back was its own working memory (a freed spike) in every case that
//   matters. `VmHWM` alone counts a shared page whole in every process mapping
//   it (a fork tree sharing a 1 GiB segment read 5 GiB of peaks for its 5
//   processes) and the binary's file pages. An estimate, usually high (file
//   pages evicted since the peak count as given back), low when file pages
//   faulted back in after a freed spike.
// - **CPU**: `/proc/<pid>/stat`'s utime + stime (own) and cutime + cstime (the
//   children it waited for, each already holding what it waited for — macOS's
//   `ri_child_*`), and its start time; all in clock ticks.
//
// `refused`: the kernel refuses another account's rollup (EACCES); every file
// is gone (ENOENT / ESRCH) for a process that exited since it was listed; and
// a process with no address space — a kernel thread, a zombie, or one exiting
// between two of the reads — states no `VmRSS`: it holds no process memory to
// read, like a process gone.

/**
 * Clock ticks per second in procfs's times: USER_HZ, 100 on every Linux
 * architecture's user ABI (the kernel converts its own HZ to it).
 */
const USER_HZ = 100;
const NS_PER_TICK = 1e9 / USER_HZ;

/** A procfs `Key:  <n> kB` file (smaps_rollup, status), each value in bytes. */
export function parseProcKb(text: string): Record<string, number> {
  const map: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+) kB\s*$/);
    if (m) map[m[1]!] = Number(m[2]) * 1024;
  }
  return map;
}

function required(
  map: Record<string, number>,
  key: string,
  source: string,
): number {
  const n = map[key];
  // A renamed line must not read as "no memory".
  if (n === undefined)
    throw new Error(`[proc-rusage] ${source} has no "${key}" line`);
  return n;
}

/** `/proc/<pid>/stat`'s CPU and start fields, in clock ticks. */
export function parseProcStat(text: string): {
  utime: number;
  stime: number;
  cutime: number;
  cstime: number;
  starttime: number;
} {
  // `pid (comm) state …`: comm may hold spaces and parentheses, so the fields
  // start after the LAST ')'. Fields are numbered from 1 (pid); state is 3.
  const close = text.lastIndexOf(")");
  if (close < 0) throw new Error("[proc-rusage] /proc/<pid>/stat has no comm");
  const f = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const field = (n: number): number => {
    const v = Number(f[n - 3]);
    if (!Number.isFinite(v))
      throw new Error(
        `[proc-rusage] /proc/<pid>/stat field ${n} is not a number`,
      );
    return v;
  };
  return {
    utime: field(14),
    stime: field(15),
    cutime: field(16),
    cstime: field(17),
    starttime: field(22),
  };
}

/** The procfs texts of one process: `smapsRollup` for the proportional reading. */
export interface ProcfsTexts {
  status: string;
  stat: string;
  smapsRollup?: string;
}

/**
 * One process's reading from its procfs texts: proportional when the rollup
 * is given, counted otherwise; `refused` when it has no address space;
 * `unsupported` when the rollup does not split Pss by kind.
 */
export function procRusageFromProcfs(texts: ProcfsTexts): ProcRusage {
  const status = parseProcKb(texts.status);
  const residentBytes = status["VmRSS"];
  if (residentBytes === undefined) return { kind: "refused" };
  const src = "/proc/<pid>/status";
  let now: number;
  let sharedPages: "whole" | "proportional";
  if (texts.smapsRollup === undefined) {
    now = required(status, "RssAnon", src) + required(status, "RssShmem", src);
    sharedPages = "whole";
  } else {
    const rollup = parseProcKb(texts.smapsRollup);
    // Empty: the address space went between the status read and this one.
    if (rollup["Rss"] === undefined) return { kind: "refused" };
    const anon = rollup["Pss_Anon"];
    const shmem = rollup["Pss_Shmem"];
    if (anon === undefined || shmem === undefined)
      return { kind: "unsupported" };
    now = anon + shmem;
    sharedPages = "proportional";
  }
  const stat = parseProcStat(texts.stat);
  return {
    kind: "read",
    memory: {
      physFootprintBytes: now,
      residentSizeBytes: residentBytes,
      peakPhysFootprintBytes:
        now + Math.max(0, required(status, "VmHWM", src) - residentBytes),
      sharedPages,
    },
    cpu: {
      ownNs: (stat.utime + stat.stime) * NS_PER_TICK,
      reapedChildrenNs: (stat.cutime + stat.cstime) * NS_PER_TICK,
    },
    startedNs: stat.starttime * NS_PER_TICK,
  };
}

const GONE_OR_REFUSED = new Set(["ENOENT", "ESRCH", "EACCES", "EPERM"]);

function refusedOrThrow(err: unknown): ProcRusage {
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== undefined && GONE_OR_REFUSED.has(code))
    return { kind: "refused" };
  throw err;
}

/** `pid`'s counted reading (O(1): the kernel's counters, no page walk). */
export function readLinuxProcRusageSync(pid: number): ProcRusage {
  try {
    // Status first: a process gone after it reads as refused, never as a
    // stat of a reused pid beside another's memory.
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return procRusageFromProcfs({ status, stat });
  } catch (err) {
    return refusedOrThrow(err);
  }
}

/** `pid`'s proportional reading — a page-table walk, read off the thread. */
export async function readLinuxProcRusage(pid: number): Promise<ProcRusage> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const smapsRollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
    return procRusageFromProcfs({ status, stat, smapsRollup });
  } catch (err) {
    return refusedOrThrow(err);
  }
}
