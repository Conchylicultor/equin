import { sleepStampNow } from "@plugins/packages/plugins/sleep-clock/core";
import { mkdir, rename, unlink, utimes, writeFile } from "node:fs/promises";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  readdir,
  readFile,
  realpath,
  stat,
} from "@plugins/packages/plugins/timed-fs/core";
import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  openOwnedFd,
  type OwnedFd,
} from "@plugins/packages/plugins/owned-fd/core";
import {
  flockTry,
  flockTryShared,
  waitForFlock,
  type HeldFlock,
} from "@plugins/packages/plugins/flock/core";
import {
  checkoutAdminDir,
  checkoutLockPath,
  isMainSlotCheckout,
} from "@plugins/infra/plugins/paths/core";
import {
  detachedHeadOf,
  drainRecordFor,
  releaseRecordSync,
  parseHolder,
  parseUnserved,
  renderDrainRecord,
  renderHolder,
  SLOT_DRAIN_LOG_DIR,
  SLOT_LEASES_DIR,
  SLOT_UNSERVED_FILE,
  type SlotHolder,
  type SlotHolderKind,
  type SlotLeaseMode,
} from "@plugins/infra/plugins/git/plugins/main-slots/plugins/boot-lease/core";
import { dirname } from "node:path";
import { isAlive } from "./alive";
import { clearSlotHanded, readSlotHanded } from "./handoff";
import { withSlotPool } from "./pool-lock";

// A slot is a reader/writer lock — `<admin dir>/tree.lock` (a linked worktree
// has its own git dir, so each slot has its own lock). What this adds: holds for a
// process's whole life, a non-blocking exclusive try, a downgrade, and a
// record of who holds it, so a build that finds every slot held can name the
// holders. The file layout and the holder kinds are `boot-lease`'s (the
// synchronous hold an entry point takes before loading code), one spelling
// for both.

/** A lease this process holds on one slot. */
export interface SlotLease {
  readonly slot: AppPath;
  readonly mode: SlotLeaseMode;
  readonly kind: SlotHolderKind;
  readonly label: string;
  /**
   * Note a slow drain (a drain record, when the slot stopped serving past its
   * threshold before now), remove the holder record, then drop the lock. Idempotent. A lifetime
   * holder ({@link holdSlotForLife}) never calls it: the kernel drops the
   * lock when the process dies.
   */
  release(): Promise<void>;
  /**
   * Turn this EXCLUSIVE lease SHARED, in place (the same descriptor, so the
   * slot is never let go), and rewrite the record — how a build hands its
   * slot to the backend it is about to restart there. `flock(2)` converts an
   * exclusive lock by dropping it and taking the shared one, so another
   * process waiting for the slot exclusively could take it in between: the
   * conversion is refused loudly then (the try is non-blocking). Who could
   * be waiting is the caller's argument to make (`run.ts`'s handover).
   * Throws on a lease held through a `flock-wait` child (a waited-for one):
   * only a lock on this process's own descriptor can be converted.
   * Idempotent on a shared lease.
   */
  downgrade(): Promise<void>;
}

/** What a non-blocking exclusive try found. */
export type TryExclusiveLease =
  | { kind: "acquired"; lease: SlotLease }
  | { kind: "held"; holders: SlotHolder[] };

async function adminDirOf(slot: AppPath): Promise<AppPath> {
  const dir = await checkoutAdminDir(slot);
  if (dir === null)
    throw new Error(`main-slots: ${slot} is not a git checkout — not a slot`);
  return dir;
}

async function lockPathOf(slot: AppPath): Promise<AppPath> {
  const path = await checkoutLockPath(slot);
  if (path === null)
    throw new Error(`main-slots: ${slot} is not a git checkout — not a slot`);
  await mkdir(await adminDirOf(slot), { recursive: true });
  return path;
}

/** How this process holds the lock: on a descriptor of its own, or through a `flock-wait` child. */
type Held = { kind: "fd"; fd: OwnedFd } | { kind: "child"; held: HeldFlock };

