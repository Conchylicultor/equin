import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { checkoutAdminDir } from "@plugins/infra/plugins/paths/core";
import { SLOT_HANDED_FILE } from "@plugins/infra/plugins/git/plugins/main-slots/plugins/boot-lease/core";
import { isAlive } from "./alive";

// A slot handed to a build: between the hander (`runInBuildSlot`, cli/)
// releasing its exclusive lease and the build child claiming it
// (`claimHandedBuildSlot`), the slot is held by nobody — so the hander marks
// it handed to ONE handoff id first. `acquireBuildSlot` skips a slot handed
// by a live hander; the child presents the id it was given and refuses a
// slot marked for another.

/** The mark: which handoff the slot waits for, and who handed it. */
export interface SlotHanded {
  handoff: string;
  /** The hander's pid: while it lives, the handoff stands. */
  pid: number;
}

async function handedFileOf(slot: AppPath): Promise<AppPath> {
  const admin = await checkoutAdminDir(slot);
  if (admin === null)
    throw new Error(`main-slots: ${slot} is not a git checkout — not a slot`);
  return joinAppPath(admin, SLOT_HANDED_FILE);
}

/** Mark `slot` handed to `handoff` by this process. */
export async function markSlotHanded(
  slot: AppPath,
  handoff: string,
): Promise<void> {
  const file = await handedFileOf(slot);
  await mkdir(dirname(file), { recursive: true });
  const mark: SlotHanded = { handoff, pid: process.pid };
  await writeFile(`${file}.tmp`, `${JSON.stringify(mark)}\n`);
  await rename(`${file}.tmp`, file);
}

/**
 * The slot's handoff while its hander lives; `null` when none — a mark left
 * by a dead hander is stale (its build never claimed the slot) and is
 * deleted here.
 */
export async function readSlotHanded(
  slot: AppPath,
): Promise<SlotHanded | null> {
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
  if (isAlive(parsed.pid)) return { handoff: parsed.handoff, pid: parsed.pid };
  await clearSlotHanded(slot);
  return null;
}

/** Remove the mark (claimed, or the handed build is over). */
export async function clearSlotHanded(slot: AppPath): Promise<void> {
  try {
    await unlink(await handedFileOf(slot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
