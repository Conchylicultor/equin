import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { dlopen } from "bun:ffi";
import { flockTry, waitForFlock } from "@plugins/packages/plugins/flock/core";

// A first-come-first-served line across processes, built from nothing but files
// and kernel flocks — so a waiter that dies (SIGKILL, OOM) leaves the line by
// itself, and nobody consults a pid.
//
// - A TICKET is one file, `t-<monotonic ns>-<pid>-<seq>.lock`. Its name is its
//   place: the machine's monotonic clock (libc `clock_gettime`, see machineNs)
//   is shared by every process, the name is zero-padded so string order IS
//   arrival order, and no name is ever reused.
//   It is created under a temp name, flocked exclusive in-process, and only then
//   renamed into place, so a visible ticket is always held by a live owner.
// - A waiter blocks on the ticket JUST AHEAD of it (one `waitForFlock` child),
//   so a leave wakes exactly the next one in line — never a thundering herd,
//   never an arbitrary pick among waiters.
// - A ticket whose lock can be taken has no owner (it left, or died): whoever
//   finds it reaps the file and looks again.
//
// - A PLACE is a ticket name's arrival part (`<ns>-<pid>`). A waiter that has
//   to step out of the line (the line it waits in stops applying for a while)
//   keeps its place and joins again AT it (`join({ place })`), ahead of everyone
//   who arrived after it — instead of at the back. Mint one with `arrive()`.
//   Waiters already blocked behind it re-scan when their predecessor leaves and
//   find it ahead. The one exception is a ticket that is ALREADY at the head:
//   it was granted while the rejoiner was out, so both are at the head at once.
//
// One accepted fuzz: two callers that read the clock within the same few
// microseconds (between the clock read and the rename) can each see no
// predecessor. Their relative order is then arbitrary; nothing else is.

/**
 * Where a caller stands in a line: the moment it first arrived, on the
 * machine-wide clock, plus its pid. Opaque — compare places only through a
 * line.
 */
export type TicketPlace = string & { readonly __brand: "TicketPlace" };

/** A place in a `TicketLine`, held until `leave()` (or process death). */
export interface Ticket {
  /** Where this ticket stands — pass it to a later `join` to rejoin here. */
  readonly place: TicketPlace;
  /**
   * Leave the line: the next waiter becomes the head. Synchronous and
   * idempotent — the instant it returns, the ticket's lock is gone.
   */
  leave(): void;
}

export interface TicketLine {
  /**
   * Take a ticket and resolve once it is at the head — every caller that joined
   * earlier has left. The caller then does what the line orders (take a slot)
   * and calls `leave()`.
   *
   * `signal` abandons the wait: the ticket is removed, the call throws
   * `signal.reason`, and the waiter behind it moves up.
   *
   * `place` (from `arrive()` or an earlier ticket) joins at that place rather
   * than at the back: behind every live ticket that arrived earlier, ahead of
   * every one that arrived later. Without it the place is now.
   */
  join(opts?: { signal?: AbortSignal; place?: TicketPlace }): Promise<Ticket>;
  /**
   * No live ticket in the line — nobody is waiting. Reaps the files of tickets
   * whose owner is gone. A caller deciding whether it may skip the line
   * (a free slot, nobody ahead) asks this.
   */
  isEmpty(): boolean;
}

const TICKET = /^t-\d{20}-\d{10}-\d{6}\.lock$/;

// Distinguishes two tickets one process takes within one clock tick.
let seq = 0;

// CLOCK_MONOTONIC in <time.h>: 6 on darwin (keeps running through sleep), 1 on
// Linux. Either is one clock for every process on the box, which is all the
// order needs.
const CLOCK_MONOTONIC = process.platform === "darwin" ? 6 : 1;

let clockGettime: ((id: number, ts: BigInt64Array) => number) | null = null;

/**
 * The machine-wide monotonic clock, in ns. NOT `process.hrtime`: under Bun it
 * counts from the process's own start, so ordering tickets by it put every
 * process that had waited longest at the BACK of the line — a build held for two
 * hours under duress was overtaken by every build started after it. libc is
 * dlopen'd lazily, like packages/flock.
 */
