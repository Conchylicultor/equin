import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import {
  detachedHeadOf,
  drainRecordFor,
  parseUnserved,
  renderDrainRecord,
  SLOT_DRAIN_LOG_DIR,
  SLOT_UNSERVED_FILE,
  type SlotHolder,
} from "./layout";

// The release half of the slow-drain report, synchronous: a lease let go
// (explicitly, or by an exit handler) compares the instant against its slot's
// unserved stamp and, past the threshold the stamp carries, leaves a drain
// record beside the holder records. Plain fs, nothing else: it runs on every
// release path, an exit handler included, and in processes that load nothing
// of main-slots' core. `reclaimSlots` (main-slots cli) files the records.

function readOrNullSync(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

let drainSeq = 0;

/**
 * Note that `holder` released the slot at `slot` (admin dir `admin`): a drain
 * record when the slot had stopped serving more than its threshold before.
 * Returns whether one was written.
 */
export function noteLeaseReleaseSync(i: {
  admin: string;
  slot: string;
  holder: SlotHolder;
  now?: Date;
}): boolean {
  const stampFile = join(i.admin, SLOT_UNSERVED_FILE);
  const stampText = readOrNullSync(stampFile);
  const head = readOrNullSync(join(dirname(i.admin), "HEAD"));
  const record = drainRecordFor({
    stamp: stampText === null ? null : parseUnserved(stampFile, stampText),
    holder: i.holder,
    slot: i.slot,
    commit: head === null ? null : detachedHeadOf(head),
    now: i.now ?? new Date(),
  });
  if (record === null) return false;
  const dir = join(i.admin, SLOT_DRAIN_LOG_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${process.pid}.s${Date.now()}-${++drainSeq}.json`);
  writeFileSync(`${file}.tmp`, renderDrainRecord(record));
  renameSync(`${file}.tmp`, file);
  return true;
}
