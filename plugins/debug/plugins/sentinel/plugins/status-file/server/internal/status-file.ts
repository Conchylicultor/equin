import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { mkdir, unlink } from "node:fs/promises";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import { readdir } from "@plugins/packages/plugins/timed-fs/core";
import {
  SentinelStatusRecordSchema,
  type SentinelStatus,
  type SentinelStatusRecord,
  type SentinelWatch,
} from "../../core";
import {
  isErrno,
  readJsonFile,
  writeJsonAtomic,
  type JsonFileRead,
} from "./json-file";

// The host-global status files: main's sentinel host writes its own file on
// every supervision transition (a handful of writes a day); every backend reads
// them to serve `sentinel.status`, and the build CLI's admission valve reads them
// to say when the duress guard is off. Files rather than a DB row or a message,
// so a worktree backend learns main's watcher is dead without asking main —
// which may be the thing that is not answering.
//
// One file PER HOST (`status.<pid>.json`), never a shared one. A hot restart
// boots the new backend before the old one shuts down, so both hosts write at
// the same moment (the old one's `stopped` lands as the new one's `starting`
// does). Over one shared file, any "only while I still own it" check is a
// read-then-rename an interleaving defeats: on 2026-10-08 the old host's
// `stopped` overwrote the new host's `starting`, and the row said "not running"
// while the watcher ran. With a file each, no write can clobber another host's.

const STATUS_FILE_RE = /^status\.(\d+)\.json$/;

/** The status file name one watcher host writes. */
export function statusFilename(pid: number): string {
  return `status.${String(pid)}.json`;
}

/** Whether a file in the watcher's directory is a host's status file. */
export function isStatusFilename(name: string): boolean {
  return STATUS_FILE_RE.test(name);
}

/** Whether a process with this pid exists. EPERM means it exists but is not ours. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isErrno(err, "ESRCH")) return false;
    if (isErrno(err, "EPERM")) return true;
    throw err;
  }
}

/** Every host's status file in `dir`, by pid; `[]` when the dir does not exist. */
async function listStatusFiles(
  dir: AppPath,
): Promise<{ name: string; pid: number }[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (isErrno(err, "ENOENT")) return [];
    throw err;
  }
  return names.flatMap((name) => {
    const m = STATUS_FILE_RE.exec(name);
    return m ? [{ name, pid: Number(m[1]) }] : [];
  });
}

/** The newest-claimed host's record (ties: the higher pid), or why none can be named. */
async function readNewestRecord(
  dir: AppPath,
): Promise<JsonFileRead<SentinelStatusRecord>> {
  let newest: SentinelStatusRecord | null = null;
  for (const file of await listStatusFiles(dir)) {
    const read = await readJsonFile(
      joinAppPath(dir, file.name),
      SentinelStatusRecordSchema,
    );
    // Gone between the listing and the read: a new host reclaimed a dead one's.
    if (read.kind === "none") continue;
    if (read.kind === "unreadable") {
      return { kind: "unreadable", reason: `${file.name}: ${read.reason}` };
    }
    const r = read.record;
    if (
      newest === null ||
      r.claimedAt > newest.claimedAt ||
      (r.claimedAt === newest.claimedAt && r.pid > newest.pid)
    ) {
      newest = r;
    }
  }
  return newest === null
    ? { kind: "none" }
    : { kind: "record", record: newest };
}

/** What a backend serves: the newest host's status, and whether it is alive. */
export async function readSentinelWatch(
  dir: AppPath,
  alive: (pid: number) => boolean = isPidAlive,
): Promise<SentinelWatch> {
  const read = await readNewestRecord(dir);
  switch (read.kind) {
    case "none":
      return { kind: "none" };
    case "unreadable":
      return { kind: "unreadable", reason: read.reason };
    case "record":
      return {
        kind: "recorded",
        status: read.record.status,
        pid: read.record.pid,
        ownerAlive: alive(read.record.pid),
      };
  }
}

/**
 * A writer for ONE watcher host (one process), claiming the watcher at
 * `claimedAt`. Every write lands in this host's own file. The first write also
 * reclaims the files of hosts that are gone, so the directory holds at most the
 * live hosts plus the last dead one's history until the next claim.
 */
export function createStatusWriter(
  dir: AppPath,
  opts: {
    pid?: number;
    claimedAt?: number;
    alive?: (pid: number) => boolean;
  } = {},
): (status: SentinelStatus) => Promise<void> {
  const pid = opts.pid ?? process.pid;
  const claimedAt = opts.claimedAt ?? Date.now();
  const alive = opts.alive ?? isPidAlive;
  let reclaimed = false;
  // Writes land in call order, one at a time: they share one temp file, and the
  // last status written must be the one the rename leaves behind.
  const mutex = createKeyedMutex();
  return (status) => mutex.run("status", () => write(status));
  async function write(status: SentinelStatus): Promise<void> {
    await mkdir(dir, { recursive: true });
    if (!reclaimed) {
      reclaimed = true;
      for (const file of await listStatusFiles(dir)) {
        if (file.pid !== pid && !alive(file.pid))
          await unlinkIfPresent(dir, file.name);
      }
      // The pre-2026-10-08 shared file, which no reader consults any more.
      await unlinkIfPresent(dir, "status.json");
    }
    const record: SentinelStatusRecord = { status, pid, claimedAt };
    await writeJsonAtomic(dir, statusFilename(pid), record, pid);
  }
}

async function unlinkIfPresent(dir: AppPath, name: string): Promise<void> {
  try {
    await unlink(joinAppPath(dir, name));
  } catch (err) {
    if (!isErrno(err, "ENOENT")) throw err;
  }
}
