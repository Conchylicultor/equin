import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { flockTry, waitForFlock } from "@plugins/packages/plugins/flock/core";

// A first-come-first-served line across processes, built from nothing but files
// and kernel flocks — so a waiter that dies (SIGKILL, OOM) leaves the line by
// itself, and nobody consults a pid.
//
// - A TICKET is one file, `t-<monotonic ns>-<pid>-<seq>.lock`. Its name is its
//   place: the machine's monotonic clock is shared by every process, the name is
//   zero-padded so string order IS arrival order, and no name is ever reused.
//   It is created under a temp name, flocked exclusive in-process, and only then
//   renamed into place, so a visible ticket is always held by a live owner.
// - A waiter blocks on the ticket JUST AHEAD of it (one `waitForFlock` child),
//   so a leave wakes exactly the next one in line — never a thundering herd,
//   never an arbitrary pick among waiters.
// - A ticket whose lock can be taken has no owner (it left, or died): whoever
//   finds it reaps the file and looks again.
//
// One accepted fuzz: two callers that read the clock within the same few
// microseconds (between the clock read and the rename) can each see no
// predecessor. Their relative order is then arbitrary; nothing else is.

/** A place in a `TicketLine`, held until `leave()` (or process death). */
export interface Ticket {
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
   */
  join(opts?: { signal?: AbortSignal }): Promise<Ticket>;
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

function ticketName(): string {
  const ns = process.hrtime.bigint().toString().padStart(20, "0");
  const pid = String(process.pid).padStart(10, "0");
  const n = String(seq++ % 1_000_000).padStart(6, "0");
  return `t-${ns}-${pid}-${n}.lock`;
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

      const name = ticketName();
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
