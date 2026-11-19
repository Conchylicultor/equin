import { Mutex, type PGliteOptions } from "@electric-sql/pglite";

/** PGlite's filesystem contract (not exported by name). */
type Filesystem = NonNullable<PGliteOptions["fs"]>;
type ModuleOptions = Parameters<Filesystem["init"]>[1];
type PostgresModule = Parameters<
  NonNullable<ModuleOptions["preRun"]>[number]
>[0];

/** What this module reads of an Emscripten node and stream. */
interface FsNode {
  mount: unknown;
}
interface FsStream {
  node: FsNode;
}
/** The part of Emscripten's FS this module wraps. */
type EmscriptenFs = PostgresModule["FS"];

/**
 * The FS calls that change what a persisting filesystem stores, by what
 * their first argument is. A file's bytes, size, mode or times — a stream's
 * `write` / `msync` / `allocate`, a node's or a path's `truncate` / `chmod` /
 * `utime` (every fd form — `ftruncate`, `fchmod`, `lchmod` — goes through
 * these) — and the namespace: `mknod` (every create and mkdir), `rename`,
 * `unlink`, `rmdir`, `symlink`, judged by the directory the entry is in.
 * Every other call (`read`, `open`, `stat`, `readdir`, `mmap` itself, …)
 * leaves the stored state as it was.
 */
const CHANGING_CALLS = {
  stream: ["write", "msync", "allocate"],
  nodeOrPath: ["truncate", "chmod", "utime"],
  entry: ["mknod", "rename", "unlink", "rmdir", "symlink"],
} as const;

function isFsNode(value: unknown): value is FsNode {
  return typeof value === "object" && value !== null && "mount" in value;
}

function isFsStream(value: unknown): value is FsStream {
  return (
    typeof value === "object" &&
    value !== null &&
    "node" in value &&
    isFsNode(value.node)
  );
}

/** The directory a path's entry is in (`symlink` names its new link second). */
function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return ".";
  return slash === 0 ? "/" : path.slice(0, slash);
}

/**
 * Reports every FS call that changes a file outside the in-memory root
 * filesystem — the data dir's mount (IDBFS in a browser, NODEFS on disk), not
 * `/tmp` or `/dev`. Wrapped at the FS calls every syscall goes through, so it
 * holds for every node whenever it was created and whatever order the
 * module's `preRun`s run in (Emscripten runs them last first). A path that
 * does not resolve counts as a change: the call is about to fail or create
 * it, and a spurious sync costs one walk while a missed one loses data.
 */
function trackChanges(fs: EmscriptenFs, onChange: () => void): void {
  // `FS.root` is the in-memory root (MEMFS); every mount under it is a
  // filesystem of its own.
  const inMemory = (node: FsNode): boolean => node.mount === fs.root.mount;
  const resolvesInMemory = (path: string): boolean => {
    try {
      return inMemory(fs.lookupPath(path, { follow: true }).node);
    } catch (err) {
      if (err instanceof fs.ErrnoError) return false;
      throw err;
    }
  };
  const changes = (kind: keyof typeof CHANGING_CALLS, args: unknown[]) => {
    const [first, second] = args;
    switch (kind) {
      case "stream":
        return !isFsStream(first) || !inMemory(first.node);
      case "nodeOrPath":
        if (isFsNode(first)) return !inMemory(first);
        return typeof first !== "string" || !resolvesInMemory(first);
      case "entry": {
        // Both path arguments: `rename` changes both directories;
        // `symlink(target, linkpath)` creates only its second, so its first
        // can only add a spurious sync.
        const paths = [first, second].filter(
          (p): p is string => typeof p === "string",
        );
        return (
          paths.length === 0 ||
          paths.some((p) => !resolvesInMemory(parentOf(p)))
        );
      }
    }
  };
  const calls: Record<string, unknown> = fs;
  for (const kind of Object.keys(
    CHANGING_CALLS,
  ) as (keyof typeof CHANGING_CALLS)[]) {
    for (const name of CHANGING_CALLS[kind]) {
      const call = calls[name];
      if (typeof call !== "function") {
        throw new Error(`[pglite] Emscripten's FS has no ${name} to track`);
      }
      calls[name] = (...args: unknown[]): unknown => {
        if (changes(kind, args)) onChange();
        return call.apply(fs, args);
      };
    }
  }
}

/**
 * A PGlite filesystem that writes back only what changed: `syncToFs` persists
 * through the wrapped filesystem when a file under its mounts changed since
 * the last sync, and does nothing otherwise.
 *
 * PGlite calls `syncToFs` after EVERY query outside a transaction, reads
 * included, and IDBFS's sync walks the whole data dir (a stat per file) and
 * every IndexedDB key to find what changed — ~60 ms of a ~120 ms read burst in
 * the demo's worker. Deciding here, from the filesystem's own writes, makes
 * "a read never writes back" true for every caller and every query shape (a
 * SELECT that prunes a page writes, and is synced; an INSERT is never
 * mistaken for a read), with nothing for a call site to declare.
 *
 * Syncs run one at a time, and a sync of a clean filesystem still waits for
 * the one in flight: when `syncToFs` resolves, every change made before the
 * call is persisted — what a flush promises its caller.
 */
export class WriteTrackedFs implements Filesystem {
  readonly #inner: Filesystem;
  readonly #mutex = new Mutex();
  #dirty = false;

  constructor(inner: Filesystem) {
    this.#inner = inner;
  }

  /** Whether a change is waiting for the next sync. */
  get dirty(): boolean {
    return this.#dirty;
  }

  init(
    ...[pg, options]: Parameters<Filesystem["init"]>
  ): ReturnType<Filesystem["init"]> {
    // Before Postgres runs, whatever the preRun order: nothing touches the
    // data dir until the module has run them all.
    return this.#inner.init(pg, {
      ...options,
      preRun: [
        ...(options.preRun ?? []),
        (mod: PostgresModule) => {
          trackChanges(mod.FS, () => {
            this.#dirty = true;
          });
        },
      ],
    });
  }

  async initialSyncFs(): Promise<void> {
    await this.#inner.initialSyncFs();
    // What it loaded IS the stored state.
    this.#dirty = false;
  }

  async syncToFs(relaxedDurability?: boolean): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      if (!this.#dirty) return;
      // Cleared first: a change made while the sync runs marks it again.
      this.#dirty = false;
      try {
        await this.#inner.syncToFs(relaxedDurability);
      } catch (err) {
        this.#dirty = true;
        throw err;
      }
    });
  }

  dumpTar(
    ...args: Parameters<Filesystem["dumpTar"]>
  ): ReturnType<Filesystem["dumpTar"]> {
    return this.#inner.dumpTar(...args);
  }

  closeFs(): Promise<void> {
    return this.#inner.closeFs();
  }
}
