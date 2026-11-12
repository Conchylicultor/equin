import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { yieldMacrotask } from "@plugins/packages/plugins/macrotask-yield/core";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
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
 * A record names its value by content, and a large directory's value is the
 * list of its members' values rather than a copy of them, so what an edit
 * writes is its own path, never the whole answer (see
 * {@link foldFilesCached}). The answer itself is materialized once per pass
 * for its reader: a fold is for an answer a reader wants whole (a verdict's
 * inputs), far smaller than the files. A reader that needs every file's own
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

/**
 * The largest value, in JSON characters, a record holds whole. A directory
 * whose members' values add up to more is recorded as the list of their refs
 * instead (see {@link foldFilesCached}), so no edit rewrites more than this
 * per directory it moves.
 */
const INLINE_LIMIT = 256 * 1024;

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
function treeOf(files: readonly string[]): TreeNode {
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
  return passThrough(root);
}

/**
 * The tree with every one-member directory replaced by its member: its fold is
 * its member's (`combine([a])` is `a`), so a record of its own would only
 * repeat the member's under another key. A chain of them — the repo root
 * holding only `plugins/` — would otherwise add a record per link on every
 * edit.
 */
function passThrough(node: TreeNode): TreeNode {
  if (node.kind === "file") return node;
  if (node.members.length === 1) return passThrough(node.members[0]!);
  node.members = node.members.map(passThrough);
  return node;
}

/**
 * A value's name: `<size>.<sha256 of its body>`. The size is a file's value's
 * JSON length, a directory's its members' sizes added up, so whether a
 * directory is held whole or as a list is decided from its members' refs
 * alone.
 */
type ValueRef = string;

/** A value's body as stored: `=<json>` held whole, or `+<ref> <ref> …` its members' refs. */
function refOf(size: number, body: string): ValueRef {
  return `${size}.${sha256Hex(body)}`;
}

function sizeOf(ref: ValueRef): number {
  return Number(ref.slice(0, ref.indexOf(".")));
}

/** Where a value's body is stored: one record per distinct value, whichever fold or node names it. */
function valueKey(ref: ValueRef): string {
  return recordKey("fold-value", ref);
}

/** The limits a fold is recorded under; a test lowers them to exercise lists on a small tree. */
export interface FoldLimits {
  /** See {@link INLINE_LIMIT}. */
  inlineLimit: number;
}

/**
 * `files` (repo-relative members of the set) scanned and folded into one
 * answer — `fold.combine([])` when there are none.
 *
 * Its records are the `fold` table's, in two kinds, so that what an edit
 * writes and what it reads are both bounded by what it moved:
 *
 * - a NODE record (a file, or a directory of 2+ members) is keyed by the
 *   file's blob — a directory's by its members' keys, a Merkle tree over the
 *   selected files — and holds only its value's {@link ValueRef};
 * - a VALUE record is keyed by that ref (its content), so a value is stored
 *   once however many nodes, edits or worktrees name it. A file's value, and
 *   a directory's whose members add up to at most the inline limit, is held
 *   whole; a larger directory's is the list of its members' refs, combined
 *   when the answer is read.
 *
 * A pass asks the node records top-down (one batch per depth; a hit names its
 * whole subtree's value), scans only the files whose blob has no record, and
 * folds only the directories that missed — from their members' refs alone
 * when they are lists, reading at most the inline limit when they are whole.
 * So an edit writes the edited path's node records (a ref each), plus the
 * values that actually changed — none when the edit leaves its file's part
 * as it was, and never more than the inline limit per directory, however
 * large the answer. Reading the answer itself reads its stored values: the
 * whole values and the lists they hang from.
 *
 * A scanner that throws stores nothing. From a file set with no blob ids,
 * every file is read and scanned, folded along the same tree, so both paths
 * answer the same.
 */
