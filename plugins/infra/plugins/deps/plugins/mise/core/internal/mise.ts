import { dirname } from "path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { miseBin } from "@plugins/toolchain/core";

/**
 * Runs `mise <args>` for the checkout at `root`, seeing ONLY that checkout's
 * config.
 *
 * `MISE_CEILING_PATHS` is load-bearing. A worktree lives inside the main
 * checkout (`<main>/.claude/worktrees/<wt>`), so mise also loads main's
 * `mise.toml` as a parent config — and `mise lock` run in a worktree rewrites
 * the PARENT's lock too, moving main's toolchain to whatever this worktree just
 * installed. Verified on mise 2026.4.28: a child `mise lock` changed the
 * parent's go from 1.24.13 to 1.27.1. The ceiling stops the walk at the
 * worktree's own directory.
 */
export async function mise(
  root: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  const argv = [await miseBin(), ...args];
  const result = await spawnCaptured(argv, {
    cwd: root,
    env: { ...process.env, MISE_CEILING_PATHS: dirname(root) },
    timeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `\`mise ${args.join(" ")}\` failed (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}):\n` +
        `${result.stdout}\n${result.stderr}`.trim(),
    );
  }
  return result.stdout;
}
