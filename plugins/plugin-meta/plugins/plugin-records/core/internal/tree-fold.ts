import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { yieldMacrotask } from "@plugins/packages/plugins/macrotask-yield/core";
import { assertScanModule, isSnapshot, scannerIdentity } from "./file-scans";
import { recordKey } from "./keys";
import { NO_OUTSIDE_FILES, type ModuleGraphInput } from "./module-graph";
import { currentRecordStore } from "./store";

/**
 * A per-file scan FOLDED into one answer — a check's violations, a set of
 * names — kept as records along the directory tree, so a pass after an edit
 * reads and recomputes only what the edit moved.
 *
 * Each file's part is a record keyed by its blob (as a {@link FileScan}'s is),
 * and each directory's fold of its members is a record keyed by its members'
 * keys: a Merkle tree over the selected files. An edit moves the keys of the
 * edited file and of its ancestor directories, nothing else, so a pass asks the
 * store top-down — the root, then the members of each directory that missed —
 * about the fan-out of the edited path's directories (tens of lookups, against
 * one per plugin for a flat read), and scans only the edited files. An
 * unchanged tree is one lookup.
 *
 * Use it where a reader wants a SMALL answer about every file (a verdict, a
 * summary): a directory's record holds its whole subtree's fold, written again
 * for every ancestor of an edit, so an answer as large as the files themselves
 * would be rewritten whole on each edit. A reader that needs every file's own
 * value is a {@link FileScan}.
 */
export interface FileFold<C, F> {
  /**
   * `import.meta.url` of the module defining the fold — its code IS the fold,
   * so its module Merkle key keys every record, as a {@link FileScan}'s does.
   * A `*.scan.ts` module holding only the fold and the code it runs.
   */
  url: string;
  /**
   * One file's part: a function of its bytes, its path and `context` — and of
   * nothing else, since that is all its record is keyed by.
   */
  scan(src: string, rel: string, context: C): F;
  /**
   * Parts merged, handed in path order (a directory's members sorted by
   * name). Folded per directory, so it must be associative —
   * `combine([combine([a, b]), c])` equals `combine([a, b, c])` — and
   * `combine([a])` equals `a`.
   */
  combine(parts: readonly F[]): F;
}

/**
 * What a fold reads besides each file: plain data, keyed by its JSON spelling.
 * The scan is handed that spelling parsed back, so it cannot see anything the
 * key does not hold.
 */
export type FoldContext =
  | string
  | number
  | boolean
  | null
  | readonly FoldContext[]
  | { readonly [key: string]: FoldContext };

/** Files read at once when scanning: a cold store scans the whole selection. */
const READ_WINDOW = 256;

interface FileNode {
  kind: "file";
  rel: string;
  key: string;
}
interface DirNode {
  kind: "dir";
  path: string;
  members: TreeNode[];
  key: string;
}
type TreeNode = FileNode | DirNode;

/** The selected files as a directory tree, members sorted by name. */
function treeOf(files: readonly string[]): DirNode {
  const root: DirNode = { kind: "dir", path: "", members: [], key: "" };
  const dirs = new Map<string, DirNode>([["", root]]);
  const dirAt = (path: string): DirNode => {
    let dir = dirs.get(path);
    if (dir) return dir;
    const slash = path.lastIndexOf("/");
    const parent = dirAt(slash < 0 ? "" : path.slice(0, slash));
    dir = { kind: "dir", path, members: [], key: "" };
    parent.members.push(dir);
    dirs.set(path, dir);
    return dir;
  };
  for (const rel of new Set(files)) {
    const slash = rel.lastIndexOf("/");
    dirAt(slash < 0 ? "" : rel.slice(0, slash)).members.push({
      kind: "file",
      rel,
      key: "",
    });
  }
  const nameOf = (n: TreeNode): string => (n.kind === "file" ? n.rel : n.path);
  for (const dir of dirs.values())
    dir.members.sort((a, b) =>
      nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0,
    );
  return root;
}

/**
 * `files` (repo-relative members of the set) scanned and folded into one
 * answer — `fold.combine([])` when there are none.
 *
 * Its records are the `fold` table's. A scanner that throws stores nothing.
 * From a file set with no blob ids, every file is read and scanned, folded
 * along the same tree, so both paths answer the same.
 */
