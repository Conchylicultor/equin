// Content-addressed `git grep -l` selections for a check run.
//
// Every grep-based check narrows its candidates with `git grep -l <pattern>
// <tree> -- <pathspecs>`: ~90 of them per pass, each decompressing every blob
// under its pathspecs (~116 MB, ~2.5 CPU-s) when run as git. Whether a blob
// matches a pattern is a pure function of (git's version, the pattern, -E/-F,
// the blob's bytes), and the blob id names the bytes; whether a pathspec names
// a file is a function of its path. So a selection over a git TREE is a pure
// function of (query, pathspecs, the tree's id) — and git's trees are already
// a Merkle tree over the directories.
//
// A selection is therefore folded along that tree, host-wide:
//   - a DIRECTORY record, keyed by (query, pathspecs, its path, its tree id),
//     holds the names of its own files that are selected and, for each
//     sub-directory with a selected file somewhere below, the sub-directory's
//     name and tree id — the key of the child's own record, never a copy of
//     its answer. An edit writes one record per directory on its path: O(depth)
//     new bytes, not the subtree's answer again for every ancestor;
//   - a selection walks the records down from the run's root tree, entering
//     only directories with a selected file below: an unchanged tree reads only
//     records (no git), an edit reads only the tree objects of the directories
//     whose id moved;
//   - inside a directory whose record is missing, the work is per file and
//     shared: which of its files the pathspecs name (a MEMBERSHIP record keyed
//     by (pathspecs, its path, its file names) — an edited file's content never
//     re-asks it), and whether each named blob matches (the per-blob answers,
//     shared by every directory, worktree and path holding those bytes).
//
// git stays the only authority on both halves of a selection, so a selection
// read from the index is the one `git grep` would have printed:
//   - WHICH files a pathspec names: `git ls-files -s` over a scratch index of
//     just the files asked about (git's own pathspec matcher, no file read);
//   - WHETHER one matches: `git grep -l` itself, run over the unknown blobs only
//     (by `:(literal)` path when they are few, else the whole query, whose
//     output is then checked to lie inside the domain git lists for it).

import { z } from "zod";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import { sliceCheckThread } from "./source-work";
import {
  filterPathspec,
  listTreePathspec,
  readTreeObjects,
  type TreeFileEntry,
  type TreeObject,
} from "./tree-hash";

/** One folded record's address: a directory, and the id of what it holds. */
export interface FoldKey {
  /** The directory's path from the tree's root (`""` for the root). */
  path: string;
  /** A tree id, or a digest of the directory's file names. */
  id: string;
}

/** The host-wide answers. Opened by the check command. */
export interface GrepIndexStore {
  /** The recorded answers of `query` for `blobs` (a blob with none is absent). */
  answers(query: string, blobs: readonly string[]): Map<string, boolean>;
  /** Record answers; one already present keeps its value (it is the same). */
  record(
    query: string,
    answers: ReadonlyArray<readonly [blob: string, matched: boolean]>,
  ): void;
  /**
   * The recorded folds of `scope` at `keys`, by `foldKeyOf` (a key with none
   * is absent). Values are opaque to the store.
   */
  folds(scope: string, keys: readonly FoldKey[]): Map<string, string>;
  /** Record folds; one already present keeps its value (it is the same). */
  recordFolds(
    scope: string,
    folds: ReadonlyArray<readonly [key: FoldKey, value: string]>,
  ): void;
}

/** The map key `GrepIndexStore.folds` answers by. */
export function foldKeyOf(key: FoldKey): string {
  return `${key.path}\0${key.id}`;
}

/** One run's selections over one tree. */
export interface GrepIndex {
  /** The checkout whose tree it selects from. */
  readonly root: string;
  /** `git grep -l` of `grepArg` over the run's tree, scoped by `pathspecs`. */
  select(
    grepArg: string,
    fixed: boolean,
    pathspecs: readonly string[],
  ): Promise<string[]>;
}

/** Keys asked of the store per synchronous call (see `select`). */
const LOOKUP_SLICE = 1000;

/** Above this many unknown blobs, the whole query runs instead of a literal list. */
const LITERAL_LIMIT = 256;

