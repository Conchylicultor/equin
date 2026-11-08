import { dlopen, ptr } from "bun:ffi";

// <time.h> clock ids on darwin. CLOCK_MONOTONIC_RAW is mach_continuous_time: it
// keeps running while the machine sleeps. CLOCK_UPTIME_RAW is mach_absolute_time:
// it pauses. Both are raw (no NTP slewing), so over any window
//   Δcontinuous − Δawake = time asleep in that window, exactly.
const CLOCK_MONOTONIC_RAW = 4;
const CLOCK_UPTIME_RAW = 8;

export type SleepReading =
  /** Milliseconds the machine was asleep since the previous read (0 on the first). */
  | { supported: true; sleptMs: number }
  /** This platform offers no such pair of clocks here — NOT "it did not sleep". */
  | { supported: false };

export interface SleepMeter {
  /** Sleep since the previous `read()` on this meter. Synchronous, ~1 µs. */
  read(): SleepReading;
}

export type SleepClockReading =
  | {
      supported: true;
      /** kern.bootsessionuuid — `asleepMs` of two readings compare only within one boot. */
      boot: string;
      /** Cumulative time asleep since boot (MONOTONIC_RAW − UPTIME_RAW), machine-wide. */
      asleepMs: number;
      /** kern.waketime: the wall instant (epoch ms) of the last wake; null if never woke or unreadable. */
      wakeAtMs: number | null;
    }
  /** This platform offers no such clocks here — NOT "it did not sleep". */
  | { supported: false };

/** How long the machine has been awake since boot: a clock that stops while it sleeps. */
export type AwakeClockReading =
  | { supported: true; awakeMs: number }
  /** This platform offers no such clock here — NOT "no time passed". */
  | { supported: false };

interface LibSystem {
  clockNs(id: number): bigint;
  sysctl(name: string, buf: Uint8Array): number | null;
}

// libSystem's clock_gettime_nsec_np and sysctlbyname, dlopen'd LAZILY on first
// use — the same two reasons as packages/flock: no dlopen cost at module eval,
// and the module stays importable where FFI is not.
let lib: LibSystem | null = null;

function libSystem(): LibSystem {
  if (lib === null) {
    const { symbols } = dlopen("libSystem.B.dylib", {
      clock_gettime_nsec_np: { args: ["i32"], returns: "u64" },
      sysctlbyname: {
        args: ["ptr", "ptr", "ptr", "ptr", "usize"],
        returns: "i32",
      },
    });
    const sizeBuf = new BigUint64Array(1);
    lib = {
      clockNs: (id) => BigInt(symbols.clock_gettime_nsec_np(id)),
      // Fills `buf` with the value of sysctl `name`; returns the byte length
      // written, or null when the call fails (unknown name, buffer too small).
      sysctl(name, buf) {
        const cName = Buffer.from(`${name}\0`, "utf8");
        sizeBuf[0] = BigInt(buf.byteLength);
        const rc = symbols.sysctlbyname(
          ptr(cName),
          ptr(buf),
          ptr(sizeBuf),
          null,
          0,
        );
        return rc === 0 ? Number(sizeBuf[0]) : null;
      },
    };
  }
  return lib;
}

function readNs(id: number): bigint {
  return libSystem().clockNs(id);
}

/** Cumulative sleep since boot, in ns. The two clocks are read a few hundred
 *  nanoseconds apart, so a reading can come out a hair off; callers clamp. */
function asleepNs(): bigint {
  const continuous = readNs(CLOCK_MONOTONIC_RAW);
  const awake = readNs(CLOCK_UPTIME_RAW);
  return continuous - awake;
}

// The boot session never changes within a process's life — read it once.
let bootSession: string | null = null;

function readBootSession(): string {
  if (bootSession === null) {
    const buf = new Uint8Array(64);
    const len = libSystem().sysctl("kern.bootsessionuuid", buf);
    if (len === null || len === 0) {
      throw new Error("sleep-clock: sysctl kern.bootsessionuuid failed");
    }
    // The value is NUL-terminated; the reported length includes the NUL.
    const end = buf.indexOf(0);
    bootSession = new TextDecoder().decode(
      buf.subarray(0, end === -1 ? len : end),
    );
  }
  return bootSession;
}

/** kern.waketime is a `struct timeval` — on darwin (LP64) an i64 tv_sec and an
 *  i32 tv_usec padded to 16 bytes. */
function readWakeAtMs(): number | null {
  const buf = new Uint8Array(16);
  const len = libSystem().sysctl("kern.waketime", buf);
  if (len === null || len < 12) return null;
  const view = new DataView(buf.buffer);
  const sec = Number(view.getBigInt64(0, true));
  const usec = view.getInt32(8, true);
  if (sec === 0 && usec === 0) return null;
  return sec * 1000 + usec / 1000;
}

/**
 * The machine's sleep clock right now: which boot, how long it has been asleep
 * in total since that boot, and when it last woke. Two readings of the same
 * boot differ in `asleepMs` by exactly the sleep between them; `wakeAtMs` places
 * the most recent of those sleeps on the wall clock.
 *
 * darwin only. Elsewhere `{ supported: false }` — a caller must not read that
 * as "no sleep".
 */
export function readSleepClock(): SleepClockReading {
  if (process.platform !== "darwin") return { supported: false };
  const ns = asleepNs();
  return {
    supported: true,
    boot: readBootSession(),
    asleepMs: ns > 0n ? Number(ns) / 1e6 : 0,
    wakeAtMs: readWakeAtMs(),
  };
}

/**
 * The machine's awake clock right now (CLOCK_UPTIME_RAW): two readings differ by
 * the time the machine was AWAKE between them, sleep excluded — what a deadline
 * on work this machine runs should count. A JS timer does not: Bun's
 * `setTimeout` keeps running through sleep, so a 30-minute timer armed before a
 * night of dark wakes fires at the first wake past 30 wall-clock minutes, after
 * the work it bounds ran for a few of them.
 *
 * darwin only. Elsewhere `{ supported: false }`.
 */
export function readAwakeClock(): AwakeClockReading {
  if (process.platform !== "darwin") return { supported: false };
  return { supported: true, awakeMs: Number(readNs(CLOCK_UPTIME_RAW)) / 1e6 };
}

/**
 * A meter of machine sleep between successive reads.
 *
 * Why it exists: a laptop that naps for 5–17 s at a time (maintenance sleep on
 * battery) looks, to every timer-based instrument, exactly like a process that
 * froze for 5–17 s. On 2026-09-20 two unrelated backends filed identical
 * "event-loop stall" reports for the same naps. A wall-clock gap heuristic cannot
 * separate the two without also erasing real freezes; the OS can, because it keeps
 * one clock that pauses during sleep and one that does not.
 *
 * darwin only. Elsewhere `read()` answers `{ supported: false }` — a caller must
 * not read that as "no sleep".
 */
export function createSleepMeter(): SleepMeter {
  const first = readSleepClock();
  if (!first.supported) {
    return { read: () => ({ supported: false }) };
  }
  let lastAsleepMs = first.asleepMs;
  return {
    read(): SleepReading {
      const now = readSleepClock();
      if (!now.supported) return { supported: false };
      const sleptMs = now.asleepMs - lastAsleepMs;
      lastAsleepMs = now.asleepMs;
      // The two clocks are read a few hundred nanoseconds apart, so an awake
      // window can come out a hair negative.
      return { supported: true, sleptMs: sleptMs > 0 ? sleptMs : 0 };
    },
  };
}
