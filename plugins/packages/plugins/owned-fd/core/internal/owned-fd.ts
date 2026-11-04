import { closeSync, openSync, type Mode, type OpenMode } from "node:fs";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// ---------------------------------------------------------------------------
// A file descriptor is a NUMBER, and a number has no owner: close it twice and
// the second close lands on whatever reused it in between — a pooled Postgres
// socket, a pipe, another temp file — which dies with no error at the site
// that killed it (research/2026-09-11-global-live-updates-frozen-by-stray-fd-close.md:
// a stuck live-state flush, a 5 h database wedge downstream of it). The report
// shows up at the victim, never at the culprit.
//
// So app code never closes a bare number: it holds an `OwnedFd`, which closes
// its descriptor exactly once. A second close does not reach the kernel — it
// throws, naming where the first close happened, so a double close is a loud
// error at the culprit instead of a silent one at the victim. Enforced by
// `owned-fd/no-raw-fd-close` (no `closeSync` / `close` from node:fs outside
// this file) and `owned-fd/no-raw-spawn-stdio-fd` (a spawn's stdio descriptor
// is an `OwnedFd`'s `.fd`, never a bare number).
// ---------------------------------------------------------------------------

/** A second `close()` of the same `OwnedFd`: the bug it exists to catch. */
export class FdAlreadyClosedError extends Error {
  override readonly name = "FdAlreadyClosedError";
  constructor(
    readonly fd: number,
    readonly firstClosedAt: string,
  ) {
    super(
      `fd ${fd} closed twice: a second close would have closed whatever ` +
        `reused that number. First closed at:\n${firstClosedAt}`,
    );
  }
}

/** One file descriptor and the right to close it, exactly once. */
export interface OwnedFd {
  /**
   * The descriptor, for calls that take one (read / write / fstat / flock, a
   * child's stdio — the child gets its own copy). Never closed by anyone but
   * `close()`.
   */
  readonly fd: number;
  /** Whether `close()` has run. */
  readonly closed: boolean;
  /** Close the descriptor. A second call throws `FdAlreadyClosedError`. */
  close(): void;
}

class Owned implements OwnedFd {
  // Where the first close happened. The Error captures the stack cheaply; its
  // text is only formatted (`.stack`) on the rare second close.
  #firstClose: Error | null = null;

  constructor(readonly fd: number) {}

  get closed(): boolean {
    return this.#firstClose !== null;
  }

  close(): void {
    if (this.#firstClose !== null) {
      throw new FdAlreadyClosedError(
        this.fd,
        this.#firstClose.stack ?? "(no stack)",
      );
    }
    // Recorded before the close: a close that throws (EBADF — someone else
    // closed the number already) has still spent this handle.
    this.#firstClose = new Error("first close");
    closeSync(this.fd);
  }
}

/**
 * `openSync`, owned: the descriptor closes through the returned handle only.
 * The path is an `AppPath` — a synchronous open of a path macOS gates would
 * block the thread on a permission prompt (`user-path/no-sync-fs`).
 */
export function openOwnedFd(
  path: AppPath,
  flags: OpenMode = "r",
  mode?: Mode | null,
): OwnedFd {
  return new Owned(openSync(path, flags, mode));
}

/**
 * Take ownership of a descriptor this code was handed and must close — a pipe
 * Bun created for a child's extra stdio slot (`child.stdio[3]`), an fd another
 * API returned. From here on it closes through the handle only.
 */
export function adoptFd(fd: number): OwnedFd {
  if (!Number.isInteger(fd) || fd < 0) {
    throw new RangeError(`adoptFd: not a file descriptor: ${fd}`);
  }
  return new Owned(fd);
}
