// The calls the monitor makes that no command line exposes, over bun:ffi
// (macOS only): into libSystem, darwinbg on this process, page residency of a
// file (mincore over a read-only mapping), a process's disk bytes read and
// physical footprint (proc_pid_rusage), and the machine's awake clock with the
// boot it belongs to; into CoreServices, the current FSEvents event id.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, openSync } from "node:fs";

const lib = dlopen("/usr/lib/libSystem.B.dylib", {
  setpriority: {
    args: [FFIType.i32, FFIType.u32, FFIType.i32],
    returns: FFIType.i32,
  },
  getpriority: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  mmap: {
    args: [
      FFIType.u64,
      FFIType.u64,
      FFIType.i32,
      FFIType.i32,
      FFIType.i32,
      FFIType.i64,
    ],
    returns: FFIType.u64,
  },
  munmap: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  mincore: {
    args: [FFIType.u64, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },
  proc_pid_rusage: {
    args: [FFIType.i32, FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
  clock_gettime_nsec_np: { args: [FFIType.i32], returns: FFIType.u64 },
  sysctlbyname: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
});

const coreServices = dlopen(
  "/System/Library/Frameworks/CoreServices.framework/CoreServices",
  { FSEventsGetCurrentEventId: { args: [], returns: FFIType.u64 } },
);

const PRIO_DARWIN_PROCESS = 4;
const PRIO_DARWIN_BG = 0x1000;
const PROT_READ = 1;
const MAP_SHARED = 1;
const MAP_FAILED = 0xffff_ffff_ffff_ffffn;
// The VM page size mincore reports in: 16 KB on Apple silicon, 4 KB on Intel.
const PAGE = process.arch === "arm64" ? 16_384 : 4_096;

/**
 * Put this whole process in (or out of) darwinbg — the switch spawn-priority
 * uses for agents — and check it took.
 */
export function setDarwinbg(on: boolean): void {
  if (
    lib.symbols.setpriority(PRIO_DARWIN_PROCESS, 0, on ? PRIO_DARWIN_BG : 0) !==
    0
  )
    throw new Error("setpriority(PRIO_DARWIN_PROCESS) failed");
  if (lib.symbols.getpriority(PRIO_DARWIN_PROCESS, 0) !== (on ? 1 : 0))
    throw new Error("darwinbg state did not take");
}

/** Resident pages / pages of the first `bytes` of each file. */
export function residentFraction(paths: string[], bytes: number): number {
  const pages = Math.ceil(bytes / PAGE);
  const vec = new Uint8Array(pages);
  let res = 0;
  let tot = 0;
  for (const path of paths) {
    const fd = openSync(path, "r");
    let addr: bigint;
    try {
      addr = lib.symbols.mmap(0n, BigInt(bytes), PROT_READ, MAP_SHARED, fd, 0);
    } finally {
      closeSync(fd);
    }
    if (addr === MAP_FAILED) throw new Error(`mmap ${path} failed`);
    try {
      if (lib.symbols.mincore(addr, BigInt(bytes), vec) !== 0)
        throw new Error(`mincore ${path} failed`);
      for (const v of vec) res += v & 1;
      tot += pages;
    } finally {
      lib.symbols.munmap(addr, BigInt(bytes));
    }
  }
  return tot === 0 ? 0 : res / tot;
}

const RUSAGE_INFO_V2 = 2;
// struct rusage_info_v2: uuid[16], then 18 uint64 — ri_phys_footprint is the
// 8th, ri_diskio_bytesread the 17th.
const RUSAGE_V2_BYTES = 16 + 18 * 8;
const PHYS_FOOTPRINT_OFFSET = 16 + 7 * 8;
const DISKIO_READ_OFFSET = 16 + 16 * 8;

/** One uint64 field of `pid`'s rusage_info_v2; null when it cannot be read (gone, or not ours without root). */
function rusageField(pid: number, offset: number): number | null {
  const buf = new Uint8Array(RUSAGE_V2_BYTES);
  if (lib.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V2, buf) !== 0) return null;
  return Number(new DataView(buf.buffer).getBigUint64(offset, true));
}

/** Bytes `pid` has read from disk over its life; null when it cannot be read (gone, or not ours without root). */
export function diskBytesRead(pid: number): number | null {
  return rusageField(pid, DISKIO_READ_OFFSET);
}

/**
 * `pid`'s physical footprint in bytes — what Activity Monitor calls Memory:
 * resident and compressed anonymous memory it owns. Null when it cannot be
 * read (gone, or not ours without root).
 */
export function physFootprint(pid: number): number | null {
  return rusageField(pid, PHYS_FOOTPRINT_OFFSET);
}

/**
 * The most recent FSEvents event id on the system (every volume shares one
 * counter). Needs no root and no stream. Below 2^53, so a number is exact.
 */
export function currentFsEventId(): number {
  return Number(coreServices.symbols.FSEventsGetCurrentEventId());
}

// mach_absolute_time as a <time.h> clock: it pauses while the machine sleeps.
const CLOCK_UPTIME_RAW = 8;

/**
 * Where the machine's awake clock stands: ms it has been AWAKE since boot
 * (CLOCK_UPTIME_RAW, which stops while it sleeps), and the boot it counts from
 * (kern.bootsessionuuid) — two readings subtract only within one boot. Their
 * difference is the time the machine was awake between them, so an age judged
 * on it does not count a nap (packages/sleep-clock reads the same clock; this
 * binary imports no repo module at run time).
 */
export function awakeClock(): { awakeMs: number; boot: string } {
  const awakeMs =
    Number(lib.symbols.clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1e6;
  const name = Buffer.from("kern.bootsessionuuid\0", "utf8");
  const buf = new Uint8Array(64);
  const size = new BigUint64Array([BigInt(buf.byteLength)]);
  if (lib.symbols.sysctlbyname(ptr(name), ptr(buf), ptr(size), null, 0) !== 0)
    throw new Error("sysctl kern.bootsessionuuid failed");
  const end = buf.indexOf(0);
  const boot = new TextDecoder().decode(
    buf.subarray(0, end === -1 ? Number(size[0]) : end),
  );
  if (boot === "") throw new Error("sysctl kern.bootsessionuuid is empty");
  return { awakeMs, boot };
}
