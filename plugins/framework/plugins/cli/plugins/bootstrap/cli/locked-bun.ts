/**
 * `reexecUnderLockedBun()` — run every `./singularity` command under the Bun
 * `mise.lock` records, whatever Bun the caller's PATH happened to start it on.
 *
 * THE BUG THIS EXISTS FOR (main, 2026-10-12). A deps upgrade moved `mise.lock`
 * from bun 1.4.2 to 1.4.3 and landed on main. Main's backend had booted on
 * 1.4.2, and the mise shim that launched it had put
 * `…/mise/installs/bun/1.4.2/bin` at the front of its PATH. The auto-build it
 * spawned inherited that PATH, so `./singularity build` ran on 1.4.2, the
 * `bun-runtime` check refused it — and the build it refused was the one that
 * would have restarted the backend onto 1.4.3. Nothing could get main out of it
 * but a person.
 *
 * Which Bun a command runs on is a fact about the CALLER (a shell activated last
 * week, a tmux session, a long-lived backend), while which Bun it SHOULD run on
 * is a fact about the checkout. This makes the checkout's answer win: when the
 * running Bun is not the one the cwd's `mise.lock` records (the wrapper `cd`s to
 * the checkout root), hand the command to mise's install of that release and
 * exit with its status.
 *
 * `bun-runtime` stays the guard: when the locked release is not installed, this
 * says so and runs on, so a build fails that check with its `mise install` hint
 * while commands that do not care still work.
 *
 * Same import constraint as the rest of the bootstrap: node builtins and
 * package-free `@plugins/*` cores only. The lock is read with a small local
 * scanner rather than `toolchain/core`'s `parseMiseLock`, whose barrel reaches
 * `paths/core` and the whole data-dir registry.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  runtimePath,
  runtimeShimsDir,
} from "@plugins/infra/plugins/launcher/core";
import { spawnPassthrough } from "@plugins/infra/plugins/spawn/core";

/**
 * Present ⇒ this process IS the locked-Bun re-exec of its parent. Taken (read
 * and removed) before anything spawns, like the deps re-exec budget, so a
 * descendant `./singularity` is judged on its own.
 */
export const LOCKED_BUN_REEXEC_ENV = "SINGULARITY_LOCKED_BUN_REEXEC";

/** The one exact bun release `mise.lock` records, or null when it does not. */
export function lockedBunVersion(lockText: string): string | null {
  const versions: string[] = [];
  let inBun = false;
  for (const line of lockText.split("\n")) {
    if (line.startsWith("[")) {
      inBun = /^\[\[tools\.bun\]\]\s*$/.test(line);
      continue;
    }
    const version = inBun ? /^version\s*=\s*"([^"]*)"/.exec(line)?.[1] : null;
    if (version) versions.push(version);
  }
  const [only] = versions;
  return versions.length === 1 &&
    only !== undefined &&
    /^\d+\.\d+\.\d+$/.test(only)
    ? only
    : null;
}

export type LockedBunOutcome =
  | { kind: "running-locked" }
  /** No checkout lock to honour (no `mise.lock`, or no single exact bun in it). */
  | { kind: "no-lock" }
  | { kind: "reexeced"; exitCode: number }
  | { kind: "mismatch"; locked: string; reason: string };

export interface LockedBunOptions {
  /**
   * Directory whose `mise.lock` decides. Defaults to the cwd — the wrapper `cd`s
   * to the checkout root, and the cwd is also what the shim resolves from, so
   * the lock read here is the lock the re-exec'd process gets.
   */
  root?: string;
  /** Defaults to `process.argv.slice(2)`. */
  args?: string[];
  /** Defaults to `process.env`; the marker is taken out of it. */
  env?: Record<string, string | undefined>;
  /** Defaults to `Bun.version`. */
  running?: string;
  /** @internal TEST SEAM, mirrors `reexecAfterInstall`'s. */
  spawn?: (
    argv: string[],
    env: Record<string, string | undefined>,
  ) => Promise<{ exitCode: number }>;
}

export async function reexecUnderLockedBun(
  entry: string,
  opts: LockedBunOptions = {},
): Promise<LockedBunOutcome> {
  const env = opts.env ?? process.env;
  const alreadyReexeced = env[LOCKED_BUN_REEXEC_ENV] !== undefined;
  delete env[LOCKED_BUN_REEXEC_ENV];

  const lockPath = join(opts.root ?? process.cwd(), "mise.lock");
  if (!existsSync(lockPath)) return { kind: "no-lock" };
  const locked = lockedBunVersion(readFileSync(lockPath, "utf8"));
  if (locked === null) return { kind: "no-lock" };

  const running = opts.running ?? Bun.version;
  if (running === locked) return { kind: "running-locked" };

  // Directly the locked install's binary, not the `bun` shim: shims never
  // install (`mise.toml`), so a shim asked for a release that is missing fails
  // every command with mise's error — including the `mise install`-free
  // commands that would still work on the running Bun. Missing ⇒ run on, and
  // let `bun-runtime` fail a build with its `mise install` hint.
  const shims = runtimeShimsDir(env);
  const lockedBin =
    shims === undefined
      ? undefined
      : join(dirname(shims), "installs", "bun", locked, "bin", "bun");
  if (alreadyReexeced || lockedBin === undefined || !existsSync(lockedBin)) {
    return {
      kind: "mismatch",
      locked,
      reason:
        `mise.lock records bun ${locked}, but this is ${running}` +
        (alreadyReexeced
          ? ` even after re-exec'ing under ${lockedBin ?? "it"}`
          : ` and ${lockedBin ?? `mise's install of ${locked}`} does not exist — run \`mise install\``) +
        `. Continuing on ${running}.`,
    };
  }

  const spawn =
    opts.spawn ??
    ((argv, childEnv) =>
      spawnPassthrough(argv, { env: childEnv, stdin: "inherit" }));
  const { exitCode } = await spawn(
    [lockedBin, entry, ...(opts.args ?? process.argv.slice(2))],
    {
      ...env,
      // The shims first, so the re-exec'd command's own `bun` children resolve
      // the lock too rather than the caller's pinned install dir.
      PATH: runtimePath(env),
      [LOCKED_BUN_REEXEC_ENV]: "1",
    },
  );
  return { kind: "reexeced", exitCode };
}
