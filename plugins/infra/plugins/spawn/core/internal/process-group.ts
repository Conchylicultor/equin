import { spawnCaptured } from "./spawn-captured";
import type { LeftBehindProcess } from "./types";

/**
 * A `processGroup: "own"` child's group, ended: the processes the child left in
 * it (named, so the caller can say who leaked) are SIGKILLed.
 *
 * Called once the leader has been reaped. Its pid cannot have been reused while
 * the group still has members (POSIX never hands out a pid that is a live
 * group's id), so `-pgid` reaches exactly what the child left behind; once the
 * group is empty the kill meets ESRCH and nothing is signalled.
 *
 * The listing is `ps` (no change signal exists for "a group emptied"; this runs
 * once, after the leader's exit, never in a loop). The kill comes after it and
 * runs whatever the listing did — a `ps` that failed is thrown only once the
 * group is dead.
 */
export async function endProcessGroup(
  pgid: number,
): Promise<LeftBehindProcess[]> {
  if (!groupHasMembers(pgid)) return [];
  let listed: LeftBehindProcess[] | Error;
  try {
    listed = await listGroup(pgid);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    listed = err;
  }
  killProcessGroup(pgid, "SIGKILL");
  if (listed instanceof Error) throw listed;
  return listed;
}

/** Signal every process in group `pgid`; an emptied group is not an error. */
export function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

function groupHasMembers(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

async function listGroup(pgid: number): Promise<LeftBehindProcess[]> {
  const ps = await spawnCaptured(
    ["ps", "-o", "pid=,command=", "-g", String(pgid)],
    // A wedge-breaker for one `ps`, far above its milliseconds.
    { timeoutMs: 30_000 },
  );
  // `ps` exits 1 when nothing matched: the group emptied since the probe.
  if (ps.exitCode === 1 && ps.stdout.trim() === "") return [];
  if (ps.exitCode !== 0 || ps.timedOut) {
    throw new Error(
      `ps -g ${pgid} exited ${ps.exitCode}${ps.timedOut ? " (timed out)" : ""}: ${ps.stderr.trim()}`,
    );
  }
  return ps.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const space = line.indexOf(" ");
      return space === -1
        ? { pid: Number(line), command: "" }
        : {
            pid: Number(line.slice(0, space)),
            command: line.slice(space + 1).trim(),
          };
    });
}
