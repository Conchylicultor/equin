import { join } from "node:path";
import { rm } from "node:fs/promises";
import { readFile, stat } from "@plugins/packages/plugins/timed-fs/core";
import { GIT } from "@plugins/infra/plugins/paths/server";
import {
  spawnCaptured,
  type SpawnResult,
} from "@plugins/infra/plugins/spawn/core";
import type { SpawnTier } from "@plugins/packages/plugins/spawn-priority/core";
import { readIndexFsmonitorToken } from "@plugins/infra/plugins/git/plugins/index-refresh/core";
import {
  refreshCheckoutIndex,
  type CheckoutTier,
} from "@plugins/infra/plugins/git/plugins/index-refresh/server";
import type { IndexPublish } from "@plugins/infra/plugins/git/plugins/private-index/core";
import {
  DAEMON_SOCKET,
  listFsmonitorDaemons,
  listRunningDaemons,
  tokenDaemonPid,
  type RunningDaemon,
} from "./daemons";

// Wedge-breakers, not latency bounds: each is a config write or a daemon's
// start / stop handshake (git waits for the daemon to answer).
const GIT_TIMEOUT_MS = 60_000;

async function git(
  wtPath: string,
  args: string[],
  tier: Exclude<SpawnTier, "inherit">,
  signal?: AbortSignal,
): Promise<SpawnResult> {
  const r = await spawnCaptured([GIT, "-C", wtPath, ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    tier,
    ...(signal ? { signal } : {}),
  });
  if (r.timedOut) {
    throw new Error(
      `[fsmonitor] git -C ${wtPath} ${args.join(" ")} did not finish within ${GIT_TIMEOUT_MS} ms`,
    );
  }
  return r;
}

function failed(wtPath: string, args: string[], r: SpawnResult): Error {
  return new Error(
    `[fsmonitor] git -C ${wtPath} ${args.join(" ")} failed (exit ${r.exitCode}): ${r.stderr.trim() || "<no stderr>"}`,
  );
}

/**
 * `extensions.worktreeConfig` on in the repo's shared config: what makes
 * `git config --worktree` write the checkout's own `config.worktree` — without
 * it, in a repo with several worktrees, the write is refused. Turned on once,
 * when off. git's one caveat (git-worktree(1)): a `core.bare = true` or a
 * `core.worktree` in the shared config would then apply to every worktree, so
 * such a repo is refused rather than changed.
 */
async function ensureWorktreeConfig(
  wtPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const get = async (key: string) => {
    const args = ["config", "--get", key];
    const r = await git(wtPath, args, "background", signal);
    // 1: the key is not set.
    if (r.exitCode !== 0 && r.exitCode !== 1) throw failed(wtPath, args, r);
    return r.exitCode === 0 ? r.stdout.trim() : null;
  };
  if ((await get("extensions.worktreeConfig")) === "true") return;
  const bare = await get("core.bare");
  const worktree = await get("core.worktree");
  if (bare === "true" || worktree !== null) {
    throw new Error(
      `[fsmonitor] cannot turn on extensions.worktreeConfig for ${wtPath}: the shared config sets ${bare === "true" ? "core.bare = true" : `core.worktree = ${worktree}`}, which would then apply to every worktree (git-worktree(1)); move it to the main worktree's config.worktree first`,
    );
  }
  const args = ["config", "extensions.worktreeConfig", "true"];
  const r = await git(wtPath, args, "background", signal);
  if (r.exitCode !== 0) throw failed(wtPath, args, r);
}

/**
 * The file holding the MAIN worktree's `core.fsmonitor`, in its git dir,
 * read through an `includeIf "gitdir:<its git dir>"` in the shared config —
 * never its `config.worktree`: `git worktree add` copies the main worktree's
 * `config.worktree` into every checkout it makes (git ≥ 2.36, measured), so a
 * plain add (Claude Code's own `agent-*` worktrees, a human's) would get a
 * daemon nobody owns. The include matches the main worktree's git dir only;
 * a linked checkout's is `<it>/worktrees/<id>`.
 */
const MAIN_FSMONITOR_CONFIG = "equin-fsmonitor.config";

/**
 * Where a checkout's `core.fsmonitor` is written, as `git config` options.
 * `use: "set"` also makes that place read (the repo's
 * `extensions.worktreeConfig`, main's include); an unset only removes.
 */