function machineNs(): bigint {
  if (clockGettime === null) {
    const { symbols } = dlopen(
      process.platform === "darwin" ? "libc.dylib" : "libc.so.6",
      { clock_gettime: { args: ["i32", "ptr"], returns: "i32" } },
    );
    clockGettime = (id, ts) => symbols.clock_gettime(id, ts);
  }
  // struct timespec on LP64 (darwin and Linux): i64 tv_sec, i64 tv_nsec.
  const ts = new BigInt64Array(2);
  if (clockGettime(CLOCK_MONOTONIC, ts) !== 0) {
    throw new Error("ticket-line: clock_gettime(CLOCK_MONOTONIC) failed");
  }
  return (ts[0] ?? 0n) * 1_000_000_000n + (ts[1] ?? 0n);
}

const PLACE = /^\d{20}-\d{10}$/;

/** Arrive now: a place in any line, to join at later (`join({ place })`). */
export function arrive(): TicketPlace {
  const ns = machineNs().toString().padStart(20, "0");
  const pid = String(process.pid).padStart(10, "0");
  return `${ns}-${pid}` as TicketPlace;
}

/** A fresh ticket name at `place`; the sequence number keeps it unique. */
function ticketName(place: TicketPlace): string {
  if (!PLACE.test(place)) {
    throw new Error(
      `ticket-line: not a ticket place: ${JSON.stringify(place)}`,
    );
  }
  const n = String(seq++ % 1_000_000).padStart(6, "0");
  return `t-${place}-${n}.lock`;
}

/** Live tickets in `dir`, oldest first. Unowned ones are reaped on the way. */
function liveTickets(dir: string, before?: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const live: string[] = [];
  for (const name of names.filter((n) => TICKET.test(n)).sort()) {
    if (before !== undefined && name >= before) break;
    if (isLive(join(dir, name))) live.push(name);
  }
  return live;
}

/**
 * Is a ticket held by its owner? A lock we can take means nobody holds it: the
 * owner left (between its unlink and its close) or died — reap the file.
 */
function isLive(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  try {
    if (!flockTry(fd)) return true;
    rmSync(path, { force: true });
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * A FIFO line whose tickets live in `dir` (created on first join). Every
 * process naming the same directory shares the line.
 */
export function createTicketLine(dir: string): TicketLine {
  return {
    isEmpty: () => liveTickets(dir).length === 0,

    async join(opts = {}) {
      const { signal } = opts;
      signal?.throwIfAborted();
      mkdirSync(dir, { recursive: true });

      const place = opts.place ?? arrive();
      const name = ticketName(place);
      const path = join(dir, name);
      const tmp = join(dir, `.${name}.tmp`);
      const fd = openSync(tmp, "wx");
      if (!flockTry(fd)) {
        closeSync(fd);
        rmSync(tmp, { force: true });
        throw new Error(`ticket-line(${dir}): could not lock a fresh ticket`);
      }
      renameSync(tmp, path);

      let left = false;
      const ticket: Ticket = {
        place,
        leave() {
          if (left) return;
          left = true;
          // Unlink first, then close: the close is what wakes the waiter behind
          // us, and by then the file is already gone from its next scan.
          rmSync(path, { force: true });
          closeSync(fd);
        },
      };

      try {
        for (;;) {
          signal?.throwIfAborted();
          const ahead = liveTickets(dir, name);
          const predecessor = ahead.at(-1);
          if (predecessor === undefined) return ticket;
          const predecessorPath = join(dir, predecessor);
          // Granted when the ticket ahead leaves or its owner dies. The child
          // opens the path for writing, so a ticket that left in the meantime is
          // recreated empty and granted at once — reap it either way and look
          // again: whoever was ahead of it is who we wait on next.
          const held = await waitForFlock(predecessorPath, { signal });
          rmSync(predecessorPath, { force: true });
          await held.release();
        }
      } catch (err) {
        ticket.leave();
        throw err;
      }
    },
  };
}
