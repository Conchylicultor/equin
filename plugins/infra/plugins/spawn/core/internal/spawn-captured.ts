import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdParentLifeline } from "@plugins/packages/plugins/flock/core";
import { spawnAtTier } from "@plugins/packages/plugins/spawn-priority/core";
import { childEnv } from "./child-env";
import { trackLiveChild } from "./live-children";
import { readResourceUsage } from "./resource-usage";
import { signalName } from "./signal-code";
import type { ChildResourceUsage, SpawnOptions, SpawnResult } from "./types";

/**
 * A `spawnExpectOk` child that exited non-zero (or on a signal). Carries the
 * full capture so the caller's error path never has to re-run the command.
 */
export class SpawnFailedError extends Error {
  constructor(
    readonly argv: string[],
    readonly exitCode: number,
    readonly signalCode: string | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    const cause = signalCode ? `signal ${signalCode}` : `exit ${exitCode}`;
    const detail = stderr.trim() || stdout.trim();
    super(
      `Command failed (${cause}): ${argv.join(" ")}${detail ? `\n${detail}` : ""}`,
    );
    this.name = "SpawnFailedError";
  }
}

const decoder = new TextDecoder();

/**
 * How long a timed-out child gets to die politely after `SIGTERM` before we
 * `SIGKILL` it. Short: the deadline has already expired, this window only
 * exists so a child that flushes/cleans up on TERM gets to.
 */
const SIGKILL_GRACE_MS = 2_000;

function makeResult(
  exitCode: number,
  signalCode: string | null,
  timedOut: boolean,
  stdoutBytes: Uint8Array<ArrayBuffer>,
  stderrBytes: Uint8Array<ArrayBuffer>,
  resourceUsage: ChildResourceUsage,
): SpawnResult {
  let stdoutText: string | undefined;
  let stderrText: string | undefined;
  return {
    exitCode,
    signalCode,
    timedOut,
    stdoutBytes,
    stderrBytes,
    resourceUsage,
    get stdout() {
      return (stdoutText ??= decoder.decode(stdoutBytes));
    },
    get stderr() {
      return (stderrText ??= decoder.decode(stderrBytes));
    },
  };
}

/**
 * Run a child to completion, capturing stdout/stderr WITHOUT piped stdio.
 *
 * The child's streams are redirected to temp-file fds (raw numeric fds — a
 * plain kernel dup2, zero JS stream machinery in either direction) and read
 * back after exit. No stream, no pending pull promise, nothing for bun
 * 1.3.13's exit-during-pull race to wedge. stdin, when given, is a whole
 * buffer delivered the same way (a temp file opened for read).
 *
 * A non-zero exit is a RESULT, not an error — callers that treat it as fatal
 * use `spawnExpectOk`. Temp files orphaned by a hard crash are reclaimed by
 * the OS tmpdir sweep (repo convention).
 *
 * `opts` is REQUIRED and its type is a union, so every caller has to say what
 * bounds this child — `timeoutMs`, `signal`, or the prose `unbounded` opt-out.
 * See `SpawnOptions` for how to choose between the three.
 *
 * `opts.timeoutMs` is a one-shot deadline (see `SpawnBound`): SIGTERM on expiry,
 * SIGKILL after `SIGKILL_GRACE_MS`, `timedOut: true` on the result. Whatever the
 * child wrote before the kill is still captured — the temp files are read after
 * exit either way.
 *
 * `opts.signal` runs the SAME escalation but THROWS `signal.reason` instead of
 * returning a result, so an abandoned caller cannot absorb the cancellation and
 * carry on (see `SpawnBound.signal` for why the two differ).
 *
 * `opts.unbounded` is read by NOTHING here. It is a type-level and grep-level
 * artifact only, and this function behaves exactly as it did before bounds
 * existed when that is the arm chosen.
 */