async function fsmonitorConfigScope(
  wtPath: string,
  use: "set" | "unset",
  signal?: AbortSignal,
): Promise<string[]> {
  const args = [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ];
  const r = await git(wtPath, args, "background", signal);
  if (r.exitCode !== 0) throw failed(wtPath, args, r);
  const [gitDir, commonDir] = r.stdout.trim().split("\n");
  if (gitDir === undefined || commonDir === undefined) {
    throw new Error(
      `[fsmonitor] git -C ${wtPath} ${args.join(" ")} printed ${JSON.stringify(r.stdout)}: expected two lines`,
    );
  }
  if (gitDir !== commonDir) {
    if (use === "set") await ensureWorktreeConfig(wtPath, signal);
    return ["--worktree"];
  }
  if (use === "set") await ensureMainInclude(wtPath, gitDir, signal);
  return ["--file", join(gitDir, MAIN_FSMONITOR_CONFIG)];
}

/** The shared config's include of {@link MAIN_FSMONITOR_CONFIG}, added once. */
async function ensureMainInclude(
  wtPath: string,
  gitDir: string,
  signal?: AbortSignal,
): Promise<void> {
  // A gitdir: pattern is a glob; this one must match exactly one path.
  if (/[*?[\\]/.test(gitDir)) {
    throw new Error(
      `[fsmonitor] cannot scope core.fsmonitor to the main worktree of ${wtPath}: its git dir ${gitDir} holds a glob character, which an includeIf "gitdir:" pattern would read as one`,
    );
  }
  const key = `includeIf.gitdir:${gitDir}.path`;
  const getArgs = ["config", "--local", "--get-all", key];
  const get = await git(wtPath, getArgs, "background", signal);
  // 1: the key is not set.
  if (get.exitCode !== 0 && get.exitCode !== 1) {
    throw failed(wtPath, getArgs, get);
  }
  if (get.stdout.split("\n").includes(MAIN_FSMONITOR_CONFIG)) return;
  const addArgs = ["config", "--local", "--add", key, MAIN_FSMONITOR_CONFIG];
  const add = await git(wtPath, addArgs, "background", signal);
  if (add.exitCode !== 0) throw failed(wtPath, addArgs, add);
}

/** What starting a checkout's fsmonitor found. */
export type FsmonitorStart = "started" | "running";

/**
 * Turn git's builtin fsmonitor on for one checkout: `core.fsmonitor=true` in
 * its own `config.worktree` — the main worktree's in
 * {@link MAIN_FSMONITOR_CONFIG} — (so every git in it — the agent's, our
 * reads, a build's tree scans — asks the daemon instead of stat-ing every
 * file), then start the daemon.
 *
 * The daemon is started at `foreground`, whoever asks: it inherits the tier
 * of the `start` that spawns it and lives on, and every read's cookie wait
 * goes through it. It leads no group of ours — `spawnCaptured`'s bounded
 * child leads a group of its own, which the daemon inherits — so a backend
 * restart (a signal to the backend's group) does not take it down.
 */
export async function startCheckoutFsmonitor(
  wtPath: string,
  signal?: AbortSignal,
): Promise<FsmonitorStart> {
  const scope = await fsmonitorConfigScope(wtPath, "set", signal);
  const setArgs = ["config", ...scope, "core.fsmonitor", "true"];
  const set = await git(wtPath, setArgs, "background", signal);
  if (set.exitCode !== 0) throw failed(wtPath, setArgs, set);
  const startArgs = ["fsmonitor--daemon", "start"];
  const start = await git(wtPath, startArgs, "foreground", signal);
  if (start.exitCode === 0) return "started";
  if (/already running/.test(start.stderr)) return "running";
  throw failed(wtPath, startArgs, start);
}

/** What stopping a checkout's fsmonitor found. */
export interface FsmonitorStop {
  config: "unset" | "absent";
  daemon: "stopped" | "not-running";
}

/**
 * Turn a checkout's fsmonitor off: unset `core.fsmonitor` FIRST (while it is
 * set, any git in the checkout would start the daemon again), then stop the
 * daemon. The index keeps its token; the next git that writes it drops it.
 */
export async function stopCheckoutFsmonitor(
  wtPath: string,
  signal?: AbortSignal,
): Promise<FsmonitorStop> {
  const scope = await fsmonitorConfigScope(wtPath, "unset", signal);
  const unsetArgs = ["config", ...scope, "--unset-all", "core.fsmonitor"];
  const unset = await git(wtPath, unsetArgs, "background", signal);
  // 5: the key was not set (or, for --file, the file does not exist).
  if (unset.exitCode !== 0 && unset.exitCode !== 5) {
    throw failed(wtPath, unsetArgs, unset);
  }
  const stopArgs = ["fsmonitor--daemon", "stop"];
  const stop = await git(wtPath, stopArgs, "background", signal);
  if (stop.exitCode !== 0 && !/not running/.test(stop.stderr)) {
    throw failed(wtPath, stopArgs, stop);
  }
  return {
    config: unset.exitCode === 0 ? "unset" : "absent",
    daemon: stop.exitCode === 0 ? "stopped" : "not-running",
  };
}

/** Whether the index's token is the running daemon's, or what renewing it did. */
export type FsmonitorToken =
  | { kind: "current" }
  | {
      kind: "renewed";
      /** The daemon pid the old token named (null: no builtin token). */
      was: number | null;
      publish: IndexPublish;
    };

// gitDir → the index's mtime and the daemon pid its token names: an index
// nobody rewrote since need not be read again (~4 MB each). A cache of a
// read, never of a verdict: whether that pid still runs is asked every time.
const tokenPids = new Map<string, { mtimeMs: number; pid: number | null }>();

/** The pid of the daemon that issued the index's token (null: none, or no index). */
async function indexTokenPid(gitDir: string): Promise<number | null> {
  const index = join(gitDir, "index");
  try {
    const { mtimeMs } = await stat(index);
    const seen = tokenPids.get(gitDir);
    if (seen?.mtimeMs === mtimeMs) return seen.pid;
    const pid = tokenDaemonPid(readIndexFsmonitorToken(await readFile(index)));
    tokenPids.set(gitDir, { mtimeMs, pid });
    return pid;
  } catch (err) {
    // No index yet: nothing to vouch for, the refresh writes one.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function gitDirOf(wtPath: string, signal?: AbortSignal): Promise<string> {
  const args = ["rev-parse", "--path-format=absolute", "--git-dir"];
  const r = await git(wtPath, args, "background", signal);
  if (r.exitCode !== 0) throw failed(wtPath, args, r);
  return r.stdout.trim();
}

/** Stop the checkout's daemon, leaving its config on (a restart follows). */
async function stopDaemon(wtPath: string, signal?: AbortSignal): Promise<void> {
  const args = ["fsmonitor--daemon", "stop"];
  const r = await git(wtPath, args, "background", signal);
  if (r.exitCode !== 0 && !/not running/.test(r.stderr)) {
    throw failed(wtPath, args, r);
  }
}

/**
 * Whether the checkout's daemon answers its index's token with what changed
 * since — or with "everything" (git's trivial response: the token is not one
 * it issued, a full scan for every read). Asked the way every read asks: one
 * `git diff-files --quiet`, read-only, whose trace2 says
 * `query/trivial-response:1` when it got the trivial answer (measured, git
 * 2.50.1). With a current token it costs the paths that changed, not the
 * checkout.
 */
async function daemonAnswersToken(
  wtPath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  // Never an inherited GIT_INDEX_FILE or trace target: the checkout's own
  // index, traced to this child's stderr.
  const {
    GIT_INDEX_FILE: _index,
    GIT_TRACE2: _t2,
    GIT_TRACE2_EVENT: _t2e,
    ...env
  } = process.env;
  const argv = [GIT, "-C", wtPath, "diff-files", "--quiet"];
  const r = await spawnCaptured(argv, {
    env: { ...env, GIT_TRACE2_PERF: "1" },
    timeoutMs: GIT_TIMEOUT_MS,
    tier: "background",
    ...(signal ? { signal } : {}),
  });
  if (r.timedOut) {
    throw new Error(
      `[fsmonitor] ${argv.join(" ")} did not finish within ${GIT_TIMEOUT_MS} ms`,
    );
  }
  // 1: the tree differs from the index — an answer like 0.
  if (r.exitCode !== 0 && r.exitCode !== 1) {
    throw failed(wtPath, ["diff-files", "--quiet"], r);
  }
  if (!/fsm_client.*query\/response-length/.test(r.stderr)) {
    throw new Error(
      `[fsmonitor] ${argv.join(" ")} did not ask its fsmonitor (no fsm_client query in its trace) — is core.fsmonitor on?`,
    );
  }
  return !/query\/trivial-response:1/.test(r.stderr);
}

/** What {@link ensureCheckoutFsmonitor} found and did. */
export interface FsmonitorEnsure {
  /**
   * `restarted`: the daemon ran throttled (started from a background-tier
   * process — see `RunningDaemon.throttled`) and was started again at
   * foreground.
   */
  daemon: FsmonitorStart | "restarted";
  token: FsmonitorToken;
}

/**
 * Converge one checkout that should run an fsmonitor:
 *
 * - **configured, and its index's token names a running, unthrottled daemon**
 *   — nothing to do, no spawn to find that out;
 * - otherwise start it (a no-op when it runs) and renew the token: git stores
 *   the daemon's token in the index (`FSMN`) and asks "what changed since
 *   it?"; a token of a daemon that is gone (a restart, a reboot, a crash) is
 *   answered "everything" — a full scan — and since no read of ours writes the
 *   index (`GIT_OPTIONAL_LOCKS=0`), EVERY read pays it until something
 *   rewrites the index. The renewal is `refreshCheckoutIndex`: a private copy,
 *   whose `git status` runs with the checkout's fsmonitor on and so records
 *   the running daemon's token, published by compare-and-swap — safe beside
 *   an agent working in the checkout.
 * - a THROTTLED daemon (one git auto-started from a background-tier process)
 *   is restarted at foreground, then the token renewed. The token names the
 *   daemon's pid, so once renewed it says which process this checkout's
 *   daemon is; one found throttled only then (its token was stale) is
 *   restarted once more — the restart is ours, at foreground, so it ends
 *   there.
 */
async function convergeOn(
  wtPath: string,
  gitDir: string,
  live: ReadonlyMap<number, RunningDaemon>,
  tier: CheckoutTier,
  signal?: AbortSignal,
): Promise<FsmonitorEnsure | null> {
  const tokenDaemon = async (running: ReadonlyMap<number, RunningDaemon>) => {
    const pid = await indexTokenPid(gitDir);
    return pid === null ? undefined : running.get(pid);
  };
  const before = await tokenDaemon(live);
  if (
    before !== undefined &&
    !before.throttled &&
    (await mayHaveFsmonitorConfig(gitDir))
  ) {
    // Its daemon runs — but a daemon that resynced (FSEvents dropped events)
    // issued a new token under the same pid, so ask the daemon itself.
    if (await daemonAnswersToken(wtPath, signal)) return null;
    const was = await indexTokenPid(gitDir);
    return {
      daemon: "running",
      token: {
        kind: "renewed",
        was,
        publish: await refreshCheckoutIndex(wtPath, tier, signal),
      },
    };
  }
  let daemon: FsmonitorEnsure["daemon"];
  if (before?.throttled) {
    await stopDaemon(wtPath, signal);
    await startCheckoutFsmonitor(wtPath, signal);
    daemon = "restarted";
  } else {
    daemon = await startCheckoutFsmonitor(wtPath, signal);
  }
  const was = await indexTokenPid(gitDir);
  let publish = await refreshCheckoutIndex(wtPath, tier, signal);
  if ((await tokenDaemon(await listRunningDaemons(signal)))?.throttled) {
    await stopDaemon(wtPath, signal);
    await startCheckoutFsmonitor(wtPath, signal);
    daemon = "restarted";
    publish = await refreshCheckoutIndex(wtPath, tier, signal);
  }
  return { daemon, token: { kind: "renewed", was, publish } };
}

/**
 * Turn a checkout's fsmonitor on and make it current, for a checkout that may
 * already have been used (a resumed attempt's): started if it is not running,
 * restarted if it runs throttled, its index token renewed if no running
 * daemon issued it.
 */
export async function ensureCheckoutFsmonitor(
  wtPath: string,
  tier: CheckoutTier,
  signal?: AbortSignal,
): Promise<FsmonitorEnsure> {
  const gitDir = await gitDirOf(wtPath, signal);
  return (
    (await convergeOn(
      wtPath,
      gitDir,
      await listRunningDaemons(signal),
      tier,
      signal,
    )) ?? { daemon: "running", token: { kind: "current" } }
  );
}

// A candidate check, never a verdict: it decides whether a stop is worth its
// two spawns (or a start skipped). The config write and the stop are
// idempotent.
async function mayHaveFsmonitorConfig(gitDir: string): Promise<boolean> {
  for (const file of ["config.worktree", MAIN_FSMONITOR_CONFIG]) {
    try {
      if (/fsmonitor/i.test(await readFile(join(gitDir, file), "utf8"))) {
        return true;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return false;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Whether a checkout should run an fsmonitor; `unknown` is left as it is. */
export type FsmonitorWant = "on" | "off" | "unknown";

export interface FsmonitorCheckout {
  /** The checkout's root. */
  path: string;
  /** Its git dir (`<common>/worktrees/<id>` for a linked worktree). */
  gitDir: string;
  want: FsmonitorWant;
}

/** What one reconcile pass did. */
export interface FsmonitorReconcile {
  /** Checkouts wanted on (each now configured, with a daemon). */
  on: number;
  /** Started, or restarted from a throttled daemon. */
  started: string[];
  renewed: string[];
  stopped: string[];
  /** Daemons of a git dir that no longer exists, signalled. */
  orphans: number[];
  failures: { path: string; error: string }[];
}

/**
 * Converge the machine's fsmonitor daemons on what the caller wants: every
 * `on` checkout configured, its daemon running and its index token current;
 * every `off` one unconfigured and its daemon stopped; and every daemon whose
 * git dir under `orphanRoot` is gone (a checkout removed under it) signalled.
 * A daemon of a git dir the caller did not name but that still exists is left
 * alone — a checkout made after the caller listed them, or not ours.
 *
 * Per checkout, a failure is collected and the pass goes on; the caller
 * decides how loud the list is.
 */
export async function reconcileCheckoutFsmonitors(
  checkouts: readonly FsmonitorCheckout[],
  opts: {
    orphanRoot: string;
    tier: CheckoutTier;
    /**
     * Asked again just before an `off` checkout is stopped: its owner may
     * have taken it back since the caller decided (a resume ensures its
     * fsmonitor). False leaves it running.
     */
    stillOff: (c: FsmonitorCheckout) => Promise<boolean>;
    signal?: AbortSignal;
  },
): Promise<FsmonitorReconcile> {
  const { orphanRoot, tier, stillOff, signal } = opts;
  let live = await listRunningDaemons(signal);
  const out: FsmonitorReconcile = {
    on: 0,
    started: [],
    renewed: [],
    stopped: [],
    orphans: [],
    failures: [],
  };
  for (const c of checkouts) {
    signal?.throwIfAborted();
    try {
      if (c.want === "on") {
        out.on++;
        const done = await convergeOn(c.path, c.gitDir, live, tier, signal);
        if (done !== null) {
          if (done.daemon !== "running") out.started.push(c.path);
          if (done.token.kind === "renewed") out.renewed.push(c.path);
          live = await listRunningDaemons(signal);
        }
      } else if (c.want === "off") {
        const socket = join(c.gitDir, DAEMON_SOCKET);
        if (
          (await exists(socket)) ||
          (await mayHaveFsmonitorConfig(c.gitDir))
        ) {
          if (!(await stillOff(c))) continue;
          const stop = await stopCheckoutFsmonitor(c.path, signal);
          // A socket no daemon listens on (one killed outright): git leaves
          // it, and it would make this checkout a candidate every pass.
          if (stop.daemon === "not-running") await rm(socket, { force: true });
          out.stopped.push(c.path);
        }
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      out.failures.push({
        path: c.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Best-effort backstop: a daemon also exits by itself once its checkout's
  // directory is deleted (measured), so this only catches one whose checkout
  // was moved away (the reap renames it into the trash) and its registration
  // pruned. A daemon whose socket does not name its git dir is left alone.
  const named = new Set(checkouts.map((c) => c.gitDir));
  for (const d of await listFsmonitorDaemons(signal)) {
    if (d.gitDir === null || named.has(d.gitDir)) continue;
    if (!d.gitDir.startsWith(`${orphanRoot}/`)) continue;
    // The admin dir's `gitdir` file goes with its registration (a prune).
    if (await exists(join(d.gitDir, "gitdir"))) continue;
    try {
      process.kill(d.pid, "SIGTERM");
      out.orphans.push(d.pid);
    } catch (err) {
      // Exited between the listing and the signal.
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
  }
  return out;
}

/** One line for a log. */
export function describeFsmonitorReconcile(r: FsmonitorReconcile): string {
  const names = (paths: string[]) =>
    paths.map((p) => p.slice(p.lastIndexOf("/") + 1)).join(", ");
  return [
    `${r.on} on`,
    `started ${r.started.length}${r.started.length ? ` (${names(r.started)})` : ""}`,
    `token renewed ${r.renewed.length}${r.renewed.length ? ` (${names(r.renewed)})` : ""}`,
    `stopped ${r.stopped.length}${r.stopped.length ? ` (${names(r.stopped)})` : ""}`,
    `orphans signalled ${r.orphans.length}`,
    `failures ${r.failures.length}`,
  ].join("; ");
}
