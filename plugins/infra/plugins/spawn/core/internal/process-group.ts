import { signalProcessGroup } from "./group-signal";
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
 * Zombies are members too (macOS): a descendant that exited while its parent
 * — one that left the group with `setsid`, or one that just died, leaving it to
 * launchd — has not reaped it yet. They are already dead, so they are neither
 * killed nor returned; a group of ONLY zombies answers the probe with EPERM
 * (`none-signallable`), which is how `./equin test` once exited 1 after every
 * test passed. A member that is alive yet cannot be signalled is a leak this
 * call cannot end, and it throws naming it.
 *
 * The listing is `ps` (no change signal exists for "a group emptied"; this runs
 * once, after the leader's exit, never in a loop). The kill comes after it and
 * runs whatever the listing did — a `ps` that failed is thrown only once the
 * group is dead.
 */
export async function endProcessGroup(
  pgid: number,
): Promise<LeftBehindProcess[]> {
  if (signalProcessGroup(pgid, 0) === "empty") return [];
  let listed: GroupMember[] | Error;
  try {
    listed = await listGroup(pgid);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    listed = err;
  }
  const killed = signalProcessGroup(pgid, "SIGKILL");
  if (listed instanceof Error) throw listed;
  const alive = listed.filter((p) => !p.zombie);
  // Nothing received the kill although `ps` saw a live member: either it died
  // between the listing and the kill (a zombie now), or it really cannot be
  // signalled. Look again to tell which.
  if (killed === "none-signallable" && alive.length > 0) {
    const unkillable = (await listGroup(pgid)).filter((p) => !p.zombie);
    if (unkillable.length > 0) {
      throw new Error(
        `process group ${pgid} still holds processes that cannot be signalled (EPERM), so they outlive their spawner: ${unkillable
          .map((p) => `${p.pid} ${p.command}`)
          .join("; ")}`,
      );
    }
  }
  return alive.map(({ pid, command }) => ({ pid, command }));
}

interface GroupMember extends LeftBehindProcess {
  /** `ps` state `Z`: exited, not yet reaped by its parent. */
  zombie: boolean;
}

async function listGroup(pgid: number): Promise<GroupMember[]> {
  const ps = await spawnCaptured(
    ["ps", "-o", "pid=,stat=,command=", "-g", String(pgid)],
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
      const m = /^(\d+)\s+(\S+)\s*(.*)$/.exec(line);
      if (m === null) {
        throw new Error(
          `ps -g ${pgid}: unparseable line ${JSON.stringify(line)}`,
        );
      }
      return {
        pid: Number(m[1]),
        zombie: m[2]!.startsWith("Z"),
        command: m[3]!,
      };
    });
}
