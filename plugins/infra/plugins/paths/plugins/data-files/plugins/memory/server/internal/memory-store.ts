import {
  isWithinRel,
  parseRelPath,
  relName,
  relParent,
  type DataChangeHandler,
  type FileData,
  type FileEntry,
  type RelPath,
} from "@plugins/infra/plugins/paths/plugins/data-files/core";
import {
  assertNotRoot,
  requireWatchSpec,
  watchedPaths,
  type DataFilesImpl,
  type FileRoot,
  type FileRootSpec,
  type FileRootStore,
} from "@plugins/infra/plugins/paths/plugins/data-files/server";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { createCoalescer } from "@plugins/packages/plugins/coalesce/core";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";

type Node =
  | { kind: "file"; blob: Blob; mtimeMs: number; birthtimeMs: number }
  | { kind: "dir"; mtimeMs: number; birthtimeMs: number };

/** One root's tree: every path to its node, the root itself at `""` once it exists. */
type Tree = Map<RelPath, Node>;

function toBlob(data: FileData): Blob {
  if (data instanceof Blob) return data;
  return new Blob([data as BlobPart]);
}

/**
 * Files in memory, lost with the process: a browser host's store (the demo
 * resets on reload). Directories come into being as a write's parents and stay
 * until removed — exactly as on disk, so an emptied directory still lists as
 * empty rather than missing.
 *
 * Every timestamp comes from one monotonic clock, so two writes in the same
 * millisecond still read as two changes. Locks are an in-process FIFO per key
 * (there is no other process). A watch hears every mutation: each microtask's
 * mutations reach a subscriber as ONE `changed`, through a coalescer, and never
 * a `rescan` — a store with no out-of-band writer drops no event.
 */
