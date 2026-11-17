import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { flockTry } from "@plugins/packages/plugins/flock/core";
import { openOwnedFd } from "@plugins/packages/plugins/owned-fd/core";
import { checkoutAdminDir } from "@plugins/infra/plugins/paths/core";
import { isAlive } from "./alive";
import {
  SLOT_HANDED_FILE,
  slotHandedLockFile,
} from "@plugins/infra/plugins/git/plugins/main-slots/plugins/boot-lease/core";

// A slot handed to a build: between the hander (`runInBuildSlot`, cli/)
// releasing its exclusive lease and the build child claiming it
// (`claimHandedBuildSlot`), the slot is held by nobody — so the hander marks
// it handed to ONE handoff id first. `acquireBuildSlot` skips a slot handed
// by a live hander; the child presents the id it was given and refuses a
// slot marked for another.
//
// Whether the hander still lives is its LOCK's answer, never its pid's: the
// hander holds `<admin dir>/main-slot-handed.<handoff>.lock` exclusively from
// before it writes the mark until it lets the handoff go (or dies — the
// kernel drops a dead process's flock). A pid would lie once reused by an
// unrelated process, keeping the slot "building" forever — the same reason
// slot states probe `tree.lock` rather than trust holder records. One lock
// file per handoff, so a hander still holding its own after the child
// claimed the slot never stands in the way of the next one.
//
// The mark's FORMAT crosses versions: the hander is the convergence run, which
// the gateway starts in the slot main SERVES (gateway/main_deploy.go
// convergeDir), so it runs the code of the commit before the one it builds.
// A child must therefore read every mark an older hander may still write —
// each format says how its hander holds it (`hold`), and a reader judges the
// mark the way the code that wrote it meant. A child that refused an older
// format would fail every build, and main could never deploy the commit that
// stops writing it (2026-11-17: 958f655c93 added the lock; its own build, and
// every later one, was handed a pid-only mark by 391c3fb280). An unknown
// `hold` is refused loudly. Change the format by adding a `hold`, never by
// reinterpreting one.

/** How a mark's hander holds it — the format of the mark. */
export type SlotHandedHold =
  /** The hander holds {@link slotHandedLockFile} (since 958f655c93). */
  | "lock"
  /**
   * Written before marks named their hold (`{handoff, pid}`): the hander
   * lives while its pid does — still handed by a pre-lock hander serving
   * main (a deploy across 958f655c93, a rollback to a commit before it).
   */
  | "pid";

/** The mark: which handoff the slot waits for, and who handed it. */
export interface SlotHanded {
  handoff: string;
  /** The hander's pid — names it; for a `lock` mark its lock, not this, says whether it lives. */
  pid: number;
  hold: SlotHandedHold;
}

/** The hander's hold on a handoff: the mark stands while it is held. */
export interface SlotHandoffHold {
  /** Remove the mark (when it is still this handoff's) and let the hander lock go. Idempotent. */
  release(): Promise<void>;
}

async function adminOf(slot: AppPath): Promise<AppPath> {
  const admin = await checkoutAdminDir(slot);
  if (admin === null)
    throw new Error(`main-slots: ${slot} is not a git checkout — not a slot`);
  return admin;
}

async function handedFileOf(slot: AppPath): Promise<AppPath> {
  return joinAppPath(await adminOf(slot), SLOT_HANDED_FILE);
}

async function handedLockOf(slot: AppPath, handoff: string): Promise<AppPath> {
  return joinAppPath(await adminOf(slot), slotHandedLockFile(handoff));
}

async function unlinkIfThere(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Mark `slot` handed to `handoff` by this process, holding the handoff's
 * lock until the returned hold is released (or this process dies).
 */
export async function markSlotHanded(
  slot: AppPath,
  handoff: string,
): Promise<SlotHandoffHold> {
  if (!/^[A-Za-z0-9-]+$/.test(handoff))
    throw new Error(
      `main-slots: handoff id ${JSON.stringify(handoff)} is not a plain id`,
    );
  const file = await handedFileOf(slot);
  await mkdir(dirname(file), { recursive: true });
  const lockPath = await handedLockOf(slot, handoff);
  const lock = await openOwnedFd(lockPath, "a");
  if (!flockTry(lock.fd)) {
    lock.close();
    throw new Error(
      `main-slots: ${slot}'s handoff ${handoff} is already held — a handoff id is used once`,
    );
  }
  const mark: SlotHanded = { handoff, pid: process.pid, hold: "lock" };
  try {
    await writeFile(`${file}.tmp`, `${JSON.stringify(mark)}\n`);
    await rename(`${file}.tmp`, file);
  } catch (err) {
    lock.close();
    throw err;
  }
  return {
    async release() {
      if (lock.closed) return;
      try {
        const current = await readMark(slot);
        if (current?.handoff === handoff) await clearSlotHanded(slot);
        // Removed while held: no reader can see it unheld and mistake it
        // for a dead hander's.
        await unlinkIfThere(lockPath);
      } finally {
        // Closing the descriptor drops the flock.
        lock.close();
      }
    },
  };
}

/** Is `handoff`'s lock held — a non-blocking exclusive try, let go at once. */
async function handerHolds(slot: AppPath, handoff: string): Promise<boolean> {
  let fd;
  try {
    fd = await openOwnedFd(await handedLockOf(slot, handoff), "r");
  } catch (err) {
    // Released: its hander removed the lock file.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  try {
    return !flockTry(fd.fd);
  } finally {
    fd.close();
  }
}

async function readMark(slot: AppPath): Promise<SlotHanded | null> {
  const file = await handedFileOf(slot);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
  const parsed = JSON.parse(text) as
    (Omit<Partial<SlotHanded>, "hold"> & { hold?: unknown }) | null;
  if (
    parsed === null ||
    typeof parsed.handoff !== "string" ||
    typeof parsed.pid !== "number"
  )
    throw new Error(`main-slots: handoff mark ${file} is malformed: ${text}`);
  // No `hold`: the pre-lock format (see the header).
  const hold = parsed.hold ?? "pid";
  if (hold !== "lock" && hold !== "pid")
    throw new Error(
      `main-slots: handoff mark ${file} names a hold this code does not know (${JSON.stringify(hold)}): ${text}`,
    );
  return { handoff: parsed.handoff, pid: parsed.pid, hold };
}

/** Does the mark's hander still hold it — judged as the format that wrote it means. */
async function handerLives(slot: AppPath, mark: SlotHanded): Promise<boolean> {
  switch (mark.hold) {
    case "lock":
      return handerHolds(slot, mark.handoff);
    case "pid":
      return isAlive(mark.pid);
  }
}

/**
 * The slot's handoff while its hander holds it; `null` when none — a mark
 * whose hander lock is unheld (a pre-lock mark: whose pid is dead) is stale (the hander died before its build
 * claimed the slot or ended) and is deleted here, with its lock file.
 */
export async function readSlotHanded(
  slot: AppPath,
): Promise<SlotHanded | null> {
  const mark = await readMark(slot);
  if (mark === null) return null;
  if (await handerLives(slot, mark)) return mark;
  await clearSlotHanded(slot);
  await unlinkIfThere(await handedLockOf(slot, mark.handoff));
  return null;
}

/** Remove the mark (claimed, or the handed build is over). */
export async function clearSlotHanded(slot: AppPath): Promise<void> {
  await unlinkIfThere(await handedFileOf(slot));
}
