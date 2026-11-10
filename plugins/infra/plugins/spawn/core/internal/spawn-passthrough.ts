import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdtemp, rm } from "node:fs/promises";
import {
  openOwnedFd,
  type OwnedFd,
} from "@plugins/packages/plugins/owned-fd/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdParentLifeline } from "@plugins/packages/plugins/flock/core";
import { spawnAtTier } from "@plugins/packages/plugins/spawn-priority/core";
import { childEnv } from "./child-env";
import { trackLiveChild } from "./live-children";
import { endProcessGroup, killProcessGroup } from "./process-group";
import { readResourceUsage } from "./resource-usage";
import { signalName } from "./signal-code";
import type {
  SpawnGroupResult,
  SpawnPassthroughOptions,
  SpawnPassthroughResult,
  SpawnToFileOptions,
} from "./types";

/**
 * Run a child to completion with stdout/stderr INHERITED (the child writes
 * straight to the parent's terminal — no JS streams, nothing to wedge) and
 * stdin ignored unless `stdin: "inherit"` is asked for. For the exec-shaped
 * sites: build steps and the push flow's subprocesses.
 *
 * A non-zero exit is a RESULT — callers branch (most `process.exit(1)`).
 * `onSpawn` exposes `{ pid, kill }` synchronously for signal forwarding
 * (relaying SIGINT/SIGTERM from the parent so a kill never strands the child).
 */
export function spawnPassthrough(
  argv: string[],
  opts: SpawnPassthroughOptions & { processGroup: "own" },
): Promise<SpawnGroupResult>;
export function spawnPassthrough(
  argv: string[],
  opts?: SpawnPassthroughOptions,
): Promise<SpawnPassthroughResult>;
export function spawnPassthrough(
  argv: string[],
  opts: SpawnPassthroughOptions = {},
): Promise<SpawnPassthroughResult | SpawnGroupResult> {
  return runToCompletion(argv, opts, "inherit");
}

/**
 * {@link spawnPassthrough}, with the child's stdout AND stderr appended to one
 * file instead of inherited (`>> path 2>&1`): an owned kernel fd, so — like every
 * spawn here — there is no JS stream to wedge, and stdout/stderr keep their
 * interleaving in the file. The file is created when missing.
 *
 * For a child whose output is a RECORD — a run transcript a reader follows from
 * the file while it grows (supervised-job's attached runs). The parent's handle
 * on the descriptor is closed once the child holds its own.
 */
export async function spawnToFile(
  argv: string[],
  opts: SpawnToFileOptions,
): Promise<SpawnPassthroughResult> {
  const fd = await openOwnedFd(opts.outputPath, "a");
  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    fd.close();
  };
  try {
    // The child holds its own duplicate once spawned, so the parent's copy is
    // closed right then — a long run must not pin it in the parent too.
    return await runToCompletion(argv, opts, fd, close);
  } finally {
    // A spawn that threw before it returned leaves the fd to this close.
    close();
  }
}

async function runToCompletion(
  argv: string[],
  opts: SpawnPassthroughOptions,
  output: "inherit" | OwnedFd,
  afterSpawn?: () => void,
): Promise<SpawnPassthroughResult | SpawnGroupResult> {
  const ownGroup = opts.processGroup === "own";
  // The same two guarantees `spawnCaptured` gives: the child is SIGTERMed if
  // we exit first (live-children), and dies on its own if we are SIGKILLed and
  // it called `exitWithParent()` (the lifeline, in a dir private to this spawn).
  const dir = asAppPath(await mkdtemp(join(tmpdir(), "sg-spawn-")));
  try {
    const lifeline = await holdParentLifeline(dir);
    try {
      const proc = spawnAtTier(opts.tier ?? "inherit", argv, (tiered) =>
        Bun.spawn(tiered, {
          cwd: opts.cwd,
          env: childEnv(opts.env, lifeline),
          stdin: opts.stdin ?? "ignore",
          stdout: output === "inherit" ? output : output.fd,
          stderr: output === "inherit" ? output : output.fd,
          // A new process group led by the child (pgid = its pid).
          detached: ownGroup,
        }),
      );
      afterSpawn?.();
      // An own-group child takes its group with it when we exit first:
      // SIGKILL, because what it left in there is nobody's to wind down.
      const untrack = trackLiveChild(
        ownGroup ? { kill: () => killProcessGroup(proc.pid, "SIGKILL") } : proc,
      );
      let exitCode: number | null = null;
      try {
        opts.onSpawn?.({ pid: proc.pid, kill: (signal) => proc.kill(signal) });
        exitCode = await proc.exited;
      } finally {
        if (!ownGroup) untrack();
        // Never reaped (`onSpawn` threw): the group dies now, not at our exit.
        else if (exitCode === null) {
          killProcessGroup(proc.pid, "SIGKILL");
          untrack();
        }
        // Otherwise the exit reaper still covers the group until it is ended below.
      }
      const result: SpawnPassthroughResult = {
        exitCode,
        signalCode: signalName(proc.signalCode),
        resourceUsage: readResourceUsage(proc),
      };
      if (!ownGroup) return result;
      try {
        return { ...result, leftBehind: await endProcessGroup(proc.pid) };
      } finally {
        untrack();
      }
    } finally {
      lifeline.release();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
