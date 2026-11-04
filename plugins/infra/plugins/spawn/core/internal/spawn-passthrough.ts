import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdParentLifeline } from "@plugins/packages/plugins/flock/core";
import { spawnAtTier } from "@plugins/packages/plugins/spawn-priority/core";
import { childEnv } from "./child-env";
import { trackLiveChild } from "./live-children";
import { readResourceUsage } from "./resource-usage";
import { signalName } from "./signal-code";
import type {
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
  opts: SpawnPassthroughOptions = {},
): Promise<SpawnPassthroughResult> {
  return runToCompletion(argv, opts, "inherit");
}

/**
 * {@link spawnPassthrough}, with the child's stdout AND stderr appended to one
 * file instead of inherited (`>> path 2>&1`): a raw kernel fd, so — like every
 * spawn here — there is no JS stream to wedge, and stdout/stderr keep their
 * interleaving in the file. The file is created when missing.
 *
 * For a child whose output is a RECORD — a run transcript a reader follows from
 * the file while it grows (supervised-job's attached runs). The parent's copy
 * of the descriptor is closed once the child holds its own.
 */
export async function spawnToFile(
  argv: string[],
  opts: SpawnToFileOptions,
): Promise<SpawnPassthroughResult> {
  const fd = openSync(opts.outputPath, "a");
  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    closeSync(fd);
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
  output: "inherit" | number,
  afterSpawn?: () => void,
): Promise<SpawnPassthroughResult> {
  // The same two guarantees `spawnCaptured` gives: the child is SIGTERMed if
  // we exit first (live-children), and dies on its own if we are SIGKILLed and
  // it called `exitWithParent()` (the lifeline, in a dir private to this spawn).
  const dir = asAppPath(mkdtempSync(join(tmpdir(), "sg-spawn-")));
  try {
    const lifeline = holdParentLifeline(dir);
    try {
      const proc = spawnAtTier(opts.tier ?? "inherit", argv, (tiered) =>
        Bun.spawn(tiered, {
          cwd: opts.cwd,
          env: childEnv(opts.env, lifeline),
          stdin: opts.stdin ?? "ignore",
          stdout: output,
          stderr: output,
        }),
      );
      afterSpawn?.();
      const untrack = trackLiveChild(proc);
      try {
        opts.onSpawn?.({ pid: proc.pid, kill: (signal) => proc.kill(signal) });
        const exitCode = await proc.exited;
        return {
          exitCode,
          signalCode: signalName(proc.signalCode),
          resourceUsage: readResourceUsage(proc),
        };
      } finally {
        untrack();
      }
    } finally {
      lifeline.release();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
