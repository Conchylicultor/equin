import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readdirSync } from "@plugins/packages/plugins/timed-fs/core";

/**
 * The scratch root a test run hands its runners as `TMPDIR`: every dir a test
 * makes through `os.tmpdir()` — a fixture's `mkdtemp`, a spawn's capture dir,
 * whatever code under test does — lands inside it, and it is removed when the
 * run ends. So a fixture's scratch dir lives exactly as long as the run that
 * made it, with nothing for the fixture to remember: a suite that forgets its
 * `afterAll`, or a runner killed mid-file, can no longer leave a dir behind in
 * `/tmp` (~1,500 had piled up by 2026-11-05, one batch per run per worktree).
 *
 * The parent is fixed and each run's root is named `<pid>-<random>`, so a run
 * whose CLI died before its `finally` (SIGKILL, a crash) is reclaimed by the
 * next run's sweep: a root whose pid is gone has no one left to use it.
 */
const PARENT = join(tmpdir(), "equin-test-tmp");

export async function withRunTmpdir<T>(
  body: (dir: string) => Promise<T>,
): Promise<T> {
  sweepDeadRuns();
  mkdirSync(PARENT, { recursive: true });
  const dir = mkdtempSync(join(PARENT, `${process.pid}-`));
  try {
    return await body(dir);
  } finally {
    removeRoot(dir);
  }
}

/**
 * Removing a root can fail — a fixture left a read-only dir, a process a test
 * spawned is still writing — and that failure is the leftover's, not the run's:
 * thrown, it would replace this run's verdict, or (in the sweep) fail every
 * later run on someone else's debris. So it is printed, naming the path, and
 * the root stays for the next run's sweep to retry.
 */
function removeRoot(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    if (!(err instanceof Error) || !("code" in err)) throw err;
    console.error(
      `[test] could not remove the scratch root ${dir} (${String(err.code)}: ${err.message}); the next run's sweep retries it.`,
    );
  }
}

/** The env that points a runner (and everything it spawns) at `dir`. */
export function tmpdirEnv(dir: string): Record<string, string> {
  return { TMPDIR: dir, TMP: dir, TEMP: dir };
}

function sweepDeadRuns(): void {
  let entries: string[];
  try {
    entries = readdirSync(PARENT);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const name of entries) {
    const pid = Number(name.split("-")[0]);
    // Not a run root (nothing else is written here, but a stray name must not
    // be read as pid 0 — `kill(0, 0)` signals our own process group).
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!isAlive(pid)) removeRoot(join(PARENT, name));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists under another user — alive, not ours to judge.
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    throw err;
  }
}
