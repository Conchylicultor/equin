import { dlopen, ptr } from "bun:ffi";
import { writeSync } from "node:fs";

// <poll.h>: identical on darwin and linux.
const POLLOUT = 0x0004;
/** Block in poll(2) until the fd is ready — no timeout. */
const POLL_FOREVER = -1;

/**
 * libc's `poll`, dlopen'd lazily on the first EAGAIN: a writer that never
 * meets a full pipe (a terminal, a file, a blocking pipe) pays nothing.
 */
type Poll = (fds: number, nfds: number, timeout: number) => number;
let pollFn: Poll | null = null;

function loadPoll(): Poll {
  const { symbols } = dlopen(
    process.platform === "darwin" ? "libc.dylib" : "libc.so.6",
    // `nfds_t` is an unsigned int on darwin, an unsigned long on linux — both
    // take a register, and one fd fits either.
    { poll: { args: ["ptr", "u32", "i32"], returns: "i32" } },
  );
  return symbols.poll as unknown as Poll;
}

function poll(fds: number, nfds: number, timeout: number): number {
  pollFn ??= loadPoll();
  return pollFn(fds, nfds, timeout);
}

/** Blocks the thread until `fd` can take at least one more byte. */
function waitWritable(fd: number): void {
  // struct pollfd { int fd; short events; short revents; }
  const pfd = new Int32Array(2);
  pfd[0] = fd;
  new Int16Array(pfd.buffer)[2] = POLLOUT;
  // -1 is EINTR (a signal landed) or a broken fd: either way the caller's next
  // write either succeeds, meets EAGAIN and comes back here, or throws the
  // fd's real error (EPIPE, EBADF) — nothing is spun on or hidden.
  poll(ptr(pfd), 1, POLL_FOREVER);
}

/**
 * Writes every byte of `data` to `fd` before returning, whether the fd is
 * blocking or not.
 *
 * Why it exists: Bun sets O_NONBLOCK on a piped stdout/stderr the first time
 * `process.stdout` / `process.stderr` is touched (anything that logs does), and
 * the flag lives on the open file description, so it holds for every write to
 * that fd in the process. A bare `writeSync(1, …)` into a pipe whose reader is
 * slower than the writer (`./equin build | tail -40`) then throws `EAGAIN` once
 * the pipe's buffer is full — normal non-blocking semantics, not an error — or
 * writes only part of the buffer and returns the short count. This waits the
 * full pipe out in poll(2) and loops over short writes, so the call keeps the
 * synchronous "all of it is out" guarantee callers use writeSync for (bytes
 * printed right before `process.exit`).
 */
export function writeAllSync(fd: number, data: string | Uint8Array): void {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(fd, bytes, written, bytes.length - written);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
      waitWritable(fd);
    }
  }
}
