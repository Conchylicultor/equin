import { dlopen } from "bun:ffi";

// sys/resource.h: the darwin-specific `which` for getpriority/setpriority that
// reads/writes the PROCESS's darwinbg state (what `taskpolicy -b` sets), and the
// value that sets it. Measured 2026-10-15: `setpriority(…, 1)` returns 0 and
// changes NOTHING — only `PRIO_DARWIN_BG` (0x1000) demotes, only 0 clears. So
// every write below is verified by a read, never trusted from its return code.
const PRIO_DARWIN_PROCESS = 4;
const PRIO_DARWIN_BG = 0x1000;

/** Whether THIS process runs in macOS's background tier (darwinbg). */
export type DarwinBackground =
  | { kind: "darwinbg" }
  | { kind: "foreground" }
  | { kind: "unsupported"; reason: string };

function libSystem() {
  return dlopen("libSystem.dylib", {
    getpriority: { args: ["i32", "u32"], returns: "i32" },
    setpriority: { args: ["i32", "u32", "i32"], returns: "i32" },
  });
}

type Lib = ReturnType<typeof libSystem>["symbols"];

const isDarwinBg = (lib: Lib): boolean =>
  lib.getpriority(PRIO_DARWIN_PROCESS, 0) === 1;

/**
 * Read the calling process's own darwinbg state. darwinbg is INHERITED: an
 * agent session is spawned under `taskpolicy -b`, so everything it runs — the
 * push CLI, its check subprocess, a type-check worker — starts darwinbg even
 * when nothing asked for demotion.
 *
 * Only a SELF read is trustworthy. Measured 2026-10-15 from an agent shell:
 * `getpriority(PRIO_DARWIN_PROCESS, <other pid>)` returned 0 for a process
 * whose own read said 1, and `taskpolicy -B -p <pid>` exited 0 while leaving
 * the target darwinbg. `ps -o pri/ni` do not reflect it either.
 *
 * A dlopen/symbol failure on darwin throws: libSystem always exports it, so a
 * failure is a broken assumption, not a state.
 */
export function readDarwinBackground(): DarwinBackground {
  if (process.platform !== "darwin") {
    return {
      kind: "unsupported",
      reason: `${process.platform} has no darwinbg tier`,
    };
  }
  const { symbols, close } = libSystem();
  try {
    return isDarwinBg(symbols) ? { kind: "darwinbg" } : { kind: "foreground" };
  } finally {
    close();
  }
}

function setDarwinBg(lib: Lib, background: boolean): void {
  lib.setpriority(PRIO_DARWIN_PROCESS, 0, background ? PRIO_DARWIN_BG : 0);
  if (isDarwinBg(lib) !== background) {
    throw new Error(
      `spawn-priority: setpriority(PRIO_DARWIN_PROCESS) did not ${background ? "re-enter" : "leave"} darwinbg`,
    );
  }
}

/**
 * Run `fn` with THIS process out of darwinbg, then put it back the way it was.
 * Every child spawned while `fn` runs starts in the foreground (darwinbg is
 * inherited at spawn), so this lifts a whole subtree — the push's check
 * subprocess and its type-check worker — from the one place that holds it.
 *
 * Self-promotion is the only form that works from an agent session:
 * `taskpolicy -B -p <pid>` from there exits 0 and changes nothing (measured
 * 2026-10-15). A process already in the foreground runs `fn` untouched; so does
 * a host with no darwinbg tier.
 *
 * Who may call it is the caller's contract, exactly as for
 * `boostInteractiveQos`: lifting arbitrary agent work out of darwinbg defeats
 * the isolation this plugin exists for. Today its one caller is the
 * interactive lane of host-admission's `withHostGrant` — a human is blocked on
 * that holder, and the lane is bounded (one push at a time, the reserved floor).
 *
 * It lifts the WHOLE process for as long as `fn` runs, so anything else this
 * process does meanwhile is lifted too. To start one child in the foreground
 * without that, use `spawnInForeground`.
 */
export async function withForegroundPriority<T>(
  fn: () => Promise<T>,
): Promise<T> {
  if (process.platform !== "darwin") return fn();
  const { symbols, close } = libSystem();
  const wasBackground = isDarwinBg(symbols);
  if (!wasBackground) {
    close();
    return fn();
  }
  setDarwinBg(symbols, false);
  try {
    return await fn();
  } finally {
    setDarwinBg(symbols, true);
    close();
  }
}

/**
 * Run ONE synchronous spawn call with this process out of darwinbg, and put it
 * back before returning. darwinbg is inherited AT SPAWN, so the child (and its
 * whole subtree) starts in the foreground and stays there, while this process
 * is darwinbg again before any other callback of its event loop runs.
 *
 * That is the difference from `withForegroundPriority`, which lifts the whole
 * process for an async body: in a process running many things at once (the
 * check runner runs every check concurrently), that lift would leak to all of
 * them for as long as the body runs. Here the lifted window is one synchronous
 * call — `Bun.spawn` forks before it returns — so nothing else on this thread
 * can run inside it. (A Bun worker thread spawning in that same microsecond
 * window would be lifted too; nothing here spawns from worker threads.)
 *
 * `spawn` MUST be synchronous. A promise would mean the lift had already been
 * undone before the async part ran, so whatever it spawned started demoted —
 * the exact failure this exists to remove — and the call throws instead of
 * returning it. The type rejects a promise-returning callback up front.
 *
 * Who may call it is the caller's contract, as for `withForegroundPriority`:
 * its caller is a holder of a scarce host-pool slot (host-admission's
 * `holder: "foreground"` pools), whose hold time everyone queued on the pool
 * waits out — demoting that holder stretches every wait behind it. A process
 * already in the foreground, or a host with no darwinbg tier, spawns untouched.
 */
export function spawnInForeground<T>(spawn: () => NotPromise<T>): T {
  if (process.platform !== "darwin") return synchronous(spawn());
  const { symbols, close } = libSystem();
  try {
    if (!isDarwinBg(symbols)) return synchronous(spawn());
    setDarwinBg(symbols, false);
    try {
      return synchronous(spawn());
    } finally {
      setDarwinBg(symbols, true);
    }
  } finally {
    close();
  }
}

/** `T`, unless it is a promise — then nothing, so tsc rejects an async spawn. */
export type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;

function synchronous<T>(value: T): T {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  ) {
    throw new Error(
      "spawnInForeground: the spawn callback returned a promise. The lift is undone when the callback returns, so anything it spawns asynchronously starts in darwinbg — pass the synchronous spawn call itself.",
    );
  }
  return value;
}