export async function foldFilesCached<C extends FoldContext, F>(
  input: ModuleGraphInput,
  files: readonly string[],
  fold: FileFold<C, F>,
  context: C,
): Promise<F> {
  assertScanModule(fold.url);
  const repo = input.snapshot;
  const contextText = JSON.stringify(context);
  // What the scan sees is what the key holds: the context's JSON, read back.
  const seen = JSON.parse(contextText) as C;
  const spell = (value: F): string => JSON.stringify(value);
  const root = treeOf(files);
  if (root.members.length === 0) return fold.combine([]);

  const values = new Map<TreeNode, F>();
  const toScan: FileNode[] = [];
  const missedDirs: DirNode[] = [];

  if (isSnapshot(repo)) {
    const identity = await scannerIdentity(
      { ...input, snapshot: repo },
      fold.url,
    );
    const base = recordKey("fold", identity, contextText);
    const keyOf = (node: TreeNode): string => {
      if (node.kind === "file")
        return (node.key = recordKey(base, node.rel, repo.blobOf(node.rel)));
      return (node.key = recordKey(
        base,
        node.path,
        ...node.members.map(keyOf),
      ));
    };
    keyOf(root);
    // Top-down, one batch per depth: a hit answers its whole subtree, a
    // directory that missed hands its members to the next batch.
    let level: TreeNode[] = [root];
    while (level.length > 0) {
      const got = await input.store.getMany(
        "fold",
        level.map((n) => n.key),
      );
      const next: TreeNode[] = [];
      for (const node of level) {
        const text = got.get(node.key);
        if (text !== undefined) values.set(node, JSON.parse(text) as F);
        else if (node.kind === "file") toScan.push(node);
        else {
          missedDirs.push(node);
          next.push(...node.members);
        }
      }
      level = next;
    }
  } else {
    const all = (dir: DirNode): void => {
      missedDirs.push(dir);
      for (const m of dir.members)
        if (m.kind === "file") toScan.push(m);
        else all(m);
    };
    all(root);
  }

  const fresh: [string, string][] = [];
  // A cold store scans every file: read a window at a time (never the whole
  // tree's bytes at once), and yield every ~10 ms of CPU so a check pass
  // sharing this thread is not stalled behind it (a macrotask — see
  // yieldMacrotask).
  let lastYield = performance.now();
  for (let i = 0; i < toScan.length; i += READ_WINDOW) {
    const window = toScan.slice(i, i + READ_WINDOW);
    const texts = await Promise.all(
      window.map(async (node) => {
        const src = await repo.read(node.rel);
        if (src === null)
          throw new Error(
            `[plugin-records] cannot read ${node.rel} to fold it`,
          );
        return src;
      }),
    );
    for (const [k, node] of window.entries()) {
      if (performance.now() - lastYield > 10) {
        await yieldMacrotask();
        lastYield = performance.now();
      }
      const text = spell(fold.scan(texts[k]!, node.rel, seen));
      values.set(node, JSON.parse(text) as F);
      if (node.key !== "") fresh.push([node.key, text]);
    }
  }
  // Deepest first, so every member is folded before its directory.
  for (const dir of missedDirs.reverse()) {
    const text = spell(fold.combine(dir.members.map((m) => values.get(m)!)));
    values.set(dir, JSON.parse(text) as F);
    if (dir.key !== "") fresh.push([dir.key, text]);
  }
  if (fresh.length > 0) input.store.putMany("fold", fresh);
  return values.get(root)!;
}

/**
 * `files` (members of `repo`) folded as records of the process's installed
 * store ({@link currentRecordStore}): the one-call form, as
 * {@link scanRepoFiles} is for a scan.
 */
export function foldRepoFiles<C extends FoldContext, F>(
  repo: RepoFiles,
  files: readonly string[],
  fold: FileFold<C, F>,
  context: C,
): Promise<F> {
  return foldFilesCached(
    {
      snapshot: repo,
      store: currentRecordStore(),
      readOutside: NO_OUTSIDE_FILES,
    },
    files,
    fold,
    context,
  );
}
