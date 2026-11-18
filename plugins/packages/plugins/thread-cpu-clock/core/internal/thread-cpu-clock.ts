import { dlopen, ptr } from "bun:ffi";

// CLOCK_THREAD_CPUTIME_ID: the CPU time consumed by the CALLING thread. The id
// differs per platform (<time.h>): 16 on darwin, 3 on Linux.
const DARWIN_THREAD_CPUTIME_ID = 16;
const LINUX_THREAD_CPUTIME_ID = 3;

export type ThreadCpuReading =
  /** Cumulative CPU time of the calling thread since it started, in ms. */
  | { supported: true; ms: number }
  /** This platform offers no such clock here — NOT "the thread did not run". */
  | { supported: false };

// Bound LAZILY on first read, for packages/flock's two reasons: no dlopen cost
// at module eval, and the module stays importable where FFI is not.
let reader: (() => number) | null | undefined;

function bind(): (() => number) | null {
  if (process.platform === "darwin") {
    const { symbols } = dlopen("libSystem.B.dylib", {
      clock_gettime_nsec_np: { args: ["i32"], returns: "u64" },
    });
    return () =>
      Number(symbols.clock_gettime_nsec_np(DARWIN_THREAD_CPUTIME_ID)) / 1e6;
  }
  if (process.platform === "linux") {
    const { symbols } = dlopen("libc.so.6", {
      clock_gettime: { args: ["i32", "ptr"], returns: "i32" },
    });
    // struct timespec on LP64: i64 tv_sec, i64 tv_nsec.
    const buf = new BigInt64Array(2);
    const p = ptr(buf);
    return () => {
      const rc = symbols.clock_gettime(LINUX_THREAD_CPUTIME_ID, p);
      if (rc !== 0) throw new Error(`thread-cpu-clock: clock_gettime → ${rc}`);
      return Number(buf[0]) * 1000 + Number(buf[1]) / 1e6;
    };
  }
  return null;
}

/**
 * The calling thread's CPU time so far. Two reads ON THE SAME THREAD differ by
 * exactly the time that thread spent on a core between them — never the time
 * it was runnable but not scheduled, blocked in the kernel, or the machine
 * slept. That is the one thing a late timer cannot say on its own.
 *
 * Why it exists: `process.cpuUsage()` is process-wide (every worker thread
 * counts), and Bun exposes no per-thread clock. A check pass demoted to macOS
 * background priority fired its 50 ms tick seconds late while its thread ran a
 * fifth of that time; only this clock tells the two apart.
 *
 * darwin and Linux. Elsewhere `{ supported: false }`. ~1 µs per read.
 */
export function readThreadCpu(): ThreadCpuReading {
  if (reader === undefined) reader = bind();
  if (reader === null) return { supported: false };
  return { supported: true, ms: reader() };
}

/**
 * A thread's CPU clock as another thread of the SAME process reads it — taken
 * by `threadCpuHandle()` ON the thread to watch, handed over as plain data
 * (a worker's `workerData`), read by `readThreadCpuOf(handle)` anywhere.
 *
 * - darwin: the thread's Mach port (`mach_thread_self()`), read through
 *   `thread_info(THREAD_BASIC_INFO)` — user + system time, µs resolution.
 * - Linux: the thread's CPU clock id (`pthread_getcpuclockid`), read through
 *   `clock_gettime`.
 *
 * Valid only inside the process that took it, and only while that thread
 * lives (a process's main thread: its whole life).
 */
export type ThreadCpuHandle =
  | { supported: true; platform: "darwin"; port: number }
  | { supported: true; platform: "linux"; clockId: number }
  | { supported: false };

/**
 * The CALLING thread's handle — see `ThreadCpuHandle`. Take it once: on darwin
 * every `mach_thread_self()` adds a reference to the port, released only when
 * the process ends.
 */
export function threadCpuHandle(): ThreadCpuHandle {
  if (process.platform === "darwin") {
    const { symbols } = dlopen("libSystem.B.dylib", {
      mach_thread_self: { args: [], returns: "u32" },
    });
    return {
      supported: true,
      platform: "darwin",
      port: symbols.mach_thread_self(),
    };
  }
  if (process.platform === "linux") {
    const { symbols } = dlopen("libc.so.6", {
      pthread_self: { args: [], returns: "u64" },
      pthread_getcpuclockid: { args: ["u64", "ptr"], returns: "i32" },
    });
    const out = new Int32Array(1);
    const rc = symbols.pthread_getcpuclockid(symbols.pthread_self(), ptr(out));
    if (rc !== 0)
      throw new Error(`thread-cpu-clock: pthread_getcpuclockid → ${rc}`);
    return { supported: true, platform: "linux", clockId: out[0]! };
  }
  return { supported: false };
}

// THREAD_BASIC_INFO's flavor and its size in 32-bit words (<mach/thread_info.h>):
// user_time {sec, usec}, system_time {sec, usec}, cpu_usage, policy, run_state,
// flags, suspend_count, sleep_time.
const THREAD_BASIC_INFO = 3;
const THREAD_BASIC_INFO_COUNT = 10;

let otherReader:
  ((handle: ThreadCpuHandle & { supported: true }) => number) | undefined;

function bindOther(): (
  handle: ThreadCpuHandle & { supported: true },
) => number {
  if (process.platform === "darwin") {
    const { symbols } = dlopen("libSystem.B.dylib", {
      thread_info: { args: ["u32", "i32", "ptr", "ptr"], returns: "i32" },
    });
    const info = new Int32Array(THREAD_BASIC_INFO_COUNT);
    const count = new Uint32Array(1);
    const infoPtr = ptr(info);
    const countPtr = ptr(count);
    return (handle) => {
      if (handle.platform !== "darwin")
        throw new Error(
          `thread-cpu-clock: a ${handle.platform} handle read on darwin`,
        );
      count[0] = THREAD_BASIC_INFO_COUNT;
      const rc = symbols.thread_info(
        handle.port,
        THREAD_BASIC_INFO,
        infoPtr,
        countPtr,
      );
      if (rc !== 0) throw new Error(`thread-cpu-clock: thread_info → ${rc}`);
      return (info[0]! + info[2]!) * 1000 + (info[1]! + info[3]!) / 1000;
    };
  }
  if (process.platform === "linux") {
    const { symbols } = dlopen("libc.so.6", {
      clock_gettime: { args: ["i32", "ptr"], returns: "i32" },
    });
    const buf = new BigInt64Array(2);
    const p = ptr(buf);
    return (handle) => {
      if (handle.platform !== "linux")
        throw new Error(
          `thread-cpu-clock: a ${handle.platform} handle read on linux`,
        );
      const rc = symbols.clock_gettime(handle.clockId, p);
      if (rc !== 0) throw new Error(`thread-cpu-clock: clock_gettime → ${rc}`);
      return Number(buf[0]) * 1000 + Number(buf[1]) / 1e6;
    };
  }
  throw new Error(
    `thread-cpu-clock: a supported handle read on ${process.platform}, which takes none`,
  );
}

/**
 * The CPU time, in ms, of the thread `handle` names — read from any thread of
 * the process that took it. Same meaning as `readThreadCpu` on that thread:
 * time on a core, never time runnable-but-unscheduled, blocked, or asleep. It
 * is what lets a watchdog thread tell a thread that HOLDS its core without
 * yielding from one the OS is merely starving.
 */
export function readThreadCpuOf(handle: ThreadCpuHandle): ThreadCpuReading {
  if (!handle.supported) return { supported: false };
  otherReader ??= bindOther();
  return { supported: true, ms: otherReader(handle) };
}
