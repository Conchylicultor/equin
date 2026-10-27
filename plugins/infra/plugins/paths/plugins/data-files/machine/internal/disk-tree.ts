import { closeSync, openSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { flockTry, waitForFlock } from "@plugins/packages/plugins/flock/core";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import {
  isWithinRel,
  LockBusyError,
  relName,
  relParent,
  splitRel,
  type FileEntry,
  type Mount,
  type RelPath,
} from "../../core";

/**
 * How long `withLock` waits before giving up. Every lock taken through a root
 * guards milliseconds of work (a picks write, a few git commands for a
 * version), so a holder still there after this long is wedged, not busy.
 */
export const LOCK_WAIT_MS = 10_000;

/** A temp file `write` stages its bytes in, beside the target: `.<name>.<uuid>.tmp`. */
const TEMP_FILE_RE = /^\.[^/]*\.[0-9a-f-]{36}\.tmp$/;

/** Whether `name` is one of `write`'s own temp files (a watcher drops them). */
export function isWriteTempName(name: string): boolean {
  return TEMP_FILE_RE.test(name);
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/** `stat`, with ENOENT as `null` — the one miss a caller turns into a typed result. */
async function statOrMissing(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
}

function entryOf(name: string, st: Stats): FileEntry | null {
  const kind = st.isDirectory() ? "dir" : st.isFile() ? "file" : null;
  if (kind === null) return null;
  return {
    name,
    kind,
    size: st.size,
    mtimeMs: st.mtimeMs,
    birthtimeMs: st.birthtimeMs,
  };
}

// One in-process queue per lock file, shared by every tree in the process:
// waiters inside this process line up here, so only contention with ANOTHER
// process pays for a `flock-wait` child.
const inProcess = createKeyedMutex();

/**
 * Run `fn` holding the exclusive flock on `lockPath` (created if absent, never
 * unlinked — unlinking a lock file another process has open splits the lock in
 * two). The kernel drops it if this process dies, so a killed writer never
 * wedges the tree. Uncontended: one non-blocking `flockTry`. Contended: a
 * push-based `waitForFlock`. One deadline, `waitMs`, armed before the
 * in-process queue, bounds the whole wait — behind a holder in this process or
 * in another — then {@link LockBusyError}.
 */
export async function withFileLock<T>(
  lockPath: string,
  key: string,
  waitMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.timeout(waitMs);
  try {
    return await inProcess.run(
      lockPath,
      async () => {
        await mkdir(dirname(lockPath), { recursive: true });
        const fd = openSync(lockPath, "a");
        if (flockTry(fd)) {
          try {
            return await fn();
          } finally {
            closeSync(fd);
          }
        }
        closeSync(fd);
        const held = await waitForFlock(lockPath, { signal });
        try {
          return await fn();
        } finally {
          await held.release();
        }
      },
      { signal },
    );
  } catch (err) {
    // The deadline, from either wait (both throw the signal's own reason) —
    // never an error `fn` threw itself, even one that is also a TimeoutError.
    if (signal.aborted && err === signal.reason) {
      throw new LockBusyError(key, waitMs);
    }
    throw err;
  }
}

/**
 * Replace (or create) the file at absolute `target` atomically: the bytes go to
 * a temp file beside it (`.<name>.<uuid>.tmp`, which no extension filter
 * passes), renamed into place. Missing parents are created.
 */
export async function writeRawAtomic(
  target: string,
  data: Blob | Uint8Array | string,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = join(
    dirname(target),
    `.${basename(target)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await Bun.write(temp, data);
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

export interface DiskTreeOptions {
  /** The tree's directory, absolute — read on every operation, never frozen. */
  dir: () => string;
  /** How the tree names itself in errors (a root id, a data dir). */
  label: string;
  lockWaitMs?: number;
}

/**
 * The {@link Mount} operations over one directory of this computer's disk. No
 * ledger and no watch — the provider adds both for a declared root; the CLI
 * (`diskMount`) uses it bare.
 */
export function diskTree(opts: DiskTreeOptions): Mount {
  const lockWaitMs = opts.lockWaitMs ?? LOCK_WAIT_MS;
  const abs = (path: RelPath): string => join(opts.dir(), ...splitRel(path));
  const fail = (operation: string, path: RelPath, why: string): never => {
    throw new Error(
      `[data-files] ${operation} of "${path}" in ${opts.label}: ${why}`,
    );
  };
  const notRoot = (operation: string, path: RelPath): void => {
    if (path === "")
      fail(operation, path, "the root itself — name a path inside it");
  };

  return {
    async list(dir) {
      const target = abs(dir);
      const st = await statOrMissing(target);
      if (st === null) return { kind: "missing" };
      if (!st.isDirectory()) fail("list", dir, "a file, not a directory");
      let names: string[];
      try {
        names = await readdir(target);
      } catch (err) {
        // Removed (or renamed away) between its stat and its listing.
        if (errCode(err) === "ENOENT") return { kind: "missing" };
        throw err;
      }
      const entries: FileEntry[] = [];
      for (const name of names.sort()) {
        // Gone between the listing and its stat: a concurrent remove, which
        // the listing simply no longer includes.
        const child = await statOrMissing(join(target, name));
        if (child === null) continue;
        // A socket, FIFO or device in a data dir is nothing a root addresses.
        const entry = entryOf(name, child);
        if (entry !== null) entries.push(entry);
      }
      return { kind: "listed", entries };
    },

    async stat(path) {
      const st = await statOrMissing(abs(path));
      const entry =
        st === null ? null : entryOf(path === "" ? "" : relName(path), st);
      if (entry === null) return { kind: "missing" };
      return { kind: "found", entry };
    },

    async read(path) {
      // One open, then its stat and its bytes off the same descriptor: a
      // remove or an atomic replace racing the read can only land before the
      // open (`missing`, or the new file whole) — never between a stat and a
      // lazy read, where it would surface as a raw ENOENT.
      let handle: FileHandle;
      try {
        handle = await open(abs(path), "r");
      } catch (err) {
        if (errCode(err) === "ENOENT") return { kind: "missing" };
        throw err;
      }
      try {
        const st = await handle.stat();
        if (st.isDirectory()) fail("read", path, "a directory, not a file");
        const entry = entryOf(path === "" ? "" : relName(path), st);
        if (entry === null) return fail("read", path, "not a regular file");
        const bytes = await handle.readFile();
        return { kind: "file", blob: new Blob([bytes]), entry };
      } finally {
        await handle.close();
      }
    },

    async write(path, data) {
      notRoot("write", path);
      await writeRawAtomic(abs(path), data);
    },

    async remove(path, { recursive }) {
      notRoot("remove", path);
      const target = abs(path);
      let st: Stats;
      try {
        st = await lstat(target);
      } catch (err) {
        if (errCode(err) === "ENOENT") return;
        throw err;
      }
      if (!st.isDirectory()) {
        await unlink(target);
        return;
      }
      if (recursive) {
        await rm(target, { recursive: true, force: true });
        return;
      }
      try {
        await rmdir(target);
      } catch (err) {
        if (errCode(err) === "ENOTEMPTY" || errCode(err) === "EEXIST") {
          fail("remove", path, "a non-empty directory — pass recursive: true");
        }
        throw err;
      }
    },

    async rename(from, to) {
      notRoot("rename", from);
      notRoot("rename", to);
      if (isWithinRel(to, from)) fail("rename", from, `into itself ("${to}")`);
      const src = abs(from);
      const dest = abs(to);
      const st = await statOrMissing(src);
      if (st === null) return "missing";
      if ((await statOrMissing(dest)) !== null) return "target-exists";
      await mkdir(abs(relParent(to)), { recursive: true });
      try {
        if (st.isDirectory()) {
          // A directory cannot be hard-linked; `rename` onto an existing
          // non-empty one fails, which is the collision a concurrent writer
          // that got there first produces.
          await rename(src, dest);
        } else {
          // `link` refuses an existing target atomically, where `rename` would
          // silently replace it.
          await link(src, dest);
          await unlink(src);
        }
      } catch (err) {
        const code = errCode(err);
        if (code === "EEXIST" || code === "ENOTEMPTY") return "target-exists";
        if (code === "ENOENT") return "missing";
        throw err;
      }
      return "renamed";
    },

    withLock(key, fn) {
      notRoot("withLock", key);
      return withFileLock(
        `${abs(key)}.lock`,
        `${opts.label}:${key}`,
        lockWaitMs,
        fn,
      );
    },
  };
}
