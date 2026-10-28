import { join } from "node:path";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { envEntries } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

/**
 * A cold `bun install` of this repo plus its postinstall provisions. Like the
 * git bounds in `worktree.ts`, a wedge-breaker, not latency police: the install
 * is network-bound (10–25 s on an idle box) and a spare's runs on a saturated
 * one, so the bound sits far above it. A kill here is not destructive — the
 * checkout's own `.install.lock` and stamp make the retry a plain re-install.
 */
const INSTALL_TIMEOUT_MS = 20 * 60_000;

/** How much of install's output the thrown error carries: its tail, where bun's error is. */
const OUTPUT_TAIL_CHARS = 8000;

/**
 * Install the checkout at `path`: run ITS OWN CLI, `<path>/equin install`. Every checkout is installed before anything runs in it, so
 * its first guard hook or script never resolves npm packages by walking up into
 * main's `node_modules`.
 *
 * The checkout's own CLI rather than `ensureDeps` in-process: `server` may not
 * import `cli`, and the checkout's copy is the install code and the lock that
 * belong to it (one chokepoint — stamp, `.install.lock`, freshness skip).
 *
 * `frozen` (EQUIN_FROZEN_LOCKFILE, read by the bootstrap before argv) for a
 * checkout of committed code — a fresh add or a claimed spare — so creation
 * never rewrites `bun.lock`. NOT for an existing checkout: its `package.json`s
 * are the agent's work in progress, and a dependency it added but has not
 * locked yet must not stop its conversation from relaunching. Throws with install's captured output on failure; the
 * caller's launch or refill fails with it.
 */
export async function installCheckout(
  path: string,
  opts: { frozen: boolean },
  signal?: AbortSignal,
): Promise<void> {
  const argv = [join(path, CLI_NAME), "install"];
  // Demoted like the checkout itself: background work relative to the
  // interactive backends.
  const r = await spawnCaptured(argv, {
    cwd: path,
    env: opts.frozen
      ? { ...process.env, ...envEntries({ FROZEN_LOCKFILE: "1" }) }
      : process.env,
    tier: "background",
    mergeStderr: true,
    timeoutMs: INSTALL_TIMEOUT_MS,
    signal,
  });
  if (r.timedOut || r.exitCode !== 0) {
    const how = r.timedOut
      ? `did not finish within ${INSTALL_TIMEOUT_MS} ms and was killed`
      : r.signalCode
        ? `was killed by ${r.signalCode}`
        : `exited ${r.exitCode}`;
    const out = r.stdout.trim();
    const tail =
      out.length > OUTPUT_TAIL_CHARS
        ? `…${out.slice(-OUTPUT_TAIL_CHARS)}`
        : out || "<no output>";
    throw new Error(
      `${argv.join(" ")} ${how}; the checkout is not installed:\n${tail}`,
    );
  }
}
