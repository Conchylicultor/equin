import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdParentLifeline } from "@plugins/packages/plugins/flock/core";
import { spawnAtTier } from "@plugins/packages/plugins/spawn-priority/core";
import { childEnv } from "./child-env";
import { trackLiveChild } from "./live-children";
import { readResourceUsage } from "./resource-usage";
import type { SpawnPassthroughOptions, SpawnPassthroughResult } from "./types";

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
export async function spawnPassthrough(
  argv: string[],
  opts: SpawnPassthroughOptions = {},
): Promise<SpawnPassthroughResult> {
  // The same two guarantees `spawnCaptured` gives: the child is SIGTERMed if
  // we exit first (live-children), and dies on its own if we are SIGKILLed and
  // it called `exitWithParent()` (the lifeline, in a dir private to this spawn).
  const dir = mkdtempSync(join(tmpdir(), "sg-spawn-"));
  try {
    const lifeline = holdParentLifeline(dir);
    try {
      const proc = spawnAtTier(opts.tier ?? "inherit", argv, (tiered) =>
        Bun.spawn(tiered, {
          cwd: opts.cwd,
          env: childEnv(opts.env, lifeline),
          stdin: opts.stdin ?? "ignore",
          stdout: "inherit",
          stderr: "inherit",
        }),
      );
      const untrack = trackLiveChild(proc);
      try {
        opts.onSpawn?.({ pid: proc.pid, kill: (signal) => proc.kill(signal) });
        const exitCode = await proc.exited;
        return {
          exitCode,
          signalCode: proc.signalCode,
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
