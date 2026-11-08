/**
 * Who holds a daemon's pidfile — judged by the pid the file names, never by a
 * probe that can merely be slow.
 *
 * A start script that reads "pidfile present but the socket did not answer in
 * 1.5 s" as "crashed" deletes the lock file of a daemon that was only slow —
 * and Postgres shuts itself down when its lock file disappears. A dial, a
 * query, a ping: each can fail for a live daemon (host load, a full accept
 * backlog, a socket file unlinked). The pid in the file cannot: the kernel
 * either has that process or not. So "stale" here needs positive evidence,
 * and anything ambiguous is refused, never resolved by deleting:
 *
 * - live: a process of this user running the daemon's executable with the
 *   daemon's marker (its data dir, its config file) as a whole argument —
 *   judged on identity alone, so no clock can turn it stale;
 * - stale: no such process; another user's (the daemon runs as this user); or
 *   one of ours that is not the daemon and started after the file was last
 *   written, so it cannot be the file's writer (the pid reused after a crash);
 * - foreign: one of ours, not the daemon, running since before the file was
 *   written — nothing proves it is not a daemon started some other way;
 * - unreadable: no pid on the first line (empty, or being written right now).
 *
 * Pure: the caller reads the file and runs the probe (`psProbeArgv` /
 * `readPsProbe` are that probe's call and its reading), so this stays
 * portable and testable.
 */

/** What `ps` says about one pid. */
export type ProcessSnapshot =
  | { kind: "gone" }
  | {
      kind: "running";
      uid: number;
      /** When it started, epoch ms (whole seconds: `ps` reports elapsed time to the second). */
      startedAtMs: number;
      args: string;
    };

export type PidFileHolder =
  /** No pidfile. */
  | { kind: "absent" }
  /** The daemon itself is running. */
  | { kind: "live"; pid: number }
  /** Provably not the daemon: safe to remove. */
  | { kind: "stale"; pid: number; why: string }
  /** A live process of this user that may be the daemon started some other way: never removed. */
  | { kind: "foreign"; pid: number; args: string }
  /** The file names no pid: never removed. */
  | { kind: "unreadable"; text: string };

/** A pidfile as read: its text and when it was last written. */
export interface PidFileRead {
  text: string;
  mtimeMs: number;
}

export interface JudgePidFileOptions {
  /** The uid the daemon runs as — the start script's own (it starts the daemon as itself). */
  uid: number;
  /** The daemon's executable name (`postgres`, `pgbouncer`): its command line starts with a path ending in it. */
  executable: string;
  /**
   * A string the daemon's own command line carries as one whole argument and an
   * unrelated process's does not: Postgres's data dir (`-D <dir>`), PgBouncer's
   * config file.
   */
  argvMarker: string;
  probe: (pid: number) => ProcessSnapshot;
}

/**
 * How far a process's start may sit after the file's mtime and still be its
 * writer: `ps` rounds elapsed time down to the second, and the probe reads the
 * clock a moment after `ps` did.
 */
const START_SLACK_MS = 2_000;

/** The pid on a pidfile's first line (Postgres's lock file and PgBouncer's pidfile both start with it). */
function pidOf(text: string): number | null {
  const first = text.split("\n", 1)[0]?.trim() ?? "";
  if (!/^\d+$/.test(first)) return null;
  const pid = Number(first);
  return pid > 0 ? pid : null;
}

function isDaemon(args: string, opts: JudgePidFileOptions): boolean {
  const padded = ` ${args} `;
  const runsExecutable =
    args.startsWith(`${opts.executable} `) ||
    args === opts.executable ||
    padded.includes(`/${opts.executable} `);
  return runsExecutable && padded.includes(` ${opts.argvMarker} `);
}

/** Judge a pidfile's holder (`null`: there is no file). */
export function judgePidFile(
  file: PidFileRead | null,
  opts: JudgePidFileOptions,
): PidFileHolder {
  if (file === null) return { kind: "absent" };
  const pid = pidOf(file.text);
  if (pid === null) return { kind: "unreadable", text: file.text };
  const proc = opts.probe(pid);
  if (proc.kind === "gone")
    return { kind: "stale", pid, why: `no process ${pid}` };
  if (proc.uid !== opts.uid)
    return {
      kind: "stale",
      pid,
      why: `process ${pid} belongs to uid ${proc.uid}, not the daemon's uid ${opts.uid}`,
    };
  if (isDaemon(proc.args, opts)) return { kind: "live", pid };
  if (proc.startedAtMs > file.mtimeMs + START_SLACK_MS)
    return {
      kind: "stale",
      pid,
      why: `process ${pid} (${proc.args}) started ${new Date(proc.startedAtMs).toISOString()}, after the file was written (${new Date(file.mtimeMs).toISOString()})`,
    };
  return { kind: "foreign", pid, args: proc.args };
}

/**
 * The `ps` call that answers the probe for one pid: its uid, elapsed time and
 * full command line (`-ww`: never cut to a terminal's width, so the marker is
 * never cut off). The same flags on macOS and Linux (procps).
 */
export function psProbeArgv(pid: number): string[] {
  return [
    "ps",
    "-ww",
    "-p",
    String(pid),
    "-o",
    "uid=",
    "-o",
    "etime=",
    "-o",
    "args=",
  ];
}

/** What running {@link psProbeArgv} gave back. */
export interface PsResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** `ps`'s elapsed time, `[[dd-]hh:]mm:ss`, in seconds; null when it is not that. */
function elapsedSeconds(etime: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return (
    ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(min)) * 60 + Number(s)
  );
}

/**
 * Read a {@link psProbeArgv} run made at `nowMs`. `gone` only from what `ps`
 * says for a pid it has no process for — exit 1 with nothing on stdout or
 * stderr; any other outcome (killed, an error message, output it cannot read)
 * throws, since a probe that failed has proven nothing.
 */
export function readPsProbe(
  pid: number,
  ps: PsResult,
  nowMs: number,
): ProcessSnapshot {
  const out = ps.stdout.trim();
  if (ps.status === 1 && out === "" && ps.stderr.trim() === "")
    return { kind: "gone" };
  const m = /^(\d+)\s+(\S+)\s+(.*)$/s.exec(out);
  const elapsed = m ? elapsedSeconds(m[2]!) : null;
  if (ps.status === 0 && m && elapsed !== null)
    return {
      kind: "running",
      uid: Number(m[1]),
      startedAtMs: nowMs - elapsed * 1000,
      args: m[3]!,
    };
  throw new Error(
    `ps could not say whether process ${pid} runs (exit ${ps.status}): ${ps.stderr.trim() || out || "no output"}`,
  );
}
