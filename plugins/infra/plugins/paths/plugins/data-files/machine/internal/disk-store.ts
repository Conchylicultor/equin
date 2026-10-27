import { existsSync, realpathSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import type {
  FileWatcher,
  FileWatcherDecl,
} from "@plugins/infra/plugins/file-watcher/server";
import type {
  AgentWriteLedger,
  AgentWriteLedgerEntry,
} from "@plugins/infra/plugins/request-origin/plugins/agent-write-ledger/server";
import type { WriteOrigin } from "@plugins/infra/plugins/request-origin/core";
import {
  isWithinRel,
  parseRelPath,
  splitRel,
  InvalidRelPathError,
  type DataChange,
  type DataChangeHandler,
  type RelPath,
} from "../../core";
import {
  requireWatchSpec,
  watchedPaths,
  type DataFilesImpl,
  type FileRootSpec,
  type FileRootStore,
} from "@plugins/infra/plugins/paths/plugins/data-files/server";
import { diskTree, isWriteTempName, writeRawAtomic } from "./disk-tree";

/** The file a root's ledger snapshots: one, per written path. */
export type LedgerFile = "file";

/** Where one root lives on this machine, and what the provider runs over it. */
export interface BoundRoot {
  /** The absolute directory — a getter over the data dir, never frozen. */
  readonly dir: () => string;
  /** The declared watcher over it, registered — present iff the root declares `watch`. */
  readonly watcher: FileWatcherDecl | null;
  /** The agent-write ledger over `spec.ledger.under` — present iff the root declares one. */
  readonly ledger: AgentWriteLedger<LedgerFile> | null;
}

export interface DiskDataFilesOptions {
  /** A root's binding; throws for a root this host never bound. */
  bound: (spec: FileRootSpec) => BoundRoot;
  lockWaitMs?: number;
}

/**
 * The desktop's DataFiles: each root a directory of this computer's disk.
 *
 * - Writes are temp-file-then-rename (atomic); reads open the file once and take its stat and bytes off that descriptor.
 * - `withLock(key)` is an flock on `<key>.lock` inside the root — the same lock
 *   files the prototypes CLI and every other backend take, so all of them
 *   interoperate.
 * - `watch` opens the root's declared file watcher once, on the first
 *   subscriber, and fans its batches out; a dropped-events report (`onLost`) is a `rescan`.
 * - An agent-origin write or remove under the root's ledger area is recorded
 *   in the shared agent-write ledger first, so the e2e harness can revert it.
 */
export function createDiskDataFiles(opts: DiskDataFilesOptions): DataFilesImpl {
  const stores = new Map<string, FileRootStore>();

  function open(spec: FileRootSpec): FileRootStore {
    const binding = (): BoundRoot => opts.bound(spec);
    const tree = diskTree({
      dir: () => binding().dir(),
      label: `root "${spec.id}"`,
      lockWaitMs: opts.lockWaitMs,
    });
    const absOf = (path: RelPath): string =>
      join(binding().dir(), ...splitRel(path));
    const watch = rootWatch(spec, binding);

    /** The ledger recording `writer`'s change to `path`, or null when none applies. */
    const ledgerFor = (
      writer: WriteOrigin,
      path: RelPath,
    ): AgentWriteLedger<LedgerFile> | null => {
      const under = spec.ledger?.under;
      if (writer.kind !== "agent" || under === undefined) return null;
      if (!isWithinRel(path, under)) return null;
      const ledger = binding().ledger;
      if (ledger === null) {
        throw new Error(
          `[data-files] root "${spec.id}" declares a ledger but its binding has none`,
        );
      }
      return ledger;
    };

    /** Refuse an agent's change the ledger cannot put back (a directory's worth). */
    const refuseUnledgerable = (
      writer: WriteOrigin,
      operation: string,
      ...paths: RelPath[]
    ): void => {
      const under = spec.ledger?.under;
      if (writer.kind !== "agent" || under === undefined) return;
      const touched = paths.find(
        (p) => isWithinRel(p, under) || isWithinRel(under, p),
      );
      if (touched !== undefined) {
        throw new Error(
          `[data-files] ${operation} of "${touched}" in "${spec.id}" by an agent touches the ledgered area "${under}", which records single files only — it could not be reverted`,
        );
      }
    };

    return {
      list: (dir) => tree.list(dir),
      stat: (path) => tree.stat(path),
      read: (path) => tree.read(path),
      async write(path, data, wopts) {
        const ledger = ledgerFor(wopts.writer, path);
        if (ledger === null) return tree.write(path, data, wopts);
        ledger.record(wopts.writer, path, { file: absOf(path) }, "write");
        await tree.write(path, data, wopts);
        ledger.noteComplete(wopts.writer, path);
      },
      async remove(path, ropts) {
        const st = await tree.stat(path);
        if (st.kind === "found" && st.entry.kind === "dir") {
          refuseUnledgerable(ropts.writer, "remove", path);
          return tree.remove(path, ropts);
        }
        const ledger = ledgerFor(ropts.writer, path);
        if (ledger === null) return tree.remove(path, ropts);
        ledger.record(ropts.writer, path, { file: absOf(path) }, "remove");
        await tree.remove(path, ropts);
        ledger.noteComplete(ropts.writer, path);
      },
      rename(from, to, wopts) {
        refuseUnledgerable(wopts.writer, "rename", from, to);
        return tree.rename(from, to, wopts);
      },
      withLock: (key, fn) => tree.withLock(key, fn),
      watch: (onChange) => watch.subscribe(onChange),
    };
  }

  return {
    root(spec) {
      let store = stores.get(spec.id);
      if (store === undefined) {
        store = open(spec);
        stores.set(spec.id, store);
      }
      return store;
    },
  };
}

/** The real path of a directory, or the path itself before it exists. */
function realDir(dir: string): string {
  return existsSync(dir) ? realpathSync(dir) : dir;
}

/**
 * One root's watch: the declared watcher opened once, on the first subscriber,
 * and stopped with the last; each batch handed to every subscriber as paths
 * inside the root.
 */
function rootWatch(spec: FileRootSpec, binding: () => BoundRoot) {
  const handlers = new Set<DataChangeHandler>();
  let opening: Promise<FileWatcher> | null = null;

  /** An event's absolute path as a RelPath inside the root, or null outside it. */
  const relOf = (path: string, prefixes: readonly string[]): RelPath | null => {
    for (const prefix of prefixes) {
      if (!path.startsWith(prefix + sep)) continue;
      const rel = path
        .slice(prefix.length + 1)
        .split(sep)
        .join("/");
      try {
        return parseRelPath(rel);
      } catch (err) {
        // A name a root cannot address (a `\` in it) is nothing a consumer
        // could act on: it has no RelPath.
        if (err instanceof InvalidRelPathError) return null;
        throw err;
      }
    }
    return null;
  };

  const deliver = async (change: DataChange): Promise<void> => {
    await Promise.all(
      [...handlers].map(async (handler) => {
        await handler(change);
      }),
    );
  };

  async function open(): Promise<FileWatcher> {
    const watcher = binding().watcher;
    if (watcher === null) {
      throw new Error(
        `[data-files] root "${spec.id}" declares \`watch\` but its binding opened no watcher`,
      );
    }
    const dir = binding().dir();
    // The engine errors on a missing dir; the root's data dir is its owner's,
    // so making it is the root's to do.
    await mkdir(dir, { recursive: true });
    // FSEvents reports real paths (`/private/var/…` for `/var/…`).
    const prefixes = [...new Set([dir, realDir(dir)])];
    return watcher.start({
      dirs: [dir],
      label: spec.id,
      onChange: (events) => {
        const paths = events
          .map((e) => relOf(e.path, prefixes))
          .filter(
            (p): p is RelPath =>
              p !== null &&
              p !== "" &&
              !isWriteTempName(p.slice(p.lastIndexOf("/") + 1)),
          );
        const reported = watchedPaths(spec, paths);
        if (reported.length === 0) return undefined;
        return deliver({ kind: "changed", paths: reported });
      },
      // The watch reported dropped events: re-derive everything.
      onLost: () => deliver({ kind: "rescan" }),
    });
  }

  return {
    async subscribe(onChange: DataChangeHandler) {
      requireWatchSpec(spec);
      // One entry per subscription, even for a handler subscribed twice.
      const handler: DataChangeHandler = (change) => onChange(change);
      handlers.add(handler);
      opening ??= open();
      try {
        await opening;
      } catch (err) {
        handlers.delete(handler);
        opening = null;
        throw err;
      }
      return {
        async dispose() {
          if (!handlers.delete(handler) || handlers.size > 0) return;
          const closing = opening;
          opening = null;
          if (closing !== null) await (await closing).stop();
        },
      };
    },
  };
}

/**
 * Put one ledgered file back — exact bytes, or gone when it did not exist —
 * for `defineAgentWriteLedger`'s `restore`. The root's watcher hears the write
 * like any other.
 *
 * An entry snapshots ONE file, read by its sole role rather than by the name
 * {@link LedgerFile}: a ledger keeps its id across the move onto a root, and
 * entries the domain recorded before (the prototypes picks store wrote
 * `picks`, not `file`) are pending in the same per-namespace ledger — the same
 * one-file snapshot, under another role name. Anything but one role is not a
 * root's entry, and throws (the ledger reports it `failed`).
 */
export async function restoreLedgerEntry(
  entry: AgentWriteLedgerEntry<LedgerFile>,
): Promise<void> {
  // The stored roles are the ledger's own file, taken on trust there: read
  // them as recorded, not as typed.
  const paths: Readonly<Record<string, string>> = entry.paths;
  const roles = Object.keys(paths);
  if (roles.length !== 1) {
    throw new Error(
      `[data-files] ledger entry "${entry.key}" snapshots ${roles.length === 0 ? "no file" : `roles ${roles.join(", ")}`} — a root's entry snapshots exactly one file`,
    );
  }
  const role = roles[0]!;
  const before = (entry.before as Readonly<Record<string, FileSnapshotOf>>)[
    role
  ];
  const path = paths[role]!;
  if (before === undefined) {
    throw new Error(
      `[data-files] ledger entry "${entry.key}" has no "before" snapshot for its role "${role}"`,
    );
  }
  if (before.present) {
    await writeRawAtomic(path, before.bytes);
    return;
  }
  await unlink(path).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  });
}

type FileSnapshotOf = AgentWriteLedgerEntry<LedgerFile>["before"][LedgerFile];
