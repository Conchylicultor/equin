import {
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  openOwnedFd,
  type OwnedFd,
} from "@plugins/packages/plugins/owned-fd/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdParentLifeline } from "@plugins/packages/plugins/flock/core";
import { spawnAtTier } from "@plugins/packages/plugins/spawn-priority/core";
import { armAwakeDeadline } from "./awake-deadline";
import { childEnv } from "./child-env";
import { killProcessGroup } from "./group-signal";
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
 * **A bound ends the child's whole tree, not just the child.** A bounded child
 * (`timeoutMs` or `signal`) leads a process group of its own — the same
 * `processGroup: "own"` mechanism `spawnPassthrough` offers — and the
 * escalation signals the group: `SIGTERM` to all of it, `SIGKILL` to all of it
 * after the grace, and once the leader is reaped whatever it left in the group
 * is `SIGKILL`ed before the call returns. Before this, a timed-out
 * `sh -c "…; sleep 30"` died and its `sleep` ran on, reparented to pid 1 — and
 * every shell pipeline, git hook or `taskpolicy` wrapper under a bound left its
 * real work running the same way. The group only matters once a bound fires: a
 * child that exits on its own leaves its group untouched, as before. (Leading a
 * group means `detached`, which bun implements as `setsid`: the child has no
 * controlling terminal. Its stdio is files here anyway; only a child that opens
 * `/dev/tty` itself notices.)
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
  const dir = asAppPath(await mkdtemp(join(tmpdir(), "sg-spawn-")));
  try {
    const outPath = joinAppPath(dir, "out");
    const errPath = joinAppPath(dir, "err");
    let inFd: OwnedFd | undefined;
    let outFd: OwnedFd | undefined;
    let errFd: OwnedFd | undefined;
    let proc: ReturnType<typeof Bun.spawn>;
    let exitCode: number;
    let timedOut = false;
    let aborted = false;
    let cancelDeadline: (() => void) | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let untrack: (() => void) | undefined;
    // Set when a bound fires: the group ended once the child is reaped.
    let groupToEnd: number | undefined;
    // See the doc comment: a bound has to reach the child's whole tree, and a
    // process group of its own is how. Nothing to fire for `unbounded`.
    const ownGroup = opts.timeoutMs !== undefined || opts.signal !== undefined;
    // Held until the child is reaped; the kernel drops it if WE die first, and a
    // child that called `exitWithParent()` dies with it. The tmpdir is private
    // to this spawn, so the lock cannot be contended.
    const lifeline = await holdParentLifeline(dir);
    try {
      if (opts.stdin !== undefined) {
        const inPath = joinAppPath(dir, "in");
        await writeFile(inPath, opts.stdin);
        inFd = await openOwnedFd(inPath, "r");
      }
      // `mergeStderr` aliases the two: ONE handle, so one close.
      const out = await openOwnedFd(outPath, "w");
      outFd = out;
      const err = opts.mergeStderr ? out : await openOwnedFd(errPath, "w");
      errFd = err;
      // Again, right before the child exists: the awaits above (tmpdir,
      // lifeline, opens) are a window an abort can land in, and a listener
      // added to an already-aborted signal never fires.
      signal?.throwIfAborted();
      // The tier wraps exactly the synchronous `Bun.spawn` call: a
      // `foreground` lift (`spawnInForeground`) lasts only as long as the fork.
      const child = spawnAtTier(opts.tier ?? "inherit", argv, (tiered) =>
        Bun.spawn(tiered, {
          cwd: opts.cwd,
          env: childEnv(opts.env, lifeline, opts.privateIndexWrites),
          stdin: inFd?.fd ?? "ignore",
          stdout: out.fd,
          stderr: err.fd,
          // A new process group led by the child (pgid = its pid).
          detached: ownGroup,
        }),
      );
      proc = child;
      // Every signal this call sends goes to the child's group when it leads
      // one — the exit reaper's `SIGTERM` included, so a parent that dies
      // mid-call takes the tree down with the child.
      const signalChild = (sig: NodeJS.Signals): void => {
        if (!ownGroup) return void child.kill(sig);
        // `child.kill` is a no-op once the child is reaped; a group kill is
        // not, and an emptied group's id is free for a new leader. Reaped =
        // `exitCode`/`signalCode` set. The post-reap SIGKILL in the `finally`
        // is the one deliberate exception, made right at the reap.
        if (child.exitCode !== null || child.signalCode !== null) return;
        killProcessGroup(child.pid, sig);
      };
      untrack = trackLiveChild({ kill: signalChild });
      // ONE escalation, shared by the deadline and the abort. The
      // `killTimer === undefined` guard is load-bearing rather than tidy: with
      // both a `timeoutMs` and a `signal` set, each path would otherwise schedule
      // its own SIGKILL timer and the `finally` — which clears the single
      // variable — would leave the earlier one running past the call.
      const escalateKill = () => {
        if (ownGroup) groupToEnd = child.pid;
        signalChild("SIGTERM");
        // Escalate only if TERM didn't take. `await proc.exited` resolves as
        // soon as the child is reaped either way, and both timers are
        // cleared in the `finally` below, so this never outlives the call.
        if (killTimer === undefined) {
          killTimer = setTimeout(
            () => signalChild("SIGKILL"),
            SIGKILL_GRACE_MS,
          );
        }
      };
      if (opts.timeoutMs !== undefined) {
        // Awake time, not wall time: a machine asleep past the deadline did not
        // run the child for it (`armAwakeDeadline`).
        cancelDeadline = armAwakeDeadline(opts.timeoutMs, () => {
          // THE CHILD MAY ALREADY BE GONE, and then this is not a timeout.
          // `timedOut` means "our deadline fired and WE killed a child that was
          // still running" — not "our timer got round to firing". The two come
          // apart whenever the PARENT's event loop is starved past the deadline
          // by a long synchronous pass: `child.exited` is already settled, its
          // continuation just has not been scheduled yet, and this callback runs
          // first in the same drain. Observed in the field, not theorised:
          // `./equin check` blocks its loop ~77 s building TypeScript
          // programs, and a `git worktree list` that finished in ~73 ms came back
          // `timedOut: true, exitCode: 0` — a successful result reported, and
          // thrown away, as a timeout. Killing here would also be a no-op against
          // a reaped pid, so there is nothing to escalate either.
          if (child.exitCode !== null || child.signalCode !== null) return;
          timedOut = true;
          escalateKill();
        });
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
      // loop. Starve the loop — `./equin check` blocks its own for ~77 s
      // building TypeScript programs — and a child that finished in 73 ms is
      // still unreaped when the deadline fires, so the guard above sees `null`
      // and marks a timeout on a process that had already exited cleanly. The
      // SIGTERM then lands on a reaped pid and does nothing, and the exit code we
      // finally read is the child's own. Deciding on the OUTCOME closes that gap:
      // exited-of-its-own-accord (no signal, clean status) is success, and its
      // result must be returned rather than discarded as a timeout.
      if (timedOut && exitCode === 0 && child.signalCode === null) {
        timedOut = false;
        // Nor is what it left behind ours to end: a clean exit's background
        // work is its own business, exactly as when no deadline fired.
        if (!aborted) groupToEnd = undefined;
      }
    } finally {
      untrack?.();
      lifeline.release();
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      // Close our handles regardless of spawn/exit outcome; the child held its
      // own dups. mergeStderr aliases errFd to outFd: the ONE handle, closed
      // once (a second close would throw, and on a bare number would have hit
      // whatever reused it).
      inFd?.close();
      outFd?.close();
      if (errFd !== undefined && errFd !== outFd) errFd.close();
      cancelDeadline?.();
      if (killTimer !== undefined) clearTimeout(killTimer);
      // The leader is reaped (or never ran); what it left in its group dies
      // now, with no further grace — the deadline has already expired, and the
      // leader's exit is the grace its descendants shared. Right after the
      // reap, so the pgid still names exactly this group (POSIX never reuses a
      // live group's id) or is empty (ESRCH, nothing signalled).
      if (groupToEnd !== undefined) killProcessGroup(groupToEnd, "SIGKILL");
    }
    // AFTER the inner `finally` (fds closed, timers cleared, listener removed)
    // and BEFORE the reads: the outer `finally` still removes the tmpdir, and we
    // skip two file reads whose result is about to be discarded anyway. An abort
    // wins over `timedOut` whichever fired first, and wins over a clean exit that
    // simply had not been returned yet.
    if (aborted) throw signal?.reason;
    const stdoutBytes = new Uint8Array(await readFile(outPath));
    const stderrBytes = opts.mergeStderr
      ? new Uint8Array(0)
      : new Uint8Array(await readFile(errPath));
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
    await rm(dir, { recursive: true, force: true });
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
