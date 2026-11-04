/**
 * Build-scoped, read-once in-memory filesystem snapshot.
 *
 * A facet-extraction pass over the whole plugin tree re-reads every source file
 * multiple times (once per file-walking facet) via synchronous `readFileSync` /
 * `readdirSync`, monopolizing the single event loop. When a snapshot is in
 * effect (see `runWithFsSnapshot`), `readIfExists` / `walkFiles` / `pathExists`
 * answer from these maps instead of disk — so the (still-synchronous) facet
 * `extract()` functions touch zero disk. The snapshot is built once,
 * asynchronously and in parallel, before the extract loop.
 *
 * - `files`: absolute path → file content. Only *existing* files are present.
 * - `dirs`:  absolute directory path → its entries, shaped like
 *            `readdir(withFileTypes)`'s. Presence of a directory key means "this
 *            directory was scanned", so a path whose directory is keyed but which
 *            is not among its entries is absent — answered with no syscall.
 */
export interface FsSnapshot {
  files: Map<string, string>;
  dirs: Map<string, SnapshotDirEntry[]>;
  /**
   * Set while plugin records are being made: the snapshot holds exactly the
   * files a record is keyed by, so a read that falls outside it would make the
   * record depend on a file its key does not name — it THROWS instead of asking
   * the disk. The value says what the snapshot covers, for the message.
   */
  strict?: string;
}

/**
 * One entry of a snapshot directory: the slice of a `Dirent` the scanners read.
 * Derived from the repo's file list, not from `readdir` — a directory is listed
 * when it holds at least one file of the set.
 */
export interface SnapshotDirEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

// Ambient snapshot, set synchronously around each (synchronous) facet
// extract/relate call by `runWithFsSnapshot`. Build-time callers that invoke the
// scanners directly (codegen/checks) never set it, so they keep the byte-for-byte
// sync-disk behavior.
let activeSnapshot: FsSnapshot | null = null;

/**
 * Run `fn` with `snapshot` as the ambient FS snapshot consulted by `readIfExists`
 * / `walkFiles` / `pathExists`, and scoping the pure-transform memos below. `fn`
 * MUST be synchronous (no `await`) — the ambient is restored synchronously on
 * return, so even interleaved concurrent builds never observe each other's
 * snapshot. Pass `null` to force the sync-disk path.
 */
export function runWithFsSnapshot<T>(
  snapshot: FsSnapshot | null,
  fn: () => T,
): T {
  const prev = activeSnapshot;
  activeSnapshot = snapshot;
  try {
    return fn();
  } finally {
    activeSnapshot = prev;
  }
}

export function currentFsSnapshot(): FsSnapshot | null {
  return activeSnapshot;
}

/**
 * Called by a helper about to answer `path` from the disk because the ambient
 * snapshot does not cover it: throws under a strict snapshot (see
 * {@link FsSnapshot.strict}).
 */
export function assertDiskReadAllowed(path: string): void {
  if (activeSnapshot?.strict === undefined) return;
  throw new Error(
    `[facets] ${path} is outside the files this extraction may read (${activeSnapshot.strict}). ` +
      "A facet's extract is cached per plugin, keyed by that plugin's own files: " +
      "read another plugin's files in `relate`, or name the input in an `extractBatch`.",
  );
}

/**
 * Whether `path` exists, as far as the ambient snapshot can tell: `true` /
 * `false` when its directory (or itself) was scanned, `undefined` when it lies
 * outside the snapshot (the caller asks the disk).
 */
export function snapshotHas(path: string): boolean | undefined {
  if (!activeSnapshot) return undefined;
  if (activeSnapshot.files.has(path) || activeSnapshot.dirs.has(path))
    return true;
  // The snapshot's keys are absolute `/`-joined paths (`path.join`), so the
  // parent and name split at the last `/` — any other spelling would read as
  // "absent" instead of asking the disk.
  if (!path.startsWith("/") || path.endsWith("/"))
    throw new Error(
      `snapshotHas(${JSON.stringify(path)}): expected an absolute path with no trailing "/".`,
    );
  const cut = path.lastIndexOf("/");
  const parent = path.slice(0, cut);
  const siblings = activeSnapshot.dirs.get(parent);
  // A parent the snapshot knows is absent holds nothing: absent too, however
  // deep (a plugin's missing `machine/` has no `index.ts`).
  if (!siblings)
    return cut > 0 && snapshotHas(parent) === false ? false : undefined;
  const name = path.slice(cut + 1);
  return siblings.some((e) => e.name === name);
}

// One memo per pure transform, per snapshot: every facet of a build masks or
// strips the same files again (cross-refs alone masks a runtime file three
// times), and a file's content is one string object for the whole build, so a
// repeat is a cached-hash Map hit. Keyed by the snapshot so the memo dies with
// the build — nothing outlives the tree it was computed for.
const memos = new WeakMap<FsSnapshot, Map<string, Map<string, string>>>();

/**
 * `compute(src)` once per `(kind, src)` within the ambient snapshot; with no
 * snapshot in effect, just `compute(src)`. `compute` MUST be a pure function of
 * `src` — `kind` names it (and its options).
 */
export function memoInSnapshot(
  kind: string,
  src: string,
  compute: (src: string) => string,
): string {
  if (!activeSnapshot) return compute(src);
  let byKind = memos.get(activeSnapshot);
  if (!byKind) memos.set(activeSnapshot, (byKind = new Map()));
  let memo = byKind.get(kind);
  if (!memo) byKind.set(kind, (memo = new Map()));
  const hit = memo.get(src);
  if (hit !== undefined) return hit;
  const out = compute(src);
  memo.set(src, out);
  return out;
}