function releaseHeld(held: Held): Promise<void> {
  if (held.kind === "child") return held.held.release();
  // Closing the descriptor drops the lock.
  if (!held.fd.closed) held.fd.close();
  return Promise.resolve();
}

// One record per lease, so a process holding two leases on one slot (a
// backend that also checks a guard) keeps both records.
let recordSeq = 0;
let drainSeq = 0;

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * The release half of the slow-drain report (boot-lease's
 * `noteLeaseReleaseSync`, for an async releaser): a drain record when the
 * slot stopped serving more than its threshold before now.
 */
async function noteRelease(
  admin: AppPath,
  slot: AppPath,
  holder: SlotHolder,
  found: { now: Date; foundDead: boolean } = {
    now: new Date(),
    foundDead: false,
  },
): Promise<void> {
  const stampFile = joinAppPath(admin, SLOT_UNSERVED_FILE);
  const stampText = await readIfExists(stampFile);
  if (stampText === null) return;
  const head = await readIfExists(`${dirname(admin)}/HEAD`);
  const record = drainRecordFor({
    stamp: parseUnserved(stampFile, stampText),
    holder,
    slot,
    commit: head === null ? null : detachedHeadOf(head),
    now: found.now,
    // A holder found dead is judged up to when it was last seen alive (a past
    // instant); the sleep clock reads the present, and the sleep after that
    // instant is not in the span — so the wall clock, as before (a holder
    // killed overnight would otherwise have every hour of the night taken out).
    asleepNow: found.foundDead ? null : sleepStampNow(),
    foundDead: found.foundDead,
  });
  if (record === null) return;
  const dir = joinAppPath(admin, SLOT_DRAIN_LOG_DIR);
  await mkdir(dir, { recursive: true });
  await writeRecordText(
    joinAppPath(dir, `${process.pid}.a${Date.now()}-${++drainSeq}.json`),
    renderDrainRecord(record),
  );
}

async function writeRecordText(file: AppPath, text: string): Promise<void> {
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
}

async function writeRecord(file: AppPath, record: SlotHolder): Promise<void> {
  // Written whole, then renamed: a reader never sees half a record.
  await writeFile(`${file}.tmp`, renderHolder(record));
  await rename(`${file}.tmp`, file);
}

interface RecordedLease {
  lease: SlotLease;
  admin: AppPath;
  file: AppPath;
  record: SlotHolder;
  /** The record's end was already noted and removed (at exit): `release` only drops the lock. */
  recordEnded: { value: boolean };
}

async function recordHolder(
  slot: AppPath,
  mode: SlotLeaseMode,
  kind: SlotHolderKind,
  label: string,
  held: Held,
): Promise<RecordedLease> {
  const admin = await adminDirOf(slot);
  const dir = joinAppPath(admin, SLOT_LEASES_DIR);
  await mkdir(dir, { recursive: true });
  const record: SlotHolder = {
    pid: process.pid,
    kind,
    mode,
    acquiredAt: new Date().toISOString(),
    label,
  };
  const file = joinAppPath(dir, `${process.pid}.${++recordSeq}.json`);
  await writeRecord(file, record);
  let released = false;
  let current = mode;
  const recordEnded = { value: false };
  const lease: SlotLease = {
    slot,
    get mode() {
      return current;
    },
    kind,
    label,
    release: async () => {
      if (released) return;
      released = true;
      if (!recordEnded.value) {
        recordEnded.value = true;
        await noteRelease(admin, slot, { ...record, mode: current });
        // ENOENT: the slot was removed under its own lease (`reclaimSlots`
        // deletes a free slot while holding it exclusively).
        await unlink(file).catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        });
      }
      await releaseHeld(held);
    },
    downgrade: async () => {
      if (current === "shared") return;
      if (released) throw new Error(`main-slots: ${slot}'s lease was released`);
      if (held.kind !== "fd") {
        throw new Error(
          `main-slots: ${slot}'s exclusive lease is held through a flock-wait child — it cannot be turned shared in place`,
        );
      }
      const fd = held.fd;
      // Under the pool lock: the one other exclusive try that could land in
      // the conversion's gap is a state probe (`slotStates`), which holds it.
      await withSlotPool(async () => {
        if (!flockTryShared(fd.fd)) {
          throw new Error(
            `main-slots: turning ${slot}'s lease shared lost the slot — another process took it exclusively in the conversion's gap`,
          );
        }
        current = "shared";
        await writeRecord(file, { ...record, mode: "shared" });
      });
    },
  };
  return { lease, admin, file, record, recordEnded };
}

