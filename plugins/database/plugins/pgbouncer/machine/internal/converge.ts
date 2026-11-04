import { rename, writeFile } from "node:fs/promises";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { pgbouncerConfigFiles } from "../../server";
import {
  PGBOUNCER_CONFIG_FILE,
  PGBOUNCER_PID_FILE,
  PGBOUNCER_USERLIST_FILE,
} from "../../shared";

export type PgbouncerConvergence =
  /** The files on disk already were the rendered config. */
  | { kind: "current" }
  /** No running PgBouncer was found to tell (the files were rewritten if they differed). */
  | { kind: "written" }
  /** The running daemon was sent SIGHUP (its config reload). */
  | { kind: "reloaded"; pid: number };

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// Write-then-rename, so a concurrent reader (PgBouncer reloading, another
// backend comparing) never sees a half-written file.
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

/**
 * Make the PgBouncer config on disk the rendered one and, when that changed it,
 * have the running daemon reload it.
 *
 * Called by the host singleton's database driver at boot (main in dev): the
 * config is machine-wide, so a worktree's code never writes it. The gateway
 * re-runs PgBouncer's start script (which writes the config before spawning the
 * daemon) only when the gateway itself starts, and a reattached daemon keeps
 * the config of its own start — so without this, a deploy that changes the lane
 * table would leave the running daemon on the old config: for a new lane,
 * refusing that lane's user. Against a converged daemon this is two reads.
 *
 * The reload is asynchronous in PgBouncer (handled on its event loop); a caller
 * that needs the new config in effect confirms it by logging in.
 */
export async function convergePgbouncerConfig(opts: {
  /**
   * `if-changed`: signal only when the files were rewritten. `always`: signal
   * even when they already were current — for a daemon known to run an older
   * config (the files were written, the signal never sent).
   */
  reload: "if-changed" | "always";
}): Promise<PgbouncerConvergence> {
  const { ini, userlist } = pgbouncerConfigFiles();
  const [onDiskIni, onDiskUserlist] = await Promise.all([
    readOrNull(PGBOUNCER_CONFIG_FILE),
    readOrNull(PGBOUNCER_USERLIST_FILE),
  ]);
  const current = onDiskIni === ini && onDiskUserlist === userlist;
  if (current && opts.reload === "if-changed") return { kind: "current" };
  if (!current) {
    // The userlist first: a reload that sees the new ini sees its users too.
    await writeAtomic(PGBOUNCER_USERLIST_FILE, userlist);
    await writeAtomic(PGBOUNCER_CONFIG_FILE, ini);
  }
  const pidText = await readOrNull(PGBOUNCER_PID_FILE);
  if (pidText === null) return { kind: "written" };
  const pid = Number(pidText.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      `pgbouncer: pidfile ${PGBOUNCER_PID_FILE} holds no pid (${JSON.stringify(pidText)})`,
    );
  }
  // A pidfile a crashed daemon left behind can name a reused pid: signal only a
  // process that is PgBouncer. A stale pidfile is the start script's to clear
  // (the gateway's watchdog re-runs it, and it writes the config afresh).
  if (!(await isPgbouncer(pid))) return { kind: "written" };
  process.kill(pid, "SIGHUP");
  return { kind: "reloaded", pid };
}

async function isPgbouncer(pid: number): Promise<boolean> {
  const ps = await spawnCaptured(["ps", "-p", String(pid), "-o", "comm="], {
    timeoutMs: 10_000,
  });
  // `ps` exits 1 when no such process exists.
  if (ps.exitCode === 1) return false;
  if (ps.exitCode !== 0) {
    throw new Error(
      `pgbouncer: \`ps -p ${pid}\` failed (exit ${ps.exitCode}): ${ps.stderr}`,
    );
  }
  return ps.stdout.trim().endsWith("pgbouncer");
}
