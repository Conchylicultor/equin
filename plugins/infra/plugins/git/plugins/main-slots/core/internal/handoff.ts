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

/** The mark: which handoff the slot waits for, and who handed it. */
export interface SlotHanded {
  handoff: string;
  /** The hander's pid — names it; its lock, not this, says whether it lives. */
  pid: number;
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
  const mark: SlotHanded = { handoff, pid: process.pid };
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
  const parsed = JSON.parse(text) as Partial<SlotHanded> | null;
  if (
    parsed === null ||
    typeof parsed.handoff !== "string" ||
    typeof parsed.pid !== "number"
  )
    throw new Error(`main-slots: handoff mark ${file} is malformed: ${text}`);
  return { handoff: parsed.handoff, pid: parsed.pid };
}

/**
 * The slot's handoff while its hander holds it; `null` when none — a mark
 * whose hander lock is unheld is stale (the hander died before its build
 * claimed the slot or ended) and is deleted here, with its lock file.
 */
export async function readSlotHanded(
  slot: AppPath,
): Promise<SlotHanded | null> {
  const mark = await readMark(slot);
  if (mark === null) return null;
  if (await handerHolds(slot, mark.handoff)) return mark;
  await clearSlotHanded(slot);
  await unlinkIfThere(await handedLockOf(slot, mark.handoff));
  return null;
}

/** Remove the mark (claimed, or the handed build is over). */
export async function clearSlotHanded(slot: AppPath): Promise<void> {
  await unlinkIfThere(await handedFileOf(slot));
}