/**
 * Hold `slot` SHARED — while this process runs code from it. Any number of
 * holders share it; a build's exclusive lease waits for all of them, and one
 * arriving while a build holds the slot waits for the build. In-process fast
 * path (an open + non-blocking `flock(LOCK_SH)`); only behind an exclusive
 * holder does it wait, in a `flock-wait` child.
 */
export async function acquireSharedLease(
  slot: AppPath,
  kind: SlotHolderKind,
  label: string,
): Promise<SlotLease> {
  return (await sharedLease(slot, kind, label)).lease;
}

async function sharedLease(
  slot: AppPath,
  kind: SlotHolderKind,
  label: string,
): Promise<RecordedLease> {
  const path = await lockPathOf(slot);
  const fd = await openOwnedFd(path, "a");
  if (flockTryShared(fd.fd))
    return recordHolder(slot, "shared", kind, label, { kind: "fd", fd });
  fd.close();
  const held = await waitForFlock(path, { shared: true });
  return recordHolder(slot, "shared", kind, label, { kind: "child", held });
}

/** What {@link holdSlotForLife} found. */
export type SlotHold =
  | {
      kind: "held";
      lease: SlotLease;
      /**
       * The lease's end at the process's exit — its drain note and its
       * record removed (the kernel drops the lock). For the process root's
       * exit handler: `process.on("exit", hold.releaseAtExitSync)`.
       * Synchronous, as an exit handler must be; a no-op once released.
       */
      releaseAtExitSync: () => void;
    }
  /** `root` is not a main slot (a worktree, the repo root, a release): nothing to hold. */
  | { kind: "not-a-slot" };

/**
 * Hold the checkout this process runs from SHARED for the rest of its life,
 * when it is a main slot — a serving backend, central. The lease is never
 * released: the kernel drops the lock with the process. Its root hands
 * `releaseAtExitSync` to its exit handler, which notes a slow drain and
 * removes the record; a SIGKILLed holder's record names a dead pid, which
 * {@link readSlotHolders} skips and deletes.
 */
export async function holdSlotForLife(
  root: AppPath,
  kind: SlotHolderKind,
  label: string,
): Promise<SlotHold> {
  if (!(await isMainSlotCheckout(root))) return { kind: "not-a-slot" };
  const held = await sharedLease(root, kind, label);
  return {
    kind: "held",
    lease: held.lease,
    releaseAtExitSync: () => {
      if (held.recordEnded.value) return;
      held.recordEnded.value = true;
      releaseRecordSync({
        admin: held.admin,
        slot: root,
        holder: held.record,
        file: held.file,
      });
    },
  };
}

/**
 * Take `slot` EXCLUSIVELY if nobody holds it, without waiting. `held` names
 * the live holders the try found. The lease is on this process's own
 * descriptor, so it can be turned shared in place (`downgrade`).
 */
export async function tryExclusiveLease(
  slot: AppPath,
  kind: SlotHolderKind,
  label: string,
): Promise<TryExclusiveLease> {
  const path = await lockPathOf(slot);
  const fd = await openOwnedFd(path, "a");
  if (flockTry(fd.fd))
    return {
      kind: "acquired",
      lease: (
        await recordHolder(slot, "exclusive", kind, label, { kind: "fd", fd })
      ).lease,
    };
  fd.close();
  return { kind: "held", holders: await readSlotHolders(slot) };
}

