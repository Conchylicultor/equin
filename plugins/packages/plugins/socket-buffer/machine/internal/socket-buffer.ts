import { dlopen, ptr } from "bun:ffi";
import type { Socket } from "node:net";

/** A socket's kernel buffer sizes, as `getsockopt` reports them (bytes). */
export interface SocketBufferSizes {
  readonly send: number;
  readonly receive: number;
}

/** What `raiseSocketSendBuffer` found and left: `SO_SNDBUF` before and after. */
export interface SendBufferRaise {
  readonly before: number;
  readonly after: number;
}

// <sys/socket.h>: the option level and names differ per platform.
const OPTIONS = {
  darwin: { SOL_SOCKET: 0xffff, SO_SNDBUF: 0x1001, SO_RCVBUF: 0x1002 },
  linux: { SOL_SOCKET: 1, SO_SNDBUF: 7, SO_RCVBUF: 8 },
} as const;

interface Sockopt {
  readonly options: (typeof OPTIONS)[keyof typeof OPTIONS];
  get(fd: number, name: number): number;
  set(fd: number, name: number, value: number): void;
}

// Bound LAZILY on first use (packages/flock's reasons): no dlopen at module
// eval, and the module stays importable where FFI is not.
let bound: Sockopt | undefined;

function sockopt(): Sockopt {
  if (bound !== undefined) return bound;
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux")
    throw new Error(
      `socket-buffer: no SO_SNDBUF binding for platform ${platform} (darwin and linux only)`,
    );
  const options = OPTIONS[platform];
  const { symbols } = dlopen(
    platform === "darwin" ? "libc.dylib" : "libc.so.6",
    {
      setsockopt: { args: ["i32", "i32", "i32", "ptr", "u32"], returns: "i32" },
      getsockopt: { args: ["i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
    },
  );
  const value = new Int32Array(1);
  const length = new Uint32Array(1);
  bound = {
    options,
    get(fd, name) {
      length[0] = 4;
      if (
        symbols.getsockopt(
          fd,
          options.SOL_SOCKET,
          name,
          ptr(value),
          ptr(length),
        ) !== 0
      )
        throw new Error(`socket-buffer: getsockopt(${fd}, ${name}) failed`);
      return value[0]!;
    },
    set(fd, name, v) {
      value[0] = v;
      if (symbols.setsockopt(fd, options.SOL_SOCKET, name, ptr(value), 4) !== 0)
        throw new Error(
          `socket-buffer: setsockopt(${fd}, ${name}, ${v}) failed: the value is over the kernel's cap (macOS: kern.ipc.maxsockbuf), or the socket's peer already closed (EINVAL on macOS)`,
        );
    },
  };
  return bound;
}

/**
 * The descriptor under a connected `net.Socket`. Bun and Node both carry it
 * on the socket's native handle (`_handle.fd`); a socket not connected yet,
 * or a runtime that moved it, has none — said loudly, never guessed.
 */
function socketFd(socket: Socket): number {
  const fd: unknown = (socket as unknown as { _handle?: { fd?: unknown } })
    ._handle?.fd;
  if (typeof fd !== "number" || fd < 0)
    throw new Error(
      "socket-buffer: this socket has no file descriptor on its handle (not connected yet, or the runtime no longer exposes `_handle.fd`)",
    );
  return fd;
}

/** The socket's `SO_SNDBUF` and `SO_RCVBUF`, as the kernel reports them. */
export function socketBufferSizes(socket: Socket): SocketBufferSizes {
  const fd = socketFd(socket);
  const s = sockopt();
  return {
    send: s.get(fd, s.options.SO_SNDBUF),
    receive: s.get(fd, s.options.SO_RCVBUF),
  };
}

/**
 * Raise the socket's `SO_SNDBUF` to at least `bytes`; never lower it.
 *
 * Why: on a macOS Unix stream socket the SENDER's `SO_SNDBUF` bounds how much
 * of a write is in flight (`net.local.stream.sendspace`, 8 KB by default; the
 * receiver's `SO_RCVBUF` changes nothing), so a large write leaves the process
 * one buffer per event-loop turn — on a busy loop, one busy turn per 8 KB. A
 * process may raise its own sockets up to `kern.ipc.maxsockbuf` (8 MB by
 * default) without root; over it `setsockopt` fails, and so does this.
 *
 * Linux reports twice the value set (its bookkeeping overhead) and caps an
 * unprivileged set at `net.core.wmem_max`; its Unix-socket default is already
 * ~208 KB. A buffer already at least `bytes` is left alone, so this never
 * shrinks one.
 */
export function raiseSocketSendBuffer(
  socket: Socket,
  bytes: number,
): SendBufferRaise {
  if (!Number.isInteger(bytes) || bytes <= 0)
    throw new RangeError(
      `socket-buffer: bytes must be a positive integer, got ${bytes}`,
    );
  const fd = socketFd(socket);
  const s = sockopt();
  const before = s.get(fd, s.options.SO_SNDBUF);
  if (before >= bytes) return { before, after: before };
  s.set(fd, s.options.SO_SNDBUF, bytes);
  return { before, after: s.get(fd, s.options.SO_SNDBUF) };
}
