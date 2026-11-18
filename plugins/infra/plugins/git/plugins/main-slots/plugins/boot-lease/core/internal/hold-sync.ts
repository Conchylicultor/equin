import {
  constants,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  existsSync,
  readFileSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { openOwnedFdSync } from "@plugins/packages/plugins/owned-fd/core";
import { flockSharedSync } from "@plugins/packages/plugins/flock/core";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import {
  MAIN_SLOT_STAMP,
  renderHolder,
  SLOT_LEASES_DIR,
  SLOT_LOCK_FILE,
  type SlotHolder,
  type SlotHolderKind,
} from "./layout";
import { noteLeaseReleaseSync } from "./drain-sync";

// The shared lease, taken SYNCHRONOUSLY and before the process loads code from
// the slot: a shared flock(2) of the slot's lock file, blocking (packages/flock's
// `flockSharedSync`) — the flock every main-slots lease takes, on macOS and
// Linux alike — then its holder record. For the entry points that
// run before any code they could tear (the CLI bootstrap, the agent host's
// boot): main-slots' own core loads the whole paths barrel first. Each call is
// its own process's thread (`*Sync`).

/** What {@link holdSlotLeaseSync} found. */
export type SlotLeaseHold =
  | { kind: "held"; root: AppPath; release(): void }
  /** `root` is not a main slot (a worktree, the repo root, a release): nothing to hold. */
  | { kind: "not-a-slot"; root: AppPath };

/**
 * The admin dir of the checkout at `root` (`<git dir>/<lock dir>/`), or
 * `null` when `root` is not a git checkout. The same answer as
 * `infra/paths`' `checkoutAdminDir` (async), read here synchronously without that barrel.
 */
export function slotAdminDirSync(root: AppPath): AppPath | null {
  const dotGit = joinAppPath(root, ".git");
  if (!existsSync(dotGit)) return null;
  if (statSync(dotGit).isDirectory())
    return joinAppPath(dotGit, LEGACY_IDS.gitLockDir);
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
  if (match === null)
    throw new Error(`${dotGit} is a file but names no "gitdir:"`);
  const gitDir = isAbsolute(match[1]!) ? match[1]! : join(root, match[1]!);
  return joinAppPath(asAppPath(gitDir), LEGACY_IDS.gitLockDir);
}

/** The checkout holding `path`: the nearest directory above it with a `.git`. */
export function checkoutRootOfSync(path: string): AppPath {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return asAppPath(dir);
    if (dirname(dir) === dir)
      throw new Error(`no checkout (.git) above ${path}`);
  }
}

let recordSeq = 0;

/**
 * Hold the main slot at `root` SHARED, waiting (the thread blocks in the
 * flock) while a build holds it exclusively. `not-a-slot` when `root` is not
 * a stamped main slot. The lease lasts until `release()` or the process's
 * exit (the kernel drops the lock with the descriptor; the record is removed
 * by an exit handler, and a SIGKILLed holder's is skipped and pruned by
 * `readSlotHolders` — it names a dead pid).
 */
export function holdSlotLeaseSync(
  root: AppPath,
  kind: SlotHolderKind,
  label: string | null,
): SlotLeaseHold {
  const admin = slotAdminDirSync(root);
  if (admin === null || !existsSync(joinAppPath(admin, MAIN_SLOT_STAMP)))
    return { kind: "not-a-slot", root };
  mkdirSync(admin, { recursive: true });
  const fd = openOwnedFdSync(
    joinAppPath(admin, SLOT_LOCK_FILE),
    constants.O_RDONLY | constants.O_CREAT,
    0o644,
  );
  try {
    flockSharedSync(fd.fd);
  } catch (err) {
    fd.close();
    throw err;
  }
  const leases = joinAppPath(admin, SLOT_LEASES_DIR);
  mkdirSync(leases, { recursive: true });
  const record: SlotHolder = {
    pid: process.pid,
    kind,
    mode: "shared",
    acquiredAt: new Date().toISOString(),
    label,
  };
  // `b` keeps a boot record's name apart from an in-process lease's
  // (`<pid>.<n>.json`) of the same process.
  const file = join(leases, `${process.pid}.b${++recordSeq}.json`);
  writeFileSync(`${file}.tmp`, renderHolder(record));
  renameSync(`${file}.tmp`, file);
  let released = false;
  const releaseSync = (): void => {
    if (released) return;
    released = true;
    process.off("exit", releaseSync);
    releaseRecordSync({ admin, slot: root, holder: record, file });
    fd.close();
  };
  process.on("exit", releaseSync);
  return { kind: "held", root, release: releaseSync };
}

/**
 * A holder record's end: the drain note (`noteLeaseReleaseSync`), then the
 * record removed. The lock itself is the caller's to drop, after this. Also
 * a LIFETIME lease's end (main-slots' `holdSlotForLife`: a backend, central),
 * which is never released: its process root calls it from its exit handler
 * (synchronous work at exit only, never while serving) — the kernel drops
 * the lock with the process. A SIGKILLed holder runs no handler: its record
 * names a dead pid (`readSlotHolders` prunes it) and it leaves no drain note.
 */
export function releaseRecordSync(i: {
  admin: string;
  slot: string;
  holder: SlotHolder;
  file: string;
}): void {
  noteLeaseReleaseSync({ admin: i.admin, slot: i.slot, holder: i.holder });
  try {
    unlinkSync(i.file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
