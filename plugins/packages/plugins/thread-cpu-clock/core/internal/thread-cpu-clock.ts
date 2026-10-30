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
