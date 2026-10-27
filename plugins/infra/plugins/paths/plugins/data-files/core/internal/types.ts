import type { WriteOrigin } from "@plugins/infra/plugins/request-origin/core";
import type { RelPath } from "./rel-path";

/**
 * One entry of a file root, with `host-fs`'s field spellings (`HostFsEntry`)
 * where the two overlap — a root holds only files and directories.
 */
export interface FileEntry {
  name: string;
  kind: "file" | "dir";
  /** Bytes of a file; a directory's size is the host's and means nothing. */
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

/** Nothing at the path — a typed miss, never an absorbable `null`. */
export interface Missing {
  readonly kind: "missing";
}

export type StatResult = { readonly kind: "found"; entry: FileEntry } | Missing;

/** A missing directory is not an empty one: `listed` with `[]` is empty. */
export type ListResult =
  { readonly kind: "listed"; entries: readonly FileEntry[] } | Missing;

/**
 * A file's bytes as a `Blob` (streamed from disk on the desktop) and its entry
 * as it stood when it was read.
 */
export type ReadResult =
  { readonly kind: "file"; blob: Blob; entry: FileEntry } | Missing;

/**
 * A rename never replaces: `target-exists` when something is already at the
 * destination (a mint's uniqueness authority), `missing` when the source is
 * not there.
 */
export type RenameResult = "renamed" | "target-exists" | "missing";

/** What a write stores: text is UTF-8. */
export type FileData = Blob | Uint8Array | string;

/**
 * What a root's watch reports: paths (relative to the root) that moved, or —
 * when the watch reported dropped events (`onLost`) — "re-derive everything".
 */
export type DataChange =
  | { readonly kind: "changed"; paths: readonly RelPath[] }
  | { readonly kind: "rescan" };

/** A watch reaction. Return its work: reactions are coalesced, never detached. */
export type DataChangeHandler = (change: DataChange) => void | Promise<unknown>;

/** A live subscription. `dispose` resolves once nothing more is delivered. */
export interface DataWatch {
  dispose(): Promise<void>;
}

/** Every mutation names who caused it (agent-origin writes may be ledgered). */
export interface WriteOpts {
  writer: WriteOrigin;
}

export interface RemoveOpts extends WriteOpts {
  /** Required: removing a directory with what is inside it is never implied. */
  recursive: boolean;
}

/** `withLock` waited for its lock and never got it — another holder is wedged. */
export class LockBusyError extends Error {
  constructor(
    readonly key: string,
    readonly waitedMs: number,
  ) {
    super(
      `file-root lock "${key}" is held by another writer — still held after ${waitedMs / 1000}s`,
    );
    this.name = "LockBusyError";
  }
}

/**
 * A tree of files under one directory, addressed by {@link RelPath} — the
 * operations every host can provide (the desktop's disk, a browser host's
 * memory). There is no `mkdir` (writes create their parents) and no `exists`
 * (`stat` answers it, typed).
 */
export interface Mount {
  /** The entries of a directory. A file at `dir` throws. */
  list(dir: RelPath): Promise<ListResult>;
  stat(path: RelPath): Promise<StatResult>;
  /** A file's bytes. A directory at `path` throws. */
  read(path: RelPath): Promise<ReadResult>;
  /**
   * Replace (or create) a file — atomically: a reader sees the old bytes or the
   * new ones, never a mix. Missing parent directories are created. A directory
   * at `path`, or a file where a parent should be, throws. The root throws.
   */
  write(path: RelPath, data: FileData, opts: WriteOpts): Promise<void>;
  /**
   * Remove a file or a directory; nothing there is a no-op. A non-empty
   * directory without `recursive` throws. The root throws.
   */
  remove(path: RelPath, opts: RemoveOpts): Promise<void>;
  /**
   * Move a file or directory to `to`, creating `to`'s parents — never replacing
   * what is already there ({@link RenameResult}). `to` inside `from` throws.
   */
  rename(from: RelPath, to: RelPath, opts: WriteOpts): Promise<RenameResult>;
  /**
   * Run `fn` holding the exclusive lock named `key` — one holder at a time
   * across every process sharing the tree. Throws {@link LockBusyError} when it
   * cannot be had in bounded time.
   */
  withLock<T>(key: RelPath, fn: () => Promise<T>): Promise<T>;
}
