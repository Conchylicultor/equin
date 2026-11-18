import { dirname } from "node:path";
import { LSOF, PS } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

/**
 * The socket a builtin fsmonitor daemon listens on, in its checkout's git dir
 * (`<common>/worktrees/<id>/` for a linked worktree). Its name is git's
 * (`fsmonitor_ipc__get_path`); the daemon's cookies sit beside it in
 * `fsmonitor--daemon/`.
 */
export const DAEMON_SOCKET = "fsmonitor--daemon.ipc";

const LIST_TIMEOUT_MS = 30_000;

/** One running `git fsmonitor--daemon`, and the git dir it serves. */
export interface FsmonitorDaemon {
  pid: number;
  /**
   * The git dir whose socket it listens on — null when its socket does not
   * name it (starting up, shutting down, or a path too long to bind whole):
   * such a daemon is left alone.
   */
  gitDir: string | null;
}

// `git fsmonitor--daemon run --detach …` — the daemon itself. `start`, `stop`
// and `status` are the short-lived clients and do not match.
const DAEMON_COMMAND = /(?:^|\/)git fsmonitor--daemon run(?:\s|$)/;

/**
 * macOS's scheduling priority of a darwinbg (`taskpolicy -b`) process, as `ps
 * -o pri` shows it (a normal one shows 20 and up — measured on this host,
 * 2026-11-18).
 */
const THROTTLED_PRI = 4;

/** A running daemon, as `ps` shows it. */
export interface RunningDaemon {
  /**
   * Started at background priority (darwinbg): a daemon inherits its
   * starter's tier, and a throttled one answers a busy machine's reads
   * slower than a full scan would (one read waited 28 s at load ~100,
   * against 1–9 s without fsmonitor). A git that auto-starts the daemon from
   * a background-tier process (an agent's own git, after a reboot) makes one.
   */
  throttled: boolean;
}

/** The daemons among `ps -axo pid=,pri=,command=` lines, by pid. */
export function parseRunningDaemons(
  psOutput: string,
): Map<number, RunningDaemon> {
  const out = new Map<number, RunningDaemon>();
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m && DAEMON_COMMAND.test(m[3]!)) {
      out.set(Number(m[1]), { throttled: Number(m[2]) <= THROTTLED_PRI });
    }
  }
  return out;
}

/**
 * Each pid's daemon socket from `lsof -a -U -p <pids> -Fpn` output (`p<pid>`
 * then its `n<name>` lines): the git dir is the socket's directory.
 */
export function parseDaemonSockets(lsofOutput: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid: number | null = null;
  for (const line of lsofOutput.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (
      line.startsWith("n") &&
      pid !== null &&
      line.endsWith(`/${DAEMON_SOCKET}`)
    ) {
      out.set(pid, dirname(line.slice(1)));
    }
  }
  return out;
}

/**
 * The pid of the daemon that issued an index's fsmonitor token
 * (`builtin:<n>.<pid>.<started>:<seq>`), or null for a token no builtin daemon
 * wrote (a hook's, or none).
 */
export function tokenDaemonPid(token: string | null): number | null {
  if (token === null) return null;
  const m = /^builtin:\d+\.(\d+)\./.exec(token);
  return m ? Number(m[1]) : null;
}

/** Every builtin fsmonitor daemon running on the machine, by pid (one `ps`). */
export async function listRunningDaemons(
  signal?: AbortSignal,
): Promise<ReadonlyMap<number, RunningDaemon>> {
  const ps = await spawnCaptured([PS, "-axo", "pid=,pri=,command="], {
    timeoutMs: LIST_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  if (ps.timedOut || ps.exitCode !== 0) {
    throw new Error(
      `[fsmonitor] ps failed (${ps.timedOut ? "timed out" : `exit ${ps.exitCode}`}): ${ps.stderr.trim()}`,
    );
  }
  return parseRunningDaemons(ps.stdout);
}

/**
 * Every builtin fsmonitor daemon running on the machine, each with the git dir
 * it serves when its socket names it: one `ps`, then one `lsof` over those pids
 * (~0.1 s; an `lsof` of one socket PATH scans every process, ~1 s). The
 * daemon's cwd is `$HOME`, so its socket is the only thing that says which
 * checkout it watches — and a socket path past the platform's limit (104
 * bytes on macOS) is bound by a relative name, so its git dir is `null`:
 * best-effort, for the orphan sweep only. Whether a checkout's index token is
 * current is decided from the pid alone (`tokenDaemonPid`).
 */
export async function listFsmonitorDaemons(
  signal?: AbortSignal,
): Promise<FsmonitorDaemon[]> {
  const pids = [...(await listRunningDaemons(signal)).keys()];
  if (pids.length === 0) return [];
  const lsof = await spawnCaptured(
    [LSOF, "-a", "-U", "-p", pids.join(","), "-Fpn"],
    { timeoutMs: LIST_TIMEOUT_MS, ...(signal ? { signal } : {}) },
  );
  // lsof exits 1 when one of the pids is gone by now (a daemon that stopped
  // between the two reads): that pid simply has no socket below.
  if (lsof.timedOut || (lsof.exitCode !== 0 && lsof.exitCode !== 1)) {
    throw new Error(
      `[fsmonitor] lsof failed (${lsof.timedOut ? "timed out" : `exit ${lsof.exitCode}`}): ${lsof.stderr.trim()}`,
    );
  }
  const sockets = parseDaemonSockets(lsof.stdout);
  return pids.map((pid) => ({ pid, gitDir: sockets.get(pid) ?? null }));
}