/**
 * Bumped when a recorded answer may be wrong. 2: domains listed excluded files
 * (`listTreePathspec` let a leading-`**` exclude through), and a whole-tree
 * grep then recorded "no match" for a matching blob it was told to skip.
 */
const ANSWERS_VERSION = 2;

/** Bumped when a directory or membership record's meaning changes. */
const FOLD_VERSION = 1;

/**
 * A directory's record: its own selected files, and the sub-directories with a
 * selected file below, each by the tree id that keys its own record.
 */
const DirFold = z.object({
  f: z.array(z.string()),
  d: z.array(z.tuple([z.string(), z.string()])),
});
type DirFold = z.infer<typeof DirFold>;

/** A directory's membership record: the names of its files the pathspecs name. */
const Members = z.array(z.string());

const joinPath = (dir: string, name: string): string =>
  dir === "" ? name : `${dir}/${name}`;

/** Order by path, the way git's index lists it (bytewise for ASCII). */
const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The index of one run: `tree` (the run's tree hash, what every check scans) in
 * the checkout at `root`.
 */
export function createGrepIndex(opts: {
  root: AppPath;
  tree: string;
  store: GrepIndexStore;
  /** Runs a full `git grep -l` over the tree — the same plumbing every check uses. */
  grepTree: (
    grepArg: string,
    fixed: boolean,
    pathspecs: string[],
  ) => Promise<string[]>;
}): GrepIndex {
  const { root, tree, store, grepTree } = opts;
  let version: Promise<string> | null = null;
  // Tree objects read this run, shared by every selection: an edit's path is
  // read once, not once per query.
  const treeObjects = new Map<string, Promise<TreeObject>>();
  // Membership answers this run, per (pathspecs, directory): shared by every
  // query over the same pathspecs.
  const memberships = new Map<string, Promise<ReadonlySet<string>>>();
  // A whole-tree domain, listed only for a whole-query grep (see `grepWhole`).
  const domains = new Map<string, Promise<ReadonlySet<string>>>();

  const readTrees = async (
    ids: readonly string[],
  ): Promise<Map<string, TreeObject>> => {
    const missing = [...new Set(ids)].filter((id) => !treeObjects.has(id));
    if (missing.length > 0) {
      const batch = readTreeObjects(root, missing);
      for (const id of missing)
        treeObjects.set(
          id,
          batch.then((read) => {
            const object = read.get(id);
            if (object === undefined)
              throw new Error(`grep-index: tree ${id} was not read`);
            return object;
          }),
        );
    }
    const out = new Map<string, TreeObject>();
    for (const id of ids) out.set(id, await treeObjects.get(id)!);
    return out;
  };

  /** Lookups in slices, the thread yielding between them. */
  const foldsOf = async (
    scope: string,
    keys: readonly FoldKey[],
  ): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    for (let i = 0; i < keys.length; i += LOOKUP_SLICE) {
      await sliceCheckThread();
      for (const [k, v] of store.folds(scope, keys.slice(i, i + LOOKUP_SLICE)))
        out.set(k, v);
    }
    return out;
  };

  /**
   * Which files of each directory the pathspecs name. Recorded per directory
   * by its file names; the ones no run recorded are asked of git in one call.
   */
  const membersOf = async (
    pathspecs: readonly string[],
    dirs: ReadonlyArray<{ path: string; object: TreeObject }>,
  ): Promise<Map<string, ReadonlySet<string>>> => {
    const specKey = JSON.stringify([FOLD_VERSION, "members", pathspecs]);
    const keyOf = (d: { path: string; object: TreeObject }): FoldKey => ({
      path: d.path,
      id: sha256Hex(
        d.object.files
          .map((f) => `${f.mode} ${f.name}`)
          .sort(byPath)
          .join("\0"),
      ),
    });
    const fresh = dirs.filter((d) => !memberships.has(`${specKey}\0${d.path}`));
    if (fresh.length > 0) {
      const keys = fresh.map(keyOf);
      const answered = foldsOf(specKey, keys).then(async (recorded) => {
        const asked: TreeFileEntry[] = [];
        const unknown: number[] = [];
        fresh.forEach((d, i) => {
          if (recorded.has(foldKeyOf(keys[i]!))) return;
          unknown.push(i);
          for (const f of d.object.files)
            asked.push({
              path: joinPath(d.path, f.name),
              mode: f.mode,
              blob: f.blob,
            });
        });
        const named = new Set(
          (await filterPathspec(root, asked, pathspecs)).map((e) => e.path),
        );
        const learned: Array<readonly [FoldKey, string]> = [];
        for (const i of unknown) {
          const d = fresh[i]!;
          const members = d.object.files
            .map((f) => f.name)
            .filter((name) => named.has(joinPath(d.path, name)));
          const value = JSON.stringify(members);
          recorded.set(foldKeyOf(keys[i]!), value);
          learned.push([keys[i]!, value]);
        }
        if (learned.length > 0) store.recordFolds(specKey, learned);
        return recorded;
      });
      fresh.forEach((d, i) =>
        memberships.set(
          `${specKey}\0${d.path}`,
          answered.then(
            (recorded) =>
              new Set(
                Members.parse(JSON.parse(recorded.get(foldKeyOf(keys[i]!))!)),
              ),
          ),
        ),
      );
    }
    const out = new Map<string, ReadonlySet<string>>();
    for (const d of dirs)
      out.set(d.path, await memberships.get(`${specKey}\0${d.path}`)!);
    return out;
  };

  return {
    root,
    async select(grepArg, fixed, pathspecs) {
      version ??= gitVersion(root);
      const query = sha256Hex(
        JSON.stringify([
          ANSWERS_VERSION,
          await version,
          fixed ? "-F" : "-E",
          grepArg,
        ]),
      );
      const scope = JSON.stringify([FOLD_VERSION, query, pathspecs]);

      // Walk the records down from the root, a level at a time. A recorded
      // directory contributes its files and sends the walk into its listed
      // sub-directories only; a missing one is read as a tree object and
      // every sub-directory of it is visited.
      const selected: string[] = [];
      const folded = new Map<string, DirFold>(); // by directory path
      const missed: Array<{ path: string; tree: string; object: TreeObject }> =
        [];
      let level: FoldKey[] = [{ path: "", id: tree }];
      while (level.length > 0) {
        const recorded = await foldsOf(scope, level);
        const next: FoldKey[] = [];
        const unrecorded: FoldKey[] = [];
        for (const key of level) {
          const value = recorded.get(foldKeyOf(key));
          if (value === undefined) {
            unrecorded.push(key);
            continue;
          }
          const fold = DirFold.parse(JSON.parse(value));
          folded.set(key.path, fold);
          for (const name of fold.f) selected.push(joinPath(key.path, name));
          for (const [name, id] of fold.d)
            next.push({ path: joinPath(key.path, name), id });
        }
        if (unrecorded.length > 0) {
          const objects = await readTrees(unrecorded.map((k) => k.id));
          for (const key of unrecorded) {
            const object = objects.get(key.id)!;
            missed.push({ path: key.path, tree: key.id, object });
            for (const [name, id] of object.dirs)
              next.push({ path: joinPath(key.path, name), id });
          }
        }
        level = next;
      }
      if (missed.length === 0) return selected.sort(byPath);

      // The missed directories' own files: which are named, then which match.
      const members = await membersOf(pathspecs, missed);
      const domain: Array<{ path: string; blob: string }> = [];
      for (const d of missed) {
        const named = members.get(d.path)!;
        for (const f of d.object.files)
          if (named.has(f.name))
            domain.push({ path: joinPath(d.path, f.name), blob: f.blob });
      }
      const matched = await matchedBlobs(
        query,
        grepArg,
        fixed,
        pathspecs,
        domain,
      );

      // Fold the missed directories bottom-up (deepest first), each listing
      // the sub-directories with a selected file below.
      const recordedNow: Array<readonly [FoldKey, string]> = [];
      for (const d of [...missed].sort(
        (a, b) => depthOf(b.path) - depthOf(a.path),
      )) {
        const named = members.get(d.path)!;
        const fold: DirFold = {
          f: d.object.files
            .filter((f) => named.has(f.name) && matched.get(f.blob) === true)
            .map((f) => f.name),
          d: d.object.dirs.filter(([name]) => {
            const child = folded.get(joinPath(d.path, name));
            if (child === undefined)
              throw new Error(
                `grep-index: ${joinPath(d.path, name)} was not folded before its parent`,
              );
            return child.f.length > 0 || child.d.length > 0;
          }),
        };
        folded.set(d.path, fold);
        for (const name of fold.f) selected.push(joinPath(d.path, name));
        recordedNow.push([{ path: d.path, id: d.tree }, JSON.stringify(fold)]);
      }
      for (let i = 0; i < recordedNow.length; i += LOOKUP_SLICE) {
        await sliceCheckThread();
        store.recordFolds(scope, recordedNow.slice(i, i + LOOKUP_SLICE));
      }
      await sliceCheckThread();
      return selected.sort(byPath);
    },
  };

  /** Whether each blob of `domain` matches: recorded, else grepped and recorded. */
  async function matchedBlobs(
    query: string,
    grepArg: string,
    fixed: boolean,
    pathspecs: readonly string[],
    domain: ReadonlyArray<{ path: string; blob: string }>,
  ): Promise<Map<string, boolean>> {
    const blobs = [...new Set(domain.map((e) => e.blob))];
    const known = new Map<string, boolean>();
    for (let i = 0; i < blobs.length; i += LOOKUP_SLICE) {
      await sliceCheckThread();
      for (const [blob, matched] of store.answers(
        query,
        blobs.slice(i, i + LOOKUP_SLICE),
      ))
        known.set(blob, matched);
    }
    const unknown = domain.filter((e) => !known.has(e.blob));
    if (unknown.length === 0) return known;
    const matchedPaths = new Set(
      unknown.length <= LITERAL_LIMIT
        ? await grepTree(
            grepArg,
            fixed,
            unknown.map((e) => `:(literal)${e.path}`),
          )
        : await grepWhole(grepArg, fixed, pathspecs),
    );
    const fresh = new Map<string, boolean>();
    for (const e of unknown) {
      const matched = matchedPaths.has(e.path);
      // Two paths with one blob have one answer; a disagreement means the
      // selection is not a function of the bytes, and nothing here holds.
      const prior = fresh.get(e.blob);
      if (prior !== undefined && prior !== matched)
        throw new Error(
          `grep-index: blob ${e.blob} both matched and did not match ${JSON.stringify(grepArg)} (at ${e.path})`,
        );
      fresh.set(e.blob, matched);
      known.set(e.blob, matched);
    }
    const answers = [...fresh];
    for (let i = 0; i < answers.length; i += LOOKUP_SLICE) {
      await sliceCheckThread();
      store.record(query, answers.slice(i, i + LOOKUP_SLICE));
    }
    return known;
  }

  /**
   * The whole query, for when most of the tree is unknown (a cold index). Its
   * output must lie inside the domain git lists for the same pathspecs:
   * `ls-files` and `grep <tree>` disagreeing on what a pathspec names would
   * make every recorded negative suspect — refuse rather than record them.
   */
  async function grepWhole(
    grepArg: string,
    fixed: boolean,
    pathspecs: readonly string[],
  ): Promise<string[]> {
    const key = JSON.stringify(pathspecs);
    let domain = domains.get(key);
    if (domain === undefined) {
      domain = listTreePathspec(root, tree, pathspecs).then(
        (entries) => new Set(entries.map((e) => e.path)),
      );
      domains.set(key, domain);
    }
    const [out, inDomain] = await Promise.all([
      grepTree(grepArg, fixed, [...pathspecs]),
      domain,
    ]);
    const outside = out.filter((p) => !inDomain.has(p));
    if (outside.length > 0)
      throw new Error(
        `grep-index: git grep ${JSON.stringify(pathspecs)} matched ${outside.length} path(s) git ls-files does not list for the same pathspecs (first: ${outside[0]})`,
      );
    return out;
  }
}

function depthOf(path: string): number {
  if (path === "") return 0;
  let n = 1;
  for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) n++;
  return n;
}

async function gitVersion(root: string): Promise<string> {
  const result = await spawnCaptured(["git", "--version"], {
    cwd: root,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0)
    throw new Error(`git --version failed (exit ${result.exitCode})`);
  return result.stdout.trim();
}