/**
 * Take `slot` EXCLUSIVELY, waiting (push-based, in a `flock-wait` child) for
 * every holder to release. `signal` cancels the wait (and throws its reason).
 */
export async function waitExclusiveLease(
  slot: AppPath,
  kind: SlotHolderKind,
  label: string,
  opts: { signal?: AbortSignal } = {},
): Promise<SlotLease> {
  const path = await lockPathOf(slot);
  const held = await waitForFlock(path, { signal: opts.signal });
  try {
    return (
      await recordHolder(slot, "exclusive", kind, label, {
        kind: "child",
        held,
      })
    ).lease;
  } catch (err) {
    // The slot went while this waited (reclaimed: its lock file is deleted
    // with its registration) — the grant is on a lock nothing reads; let it
    // go rather than leave its flock-wait child holding it.
    await held.release();
    throw err;
  }
}

/** How a slot's lock is held, as a probe found it. */
export type SlotLockProbe = "unheld" | "shared" | "exclusive";

/**
 * How `slot`'s lock is held right now — the truth about whether anything
 * runs from or builds in it, where the holder records only NAME holders (a
 * record's pid can be reused by an unrelated process once its holder was
 * SIGKILLed, so a record alone never makes a slot held). A non-blocking
 * exclusive try, let go at once; when refused, a non-blocking shared try
 * tells a shared holder from an exclusive one. Call it under the pool lock
 * (`slotStates` does): the exclusive try must not land in a downgrade's gap,
 * nor beside another build's try.
 */
export async function probeSlotLock(slot: AppPath): Promise<SlotLockProbe> {
  const fd = await openOwnedFd(await lockPathOf(slot), "a");
  try {
    if (flockTry(fd.fd)) return "unheld";
    if (flockTryShared(fd.fd)) return "shared";
    return "exclusive";
  } finally {
    // Closing the descriptor drops whatever the probe took.
    fd.close();
  }
}

/**
 * The holders `slot`'s records name, live processes only. Diagnostics: the
 * flock is the truth about whether a slot is held; a record says who.
 *
 * Each live holder's record is TOUCHED (its mtime set to now): the record's
 * mtime is when its holder was last seen alive, which bounds when a holder
 * killed later died. A record of a dead pid (a lifetime holder that exited, a
 * SIGKILLed one) is never trusted — it is reaped here ({@link reapRecord}:
 * noted as a drain when it was last seen alive past its slot's switch, then
 * deleted), so records cannot pile up and a killed holder is still reported.
 */