export async function foldFilesCached<C extends FoldContext, F>(
  input: ModuleGraphInput,
  files: readonly string[],
  fold: FileFold<C, F>,
  context: C,
  limits: FoldLimits = { inlineLimit: INLINE_LIMIT },
): Promise<F> {
  assertScanModule(fold.url);
  const repo = input.snapshot;
  const contextText = JSON.stringify(context);
  // What the scan sees is what the key holds: the context's JSON, read back.
  const seen = JSON.parse(contextText) as C;
  if (files.length === 0) return fold.combine([]);
  const root = treeOf(files);
  const scanAll = async (nodes: readonly FileNode[]): Promise<string[]> => {
    const out: string[] = [];
    // A cold store scans every file: read a window at a time (never the whole
    // tree's bytes at once), and yield every ~10 ms of CPU so a check pass
    // sharing this thread is not stalled behind it (a macrotask — see
    // yieldMacrotask).
    let lastYield = performance.now();
    for (let i = 0; i < nodes.length; i += READ_WINDOW) {
      const window = nodes.slice(i, i + READ_WINDOW);
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
        out.push(JSON.stringify(fold.scan(texts[k]!, node.rel, seen)));
      }
    }
    return out;
  };

  if (!isSnapshot(repo)) {
    const values = new Map<TreeNode, F>();
    const all: FileNode[] = [];
    const walk = (node: TreeNode): void => {
      if (node.kind === "file") all.push(node);
      else for (const m of node.members) walk(m);
    };
    walk(root);
    const texts = await scanAll(all);
    for (const [i, node] of all.entries())
      values.set(node, JSON.parse(texts[i]!) as F);
    const valueOf = (node: TreeNode): F =>
      node.kind === "file"
        ? values.get(node)!
        : fold.combine(node.members.map(valueOf));
    return valueOf(root);
  }

  const identity = await scannerIdentity(
    { ...input, snapshot: repo },
    fold.url,
  );
  // "fold-node": a node record holds a ref, never the value itself (as the
  // records under "fold" did), so the two can never be read for each other.
  // The limit decides the layout, so it keys it too.
  const base = recordKey(
    "fold-node",
    identity,
    contextText,
    String(limits.inlineLimit),
  );
  const keyOf = (node: TreeNode): string => {
    if (node.kind === "file")
      return (node.key = recordKey(base, node.rel, repo.blobOf(node.rel)));
    return (node.key = recordKey(base, node.path, ...node.members.map(keyOf)));
  };
  keyOf(root);

  // Every value read or made, by ref, and what this pass has to write.
  const bodies = new Map<ValueRef, string>();
  const fresh: [string, string][] = [];
  const store = (ref: ValueRef, body: string): void => {
    if (bodies.has(ref)) return;
    bodies.set(ref, body);
    fresh.push([valueKey(ref), body]);
  };
  /** Bodies of `wanted` not held yet, from the store; answers the refs it has no value for. */
  const readBodies = async (
    wanted: Iterable<ValueRef>,
  ): Promise<Set<ValueRef>> => {
    const missing = [...new Set(wanted)].filter((r) => !bodies.has(r));
    const lost = new Set<ValueRef>();
    if (missing.length === 0) return lost;
    const got = await input.store.getMany("fold", missing.map(valueKey));
    for (const ref of missing) {
      const body = got.get(valueKey(ref));
      if (body === undefined) lost.add(ref);
      else bodies.set(ref, body);
    }
    return lost;
  };
  const scanned = new Map<FileNode, string>();
  // Nodes whose record names a value the store no longer holds (reclaimed:
  // a value under a whole one is read only when a sibling is edited, so it
  // can go unread past the reclaim's window). Each is folded again as if it
  // had missed, which writes its value back; another pass of the loop then
  // runs with it, so a gap costs its own subtree, never a cold fold.
  const forced = new Set<TreeNode>();

  for (;;) {
    const refs = new Map<TreeNode, ValueRef>();
    // Top-down, one batch per depth: a hit names its whole subtree's value, a
    // directory that missed hands its members to the next batch.
    const toScan: FileNode[] = [];
    const missedDirs: DirNode[] = [];
    let level: TreeNode[] = [root];
    while (level.length > 0) {
      const got = await input.store.getMany(
        "fold",
        level.map((n) => n.key),
      );
      const next: TreeNode[] = [];
      for (const node of level) {
        const ref = forced.has(node) ? undefined : got.get(node.key);
        if (ref !== undefined) refs.set(node, ref);
        else if (node.kind === "file") toScan.push(node);
        else {
          missedDirs.push(node);
          next.push(...node.members);
        }
      }
      level = next;
    }

    // A file's size is its value's JSON length; a directory's, its members'
    // sizes added up — a function of the subtree's values alone, so a subtree
    // is recorded the same way whichever of its nodes a pass found stored.
    const unscanned = toScan.filter((n) => !scanned.has(n));
    for (const [i, text] of (await scanAll(unscanned)).entries())
      scanned.set(unscanned[i]!, text);
    for (const node of toScan) {
      const text = scanned.get(node)!;
      const body = `=${text}`;
      const ref = refOf(text.length, body);
      refs.set(node, ref);
      store(ref, body);
      fresh.push([node.key, ref]);
    }

    // The missed directories, deepest first. Sizes first, from the members'
    // refs alone: one too large to hold whole is the list of its members'
    // refs; the rest are combined, from members that are whole by
    // construction (a member is never larger than its directory) — read in
    // one batch.
    missedDirs.reverse();
    const sizes = new Map<DirNode, number>();
    const sizeAt = (node: TreeNode): number =>
      node.kind === "dir" && sizes.has(node)
        ? sizes.get(node)!
        : sizeOf(refs.get(node)!);
    const need = new Map<ValueRef, TreeNode[]>();
    for (const dir of missedDirs) {
      const size = dir.members.reduce((n, m) => n + sizeAt(m), 0);
      sizes.set(dir, size);
      if (size > limits.inlineLimit) continue;
      for (const m of dir.members) {
        const ref = refs.get(m);
        if (ref === undefined) continue;
        need.set(ref, [...(need.get(ref) ?? []), m]);
      }
    }
    const lostMembers = await readBodies(need.keys());
    if (lostMembers.size > 0) {
      for (const ref of lostMembers)
        for (const m of need.get(ref)!) forced.add(m);
      continue;
    }
    for (const dir of missedDirs) {
      const size = sizes.get(dir)!;
      const body =
        size > limits.inlineLimit
          ? `+${dir.members.map((m) => refs.get(m)!).join(" ")}`
          : `=${JSON.stringify(
              fold.combine(dir.members.map((m) => wholeValue(refs.get(m)!))),
            )}`;
      const ref = refOf(size, body);
      refs.set(dir, ref);
      store(ref, body);
      fresh.push([dir.key, ref]);
    }

    // The answer: the root's value, every list down to the whole values it
    // hangs from read a level at a time — a list's refs are its node's
    // members', in order — then combined bottom-up.
    let pending: [TreeNode, ValueRef][] = [[root, refs.get(root)!]];
    const lostNodes: TreeNode[] = [];
    while (pending.length > 0) {
      const lost = await readBodies(pending.map(([, ref]) => ref));
      const below: [TreeNode, ValueRef][] = [];
      for (const [node, ref] of pending) {
        if (lost.has(ref)) {
          lostNodes.push(node);
          continue;
        }
        const body = bodies.get(ref)!;
        if (!body.startsWith("+")) continue;
        const members = body.slice(1).split(" ");
        if (node.kind !== "dir" || node.members.length !== members.length)
          throw new Error(
            `[plugin-records] fold list ${ref} does not match its directory's members`,
          );
        for (const [i, member] of members.entries())
          below.push([node.members[i]!, member]);
      }
      pending = below;
    }
    if (lostNodes.length > 0) {
      for (const node of lostNodes) forced.add(node);
      continue;
    }

    if (fresh.length > 0) input.store.putMany("fold", fresh);
    const parsed = new Map<ValueRef, F>();
    const valueAt = (ref: ValueRef): F => {
      let value = parsed.get(ref);
      if (value !== undefined) return value;
      const body = bodies.get(ref)!;
      value = body.startsWith("+")
        ? fold.combine(body.slice(1).split(" ").map(valueAt))
        : (JSON.parse(body.slice(1)) as F);
      parsed.set(ref, value);
      return value;
    };
    return valueAt(refs.get(root)!);
  }

  function wholeValue(ref: ValueRef): F {
    const body = bodies.get(ref)!;
    if (!body.startsWith("="))
      throw new Error(`[plugin-records] fold value ${ref} is not held whole`);
    return JSON.parse(body.slice(1)) as F;
  }
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