export function createMemoryDataFiles(): DataFilesImpl {
  const trees = new Map<string, Tree>();
  const subscribers = new Map<string, Set<(paths: RelPath[]) => void>>();
  const pending = new Map<string, Set<RelPath>>();
  const locks = createKeyedMutex();
  const stores = new Map<string, FileRootStore>();
  let clock = 0;
  const now = (): number => (clock = Math.max(Date.now(), clock + 1));

  function treeOf(spec: FileRootSpec): Tree {
    let tree = trees.get(spec.id);
    if (tree === undefined) {
      tree = new Map();
      trees.set(spec.id, tree);
    }
    return tree;
  }

  function entryOf(path: RelPath, node: Node): FileEntry {
    return {
      name: path === "" ? "" : relName(path),
      kind: node.kind,
      size: node.kind === "file" ? node.blob.size : 0,
      mtimeMs: node.mtimeMs,
      birthtimeMs: node.birthtimeMs,
    };
  }

  /** Children of `dir`, by path. */
  function childrenOf(tree: Tree, dir: RelPath): RelPath[] {
    const out: RelPath[] = [];
    for (const path of tree.keys()) {
      if (path !== "" && relParent(path) === dir) out.push(path);
    }
    return out;
  }

  /** Touch a directory's mtime: an entry inside it was added or removed. */
  function touch(tree: Tree, dir: RelPath): void {
    const node = tree.get(dir);
    if (node !== undefined) node.mtimeMs = now();
  }

  /** Create `dir` and its missing ancestors; a file in the way throws. */
  function ensureDir(spec: FileRootSpec, tree: Tree, dir: RelPath): void {
    const node = tree.get(dir);
    if (node?.kind === "dir") return;
    if (node?.kind === "file") {
      throw new Error(
        `[data-files] "${dir}" in "${spec.id}" is a file, not a directory`,
      );
    }
    if (dir !== "") ensureDir(spec, tree, relParent(dir));
    const t = now();
    tree.set(dir, { kind: "dir", mtimeMs: t, birthtimeMs: t });
    if (dir !== "") touch(tree, relParent(dir));
  }

  function changed(spec: FileRootSpec, paths: Iterable<RelPath>): void {
    const subs = subscribers.get(spec.id);
    if (subs === undefined || subs.size === 0) return;
    const reported = watchedPaths(spec, paths);
    if (reported.length === 0) return;
    let batch = pending.get(spec.id);
    if (batch === undefined) {
      batch = new Set();
      pending.set(spec.id, batch);
      queueMicrotask(() => {
        const paths = [...(pending.get(spec.id) ?? [])];
        pending.delete(spec.id);
        for (const sub of subscribers.get(spec.id) ?? []) sub(paths);
      });
    }
    for (const path of reported) batch.add(path);
  }

  function open(spec: FileRootSpec): FileRootStore {
    const tree = (): Tree => treeOf(spec);
    return {
      async list(dir) {
        const node = tree().get(dir);
        if (node === undefined) return { kind: "missing" };
        if (node.kind === "file") {
          throw new Error(
            `[data-files] list of "${dir}" in "${spec.id}": a file, not a directory`,
          );
        }
        const t = tree();
        const entries = childrenOf(t, dir)
          .sort()
          .map((path) => entryOf(path, t.get(path)!));
        return { kind: "listed", entries };
      },
      async stat(path) {
        const node = tree().get(path);
        if (node === undefined) return { kind: "missing" };
        return { kind: "found", entry: entryOf(path, node) };
      },
      async read(path) {
        const node = tree().get(path);
        if (node === undefined) return { kind: "missing" };
        if (node.kind === "dir") {
          throw new Error(
            `[data-files] read of "${path}" in "${spec.id}": a directory, not a file`,
          );
        }
        return { kind: "file", blob: node.blob, entry: entryOf(path, node) };
      },
      async write(path, data, _opts) {
        assertNotRoot(spec, path, "write");
        const t = tree();
        const existing = t.get(path);
        if (existing?.kind === "dir") {
          throw new Error(
            `[data-files] write of "${path}" in "${spec.id}": a directory is there`,
          );
        }
        ensureDir(spec, t, relParent(path));
        const blob = toBlob(data);
        const at = now();
        t.set(path, {
          kind: "file",
          blob,
          mtimeMs: at,
          birthtimeMs: existing?.birthtimeMs ?? at,
        });
        if (existing === undefined) touch(t, relParent(path));
        changed(spec, [path]);
      },
      async remove(path, opts) {
        assertNotRoot(spec, path, "remove");
        const t = tree();
        const node = t.get(path);
        if (node === undefined) return;
        const below = [...t.keys()].filter(
          (p) => p !== path && isWithinRel(p, path),
        );
        if (node.kind === "dir" && below.length > 0 && !opts.recursive) {
          throw new Error(
            `[data-files] remove of "${path}" in "${spec.id}": a non-empty directory — pass recursive: true`,
          );
        }
        for (const p of below) t.delete(p);
        t.delete(path);
        touch(t, relParent(path));
        changed(spec, [path, ...below]);
      },
      async rename(from, to, _opts) {
        assertNotRoot(spec, from, "rename");
        assertNotRoot(spec, to, "rename");
        if (isWithinRel(to, from)) {
          throw new Error(
            `[data-files] rename of "${from}" into itself ("${to}") in "${spec.id}"`,
          );
        }
        const t = tree();
        if (!t.has(from)) return "missing";
        if (t.has(to)) return "target-exists";
        ensureDir(spec, t, relParent(to));
        const moved = [...t.keys()].filter((p) => isWithinRel(p, from));
        const paths: RelPath[] = [];
        for (const p of moved) {
          const dest = (to + p.slice(from.length)) as RelPath;
          t.set(dest, t.get(p)!);
          t.delete(p);
          paths.push(p, dest);
        }
        touch(t, relParent(from));
        touch(t, relParent(to));
        changed(spec, paths);
        return "renamed";
      },
      withLock: (key, fn) => locks.run(`${spec.id}\0${key}`, fn),
      async watch(onChange: DataChangeHandler) {
        requireWatchSpec(spec);
        const reactions = createCoalescer<RelPath>({
          run: async (items) => {
            await onChange({ kind: "changed", paths: [...new Set(items)] });
          },
        });
        const sub = (paths: RelPath[]): void => reactions.trigger(paths);
        let set = subscribers.get(spec.id);
        if (set === undefined) {
          set = new Set();
          subscribers.set(spec.id, set);
        }
        set.add(sub);
        return {
          async dispose() {
            subscribers.get(spec.id)?.delete(sub);
            await reactions.idle();
          },
        };
      },
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

/** The store this host boots — one per process. */
export const memoryDataFiles = createMemoryDataFiles();

/**
 * Put files into a root, each path `/`-separated inside it
 * (`"demo-1/index.html"`) — a demo seed's write, through the root's own `write`
 * like any other (watchers hear it), so it lands in whichever store the host
 * booted. Text is UTF-8.
 */
export async function seedFiles(
  root: FileRoot,
  files: Readonly<Record<string, FileData>>,
): Promise<void> {
  for (const [path, data] of Object.entries(files)) {
    await root.write(parseRelPath(path), data, {
      writer: systemOrigin("data-files seed"),
    });
  }
}