export async function readSlotHolders(slot: AppPath): Promise<SlotHolder[]> {
  const admin = await adminDirOf(slot);
  const holders: SlotHolder[] = [];
  const now = new Date();
  for (const { file, holder } of await readRecords(admin)) {
    if (!isAlive(holder.pid)) {
      await reapRecord(admin, slot, file, holder);
      continue;
    }
    holders.push(holder);
    await utimes(file, now, now).catch((err: unknown) => {
      // Released since it was read.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    });
  }
  return holders;
}

/** Every holder record of the slot whose admin dir is `admin`, as found. */
async function readRecords(
  admin: AppPath,
): Promise<{ file: AppPath; holder: SlotHolder }[]> {
  const dir = joinAppPath(admin, SLOT_LEASES_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: { file: AppPath; holder: SlotHolder }[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const file = joinAppPath(dir, name);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      // Released (or reaped) between the listing and the read.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    out.push({ file, holder: parseHolder(file, text) });
  }
  return out;
}

/**
 * End a dead holder's record: claimed by a rename (so two readers never both
 * note it, and a holder that released it meanwhile — its record gone — is
 * skipped), noted as a drain found dead when it was last seen ALIVE (the
 * record's mtime: written at acquire, touched by every `readSlotHolders`
 * that saw its pid live) past its slot's threshold, then deleted. When it
 * died is unknown — only that it held at least that long — so a holder
 * killed inside the threshold (a backend SIGKILLed after the gateway's
 * shutdown grace) is never reported. A SIGKILLed holder runs no release, so
 * this is the only place its drain is seen.
 */
async function reapRecord(
  admin: AppPath,
  slot: AppPath,
  file: AppPath,
  holder: SlotHolder,
): Promise<void> {
  const claimed = `${file}.reaping-${process.pid}`;
  try {
    await rename(file, claimed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  try {
    const lastSeenAlive = (await stat(claimed)).mtime;
    await noteRelease(admin, slot, holder, {
      now: lastSeenAlive,
      foundDead: true,
    });
  } finally {
    await unlink(claimed).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    });
  }
}

/**
 * Reap every record of `slot` whose holder is gone, noting each that held
 * past the slot's switch as a drain found dead. The lock decides, as for slot
 * states: while it is unheld, EVERY record is a dead holder's (a holder
 * removes its record before it lets the lock go, so a record read before an
 * unheld probe outlived its holder) — a pid reused by an unrelated process
 * keeps nothing; while it is held, a record of a dead pid is.
 *
 * Under the pool lock (its probe must not land in a downgrade's gap). Never
 * on a slot handed to a build: its claim's exclusive try must not meet a
 * probe. Called before a slot is stamped unserved (so a holder already dead
 * at the switch is dropped unreported) and by every reclaim.
 */
export async function reapDeadHolders(slot: AppPath): Promise<void> {
  await withSlotPool(async () => {
    const admin = await adminDirOf(slot);
    const records = await readRecords(admin);
    if (records.length === 0) return;
    const unheld = (await probeSlotLock(slot)) === "unheld";
    for (const { file, holder } of records) {
      if (unheld || !isAlive(holder.pid))
        await reapRecord(admin, slot, file, holder);
    }
  });
}

/** What {@link claimHandedBuildSlot} found. */
export type HandedBuildSlot =
  | { kind: "handed"; lease: SlotLease }
  /** No slot was handed to this process (`EQUIN_BUILD_SLOT` unset, or naming another checkout). */
  | { kind: "not-handed" };

/**
 * The exclusive lease of the slot `root` when it was handed to this process
 * to build in (`runInBuildSlot`, cli/, sets `EQUIN_BUILD_SLOT` and
 * `EQUIN_BUILD_SLOT_HANDOFF`): the slot must be marked handed to that very
 * handoff by a live hander, and is taken without waiting, since nothing may
 * hold a slot handed to a build. Either broken is refused loudly. Once held,
 * the mark is cleared — the lease guards the slot from here.
 */
export async function claimHandedBuildSlot(
  root: AppPath,
  label: string,
): Promise<HandedBuildSlot> {
  const handed = readEnv("BUILD_SLOT");
  if (
    handed === undefined ||
    (await realpath(handed)) !== (await realpath(root))
  )
    return { kind: "not-handed" };
  const handoff = readEnv("BUILD_SLOT_HANDOFF");
  const mark = await readSlotHanded(root);
  if (handoff === undefined || mark === null || mark.handoff !== handoff) {
    throw new Error(
      `main-slots: ${root} was handed to this build (handoff ${handoff ?? "none"}), but the slot is marked ${mark === null ? "handed to no live build" : `handed to ${mark.handoff} by pid ${mark.pid}`} — another build may have taken it`,
    );
  }
  const tried = await tryExclusiveLease(root, "build", label);
  if (tried.kind === "held") {
    throw new Error(
      `main-slots: ${root} was handed to this build, but is held by ${JSON.stringify(tried.holders)} — nothing may hold a slot a build was handed`,
    );
  }
  await clearSlotHanded(root);
  return { kind: "handed", lease: tried.lease };
}
