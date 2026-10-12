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
 * When the locked release is not installed — a lock that arrived by clone,
 * pull or upstream merge rather than through the updater on this machine — it
 * is installed first, with the REAL mise binary (`mise install bun@<locked>`),
 * never through a shim: a shim that installs then reshims can point every shim
 * at itself (research/2026-09-27-global-mise-shim-self-loop.md), which is why
 * shims are set never to install. Bun is the one tool the CLI cannot install
 * once it is running on the right one, because it is what the CLI runs on; the
 * rest of the toolchain is installed by `build` / `start`
 * (`installLockedToolchain`, infra/deps/mise).
 *
 * `bun-runtime` stays the guard: when no mise exists or the install fails, this
 * says so and runs on, so a build fails that check while commands that do not
 * care still work.
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
  /**
   * @internal TEST SEAM: installs `bun@<version>` and returns mise's exit code,
   * or null when there is no mise to install with.
   */
  install?: (version: string, root: string) => Promise<number | null>;
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

  const root = opts.root ?? process.cwd();
  const lockPath = join(root, "mise.lock");
  if (!existsSync(lockPath)) return { kind: "no-lock" };
  const locked = lockedBunVersion(readFileSync(lockPath, "utf8"));
  if (locked === null) return { kind: "no-lock" };

  const running = opts.running ?? Bun.version;
  if (running === locked) return { kind: "running-locked" };

  // Directly the locked install's binary, not the `bun` shim: the shim would
  // re-resolve from the cwd, and fail with mise's error if the release is
  // missing rather than letting this install it first.
  const shims = runtimeShimsDir(env);
  const lockedBin =
    shims === undefined
      ? undefined
      : join(dirname(shims), "installs", "bun", locked, "bin", "bun");
  if (lockedBin === undefined) {
    return {
      kind: "mismatch",
      locked,
      reason: `mise.lock records bun ${locked}, but this is ${running} and there is no mise data dir (HOME unset?). Continuing on ${running}.`,
    };
  }
  if (alreadyReexeced) {
    return {
      kind: "mismatch",
      locked,
      reason: `mise.lock records bun ${locked}, but this is ${running} even after re-exec'ing under ${lockedBin}. Continuing on ${running}.`,
    };
  }
  if (!existsSync(lockedBin)) {
    console.error(
      `singularity: installing bun ${locked}, the release mise.lock records…`,
    );
    const exit = await (opts.install ?? installBun)(locked, root);
    if (exit !== 0 || !existsSync(lockedBin)) {
      return {
        kind: "mismatch",
        locked,
        reason:
          (exit === null
            ? `mise.lock records bun ${locked}, but mise is not installed to install it`
            : `\`mise install bun@${locked}\` ${exit === 0 ? `left no ${lockedBin}` : `failed (exit ${exit})`}`) +
          `. Continuing on ${running}.`,
      };
    }
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

/**
 * The real mise binary — never a shim (see the module docblock): PATH, unless
 * that is mise's own shims dir, then the installer's default location. Same
 * lookup as `toolchain/core`'s `findMiseBin`, which this closure cannot import.
 */
function realMise(env: Record<string, string | undefined>): string | null {
  const onPath = Bun.which("mise", { PATH: env.PATH ?? "" });
  if (onPath !== null && !/\/mise\/shims\//.test(onPath)) return onPath;
  const installed = env.HOME ? join(env.HOME, ".local", "bin", "mise") : null;
  return installed !== null && existsSync(installed) ? installed : null;
}

async function installBun(
  version: string,
  root: string,
): Promise<number | null> {
  const bin = realMise(process.env);
  if (bin === null) return null;
  // Output passed through: an install is minutes on a slow link, and its
  // progress is the only sign this command is not hung. MISE_CEILING_PATHS keeps
  // a worktree from also loading main's mise.toml (see infra/deps/mise `mise()`).
  const { exitCode } = await spawnPassthrough(
    [bin, "install", `bun@${version}`],
    {
      cwd: root,
      env: { ...process.env, MISE_CEILING_PATHS: dirname(root) },
    },
  );
  return exitCode;
}