export async function spawnCaptured(
  argv: string[],
  opts: SpawnOptions,
): Promise<SpawnResult> {
  const signal = opts.signal;
  // Before any side effect — the tmpdir AND the child. A caller that has already
  // been abandoned must not launch a fresh subprocess only to kill it a tick later.
  signal?.throwIfAborted();
  const dir = mkdtempSync(join(tmpdir(), "sg-spawn-"));
  try {
    const outPath = join(dir, "out");
    const errPath = join(dir, "err");
    let inFd: number | undefined;
    let outFd: number | undefined;
    let errFd: number | undefined;
    let proc: ReturnType<typeof Bun.spawn>;
    let exitCode: number;
    let timedOut = false;
    let aborted = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let untrack: (() => void) | undefined;
    // Held until the child is reaped; the kernel drops it if WE die first, and a
    // child that called `exitWithParent()` dies with it. The tmpdir is private
    // to this spawn, so the lock cannot be contended.
    const lifeline = holdParentLifeline(dir);
    try {
      if (opts.stdin !== undefined) {
        const inPath = join(dir, "in");
        writeFileSync(inPath, opts.stdin);
        inFd = openSync(inPath, "r");
      }
      outFd = openSync(outPath, "w");
      errFd = opts.mergeStderr ? outFd : openSync(errPath, "w");
      // The tier wraps exactly the synchronous `Bun.spawn` call: a
      // `foreground` lift (`spawnInForeground`) lasts only as long as the fork.
      const child = spawnAtTier(opts.tier ?? "inherit", argv, (tiered) =>
        Bun.spawn(tiered, {
          cwd: opts.cwd,
          env: childEnv(opts.env, lifeline),
          stdin: inFd ?? "ignore",
          stdout: outFd,
          stderr: errFd,
        }),
      );
      proc = child;
      untrack = trackLiveChild(child);
      // ONE escalation, shared by the deadline and the abort. The
      // `killTimer === undefined` guard is load-bearing rather than tidy: with
      // both a `timeoutMs` and a `signal` set, each path would otherwise schedule
      // its own SIGKILL timer and the `finally` — which clears the single
      // variable — would leave the earlier one running past the call.
      const escalateKill = () => {
        child.kill("SIGTERM");
        // Escalate only if TERM didn't take. `await proc.exited` resolves as
        // soon as the child is reaped either way, and both timers are
        // cleared in the `finally` below, so this never outlives the call.
        if (killTimer === undefined) {
          killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
        }
      };
      if (opts.timeoutMs !== undefined) {
        deadlineTimer = setTimeout(() => {
          // THE CHILD MAY ALREADY BE GONE, and then this is not a timeout.
          // `timedOut` means "our deadline fired and WE killed a child that was
          // still running" — not "our timer got round to firing". The two come
          // apart whenever the PARENT's event loop is starved past the deadline
          // by a long synchronous pass: `child.exited` is already settled, its
          // continuation just has not been scheduled yet, and this callback runs
          // first in the same drain. Observed in the field, not theorised:
          // `./singularity check` blocks its loop ~77 s building TypeScript
          // programs, and a `git worktree list` that finished in ~73 ms came back
          // `timedOut: true, exitCode: 0` — a successful result reported, and
          // thrown away, as a timeout. Killing here would also be a no-op against
          // a reaped pid, so there is nothing to escalate either.
          if (child.exitCode !== null || child.signalCode !== null) return;
          timedOut = true;
          escalateKill();
        }, opts.timeoutMs);
      }
      if (signal) {
        onAbort = () => {
          aborted = true;
          escalateKill();
        };
        // Removed in the `finally` below — non-negotiable, not hygiene: a caller
        // that spawns a batch of children under ONE dispatch-lifetime signal
        // would otherwise pile up a listener per spawn and trip
        // `MaxListenersExceededWarning` well before the batch finished.
        signal.addEventListener("abort", onAbort, { once: true });
      }
      exitCode = await child.exited;
      // A CHILD THAT SUCCEEDED DID NOT TIME OUT, whatever our timer believed.
      // The timer only ever proves that the deadline elapsed without us having
      // OBSERVED an exit; it cannot prove the child was still running, because
      // `child.exitCode` is populated at reap time and reaping needs this event
      // loop. Starve the loop — `./singularity check` blocks its own for ~77 s
      // building TypeScript programs — and a child that finished in 73 ms is
      // still unreaped when the deadline fires, so the guard above sees `null`
      // and marks a timeout on a process that had already exited cleanly. The
      // SIGTERM then lands on a reaped pid and does nothing, and the exit code we
      // finally read is the child's own. Deciding on the OUTCOME closes that gap:
      // exited-of-its-own-accord (no signal, clean status) is success, and its
      // result must be returned rather than discarded as a timeout.
      if (timedOut && exitCode === 0 && child.signalCode === null) {
        timedOut = false;
      }
    } finally {
      untrack?.();
      lifeline.release();
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      // Close our copies of the fds regardless of spawn/exit outcome; the
      // child held its own dups. mergeStderr aliases errFd to outFd.
      if (inFd !== undefined) closeSync(inFd);
      if (outFd !== undefined) closeSync(outFd);
      if (errFd !== undefined && errFd !== outFd) closeSync(errFd);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    }
    // AFTER the inner `finally` (fds closed, timers cleared, listener removed)
    // and BEFORE the reads: the outer `finally` still removes the tmpdir, and we
    // skip two file reads whose result is about to be discarded anyway. An abort
    // wins over `timedOut` whichever fired first, and wins over a clean exit that
    // simply had not been returned yet.
    if (aborted) throw signal?.reason;
    const stdoutBytes = new Uint8Array(readFileSync(outPath));
    const stderrBytes = opts.mergeStderr
      ? new Uint8Array(0)
      : new Uint8Array(readFileSync(errPath));
    // rusage is only populated once the child has exited.
    return makeResult(
      exitCode,
      signalName(proc.signalCode),
      timedOut,
      stdoutBytes,
      stderrBytes,
      readResourceUsage(proc),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `spawnCaptured` that THROWS a `SpawnFailedError` on any non-zero exit. */
export async function spawnExpectOk(
  argv: string[],
  opts: SpawnOptions,
): Promise<SpawnResult> {
  const result = await spawnCaptured(argv, opts);
  if (result.exitCode !== 0) {
    throw new SpawnFailedError(
      argv,
      result.exitCode,
      result.signalCode,
      result.stdout,
      result.stderr,
    );
  }
  return result;
}
