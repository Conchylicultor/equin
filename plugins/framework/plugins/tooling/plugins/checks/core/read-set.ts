// Input-keyed invalidation primitive for the `./equin check` pass-cache.
//
// The whole-tree cache (`cache.ts` `has()/record()`) keys every check's PASS on
// the entire working-tree hash, so ONE changed byte anywhere re-runs all ~62
// checks. This module is the substrate for the alternative: key a PASS on the
// check's ACTUAL inputs, so a tree change that cannot affect a check's verdict
// keeps its cached PASS.
//
// The mental model is NOT "record raw fs syscalls and replay them". It is: a
// check runs against a snapshot-backed `FileSystemView` that LOGS which
// projections of the tree snapshot it consulted (content of a path, existence,
// directory membership, glob/pathspec expansion, grep selection). Validity =
// replaying those projections against the NEXT snapshot and confirming they are
// byte-identical — under the same CODE: a read-set carries the check's code key
// (`check-code-key.ts`), and replay is a MISS when it moved. `git write-tree` (already paid by `computeTreeHash`) has
// hashed every blob; one `git ls-tree -r` turns that into a complete
// content-addressed view of the whole scan surface, from which all four
// projections derive with zero further git calls.
//
// THIS FILE IS LIVE. Nine checks set `inputKeyed` today — `type-check`,
// `plugin-boundaries`, and the seven grepCode pattern checks (`active-data`,
// `no-raw-event-source`, `no-raw-sse`, `no-raw-websocket`,
// `no-hardcoded-colors`, `no-hand-built-link-to`, `no-use-resource-cast`) — so
// the runner takes the input-keyed branch and the recording/validate paths
// execute on every check pass.
//
// A PASS RECORDED HERE IS NOT BOUNDED BY A TREE. The read-set slot is keyed on
// `(checkId, cacheSignature(), checkout)` with no tree hash at all (`cache.ts`
// `readSetFile`), so it survives forward into later trees for as long as the
// replay still validates — which is the point, and also why a check whose
// verdict is not a pure function of the checkout must never be moved onto this
// flag. See the `inputKeyed` JSDoc in `tooling/core/types.ts`.
//
// FAIL-OPEN CONTRACT: the cache must never CAUSE a stale PASS. Any snapshot load
// failure yields `null` (caller runs uncached); `validate` returns a
// discriminated MISS on any doubt (never a false HIT). Recording is best-effort;
// a read-set is only ever CONSUMED through `validate`, which re-derives every
// fact from the fresh snapshot.

import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { createHash } from "node:crypto";
import {
  globPaths,
  pathspecToRegex,
  type GitTreeSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { computeTreeHash } from "./tree-hash";
import type { CheckCodeKey } from "./check-code-key";

// Wedge-breaker for a metadata-only git read: far above any real duration,
// because starvation under a saturated check run is what these suffer, not
// slowness. Same reasoning as `infra/worktree`'s bounds, which carry the
// measurements.
const GIT_TIMEOUT_MS = 60_000;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// Recorded read-set (persisted as one JSON per PASS in the evolved check-cache)
// ---------------------------------------------------------------------------

/** A positive content read: the check depends on this path having this content. */
export interface FileFact {
  path: string;
  blobSha: string;
}

/** A directory-membership probe: the check depends on `dir`'s immediate children. */
export interface DirFact {
  dir: string;
  /** Immediate child names (files AND subdirs), sorted. */
  members: string[];
}

/** A glob/pathspec expansion probe: the check depends on this match set. */
export interface GlobFact {
  glob: string;
  /** Matching repo-relative paths, sorted. */
  matches: string[];
}

/**
 * A `git grep -l` selection (Group-A checks). `pathspecFp` fingerprints the
 * `(path, blobSha)` of EVERY file under the query's pathspecs, so a brand-new
 * file that newly matches the grep predicate changes the fingerprint even though
 * none of the previously-matched files changed (hazard H9).
 */
export interface QueryFact {
  grepArg: string;
  fixed: boolean;
  pathspecs: string[];
  /** The selected repo-relative paths, sorted. */
  matches: string[];
  pathspecFp: string;
}

/**
 * The complete set of filesystem facts a check's verdict depended on, recorded
 * against the snapshot the check ran against. A stale PASS is possible iff a
 * verdict-relevant fact is MISSING here — hence completeness is the load-bearing
 * property, enforced structurally (the H0 guard) in a later stage.
 */
export interface ReadSet {
  /**
   * The code the verdict was computed by (`check-code-key.ts`: the Merkle key
   * of the check's module closure and the runner's). Replay compares it first,
   * so a stored PASS never survives an edit to the code that produced it.
   */
  codeKey: CheckCodeKey;
  treeHashAtRecord: string;
  recordedAt: number;
  /** Positive content reads. */
  files: FileFact[];
  /** Negative-existence probes (path was absent and the verdict relied on it). */
  absent: string[];
  /** Directory-membership probes. */
  dirs: DirFact[];
  /** Glob/pathspec expansion probes. */
  globs: GlobFact[];
  /** `git grep -l` selections + the new-matcher guard. */
  queries: QueryFact[];
}

// ---------------------------------------------------------------------------
// Snapshot: one `git ls-tree -r` → content-addressed view of the whole tree
// ---------------------------------------------------------------------------

/**
 * A read-only, content-addressed projection of a git tree object. Built ONCE
 * per run (a single `git ls-tree -r -z`) and shared across every check; the
 * `prefix → members` index makes membership / glob / pathspec projections O(1)
 * amortised rather than an O(repo) rescan per query.
 */
export interface TreeSnapshot extends GitTreeSnapshot {
  /** True iff `path` is a blob (file) in the tree. */
  exists(path: string): boolean;
  /**
   * Every blob path, repo-relative, in `Array.prototype.sort()` order. Frozen:
   * one array shared by every reader (it is `ctx.repo()`'s set), never copied.
   */
  paths(): readonly string[];
  /** Immediate child names (files + subdirs) of `dir`, sorted; `""` = repo root. */
  members(dir: string): string[];
  /** Repo-relative paths matching the git pathspec `pattern`, sorted. */
  glob(pattern: string): string[];
  /** Union of paths matching ANY of `pathspecs`, sorted. */
  matchPathspecs(pathspecs: string[]): string[];
  /** sha256 over the `(path, blobSha)` of every file under `pathspecs`. */
  pathspecFingerprint(pathspecs: string[]): string;
  /** Blob content of `path` as text, or null if absent. One `git cat-file` per call. */
  readBlobText(path: string): Promise<string | null>;
  /** A fresh recording view over this snapshot, for a check run by the code `codeKey` names. */
  createRecordingView(codeKey: CheckCodeKey): FileSystemView;
}

async function gitStdout(
  root: AppPath,
  args: string[],
): Promise<{ code: number; bytes: Uint8Array }> {
  const result = await spawnCaptured(["git", ...args], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return { code: result.exitCode, bytes: result.stdoutBytes };
}

/**
 * Load the tree snapshot for `treeHash`. FAIL-OPEN: returns null if git is
 * unavailable or `ls-tree` fails/looks malformed, so callers degrade to running
 * uncached rather than risking a bogus view.
 */
export async function loadTreeSnapshot(
  root: AppPath,
  treeHash: string,
): Promise<TreeSnapshot | null> {
  try {
    // -z: NUL-terminated records, no path quoting. Each record is
    // `<mode> <type> <sha>\t<path>`; `-r` recurses so only blobs/commits appear.
    const { code, bytes } = await gitStdout(root, [
      "ls-tree",
      "-r",
      "-z",
      treeHash,
    ]);
    if (code !== 0) return null;
    const text = new TextDecoder().decode(bytes);
    const blobSha = new Map<string, string>();
    const gitlinks: string[] = [];
    for (const record of text.split("\0")) {
      if (record.length === 0) continue;
      const tab = record.indexOf("\t");
      if (tab < 0) return null; // framing desync → fail-open
      const meta = record.slice(0, tab);
      const path = record.slice(tab + 1);
      const parts = meta.split(" ");
      const type = parts[1];
      const sha = parts[2];
      if (!sha) continue;
      // A gitlink (mode 160000): a nested repository, kept apart — never a file.
      if (type === "commit") gitlinks.push(path);
      if (type !== "blob") continue;
      blobSha.set(path, sha);
    }
    if (blobSha.size === 0) return null; // an empty tree is never a real scan surface
    return buildSnapshot(root, treeHash, blobSha, gitlinks.sort());
    // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- explicit fail-open contract, mirroring computeTreeHash: any error (no git, spawn failure, malformed output) returns null so checks run uncached; propagating would break the whole run in a degraded environment
  } catch {
    return null;
  }
}

/**
 * The snapshot of `root`'s working tree, STRICTLY: hashes the tree first when
 * no `treeHash` is given, and throws where the fail-open pair
 * (`computeTreeHash`, `loadTreeSnapshot`) returns null.
 *
 * For a reader whose answer IS the tree — `ctx.snapshot()`, and type-check,
 * which versions every file by its blob sha — rather than a cache that can
 * degrade to running uncached. A null there would mean "nothing to key on",
 * which no such reader can do anything sound with.
 */
export async function readTreeSnapshot(
  root: AppPath,
  treeHash?: string,
): Promise<TreeSnapshot> {
  const hash = treeHash ?? (await computeTreeHash(root));
  if (hash === null) {
    throw new Error(
      `git could not hash the working tree of ${root} (computeTreeHash failed) — is it a git checkout?`,
    );
  }
  const snapshot = await loadTreeSnapshot(root, hash);
  if (snapshot === null) {
    throw new Error(
      `git could not list tree ${hash} of ${root} (git ls-tree failed, or the tree is empty)`,
    );
  }
  return snapshot;
}

function buildSnapshot(
  root: AppPath,
  treeHash: string,
  blobSha: Map<string, string>,
  gitlinks: readonly string[],
): TreeSnapshot {
  // Build the `dir → immediate child names` index ONCE. For a/b/c.ts we add
  // c.ts under a/b, b under a, a under "" (root). Files and subdirs both count
  // as members, so a membership probe sees a newly-added file OR subdir.
  const dirMembers = new Map<string, Set<string>>();
  const addMember = (dir: string, name: string) => {
    let set = dirMembers.get(dir);
    if (!set) {
      set = new Set();
      dirMembers.set(dir, set);
    }
    set.add(name);
  };
  for (const path of blobSha.keys()) {
    const segs = path.split("/");
    let dir = "";
    for (let i = 0; i < segs.length; i++) {
      const name = segs[i]!;
      addMember(dir, name);
      dir = dir === "" ? name : `${dir}/${name}`;
    }
  }

  const sortedPaths: readonly string[] = Object.freeze(
    [...blobSha.keys()].sort(),
  );

  // Record and replay alike go through here: one matcher with the plain set's.
  const glob = (pattern: string): string[] => globPaths(sortedPaths, pattern);
  const matchPathspecs = (pathspecs: string[]): string[] => {
    if (pathspecs.length === 0) return [];
    const res = pathspecs.map(pathspecToRegex);
    return sortedPaths.filter((p) => res.some((re) => re.test(p)));
  };

  const snapshot: TreeSnapshot = {
    treeHash,
    root,
    blobSha: (path) => blobSha.get(path) ?? null,
    gitlinks: () => gitlinks,
    exists: (path) => blobSha.has(path),
    paths: () => sortedPaths,
    members: (dir) => {
      const key = dir.replace(/\/+$/, "");
      const set = dirMembers.get(key);
      return set ? [...set].sort() : [];
    },
    glob,
    matchPathspecs,
    pathspecFingerprint: (pathspecs) => {
      const matches = matchPathspecs(pathspecs);
      return sha256(
        matches.map((p) => `${p}\0${blobSha.get(p) ?? ""}`).join("\n"),
      );
    },
    readBlobText: async (path) => {
      if (!blobSha.has(path)) return null;
      const { code, bytes } = await gitStdout(root, [
        "cat-file",
        "blob",
        `${treeHash}:${path}`,
      ]);
      if (code !== 0) return null;
      return new TextDecoder().decode(bytes);
    },
    createRecordingView: (codeKey) => createRecordingView(snapshot, codeKey),
  };
  return snapshot;
}

// ---------------------------------------------------------------------------
// Recording view (the single fs seam a check's reads route through)
// ---------------------------------------------------------------------------

/**
 * A snapshot-backed view that RECORDS which projections a check consulted. All
 * reads answer from the snapshot (never the live working tree), so what a check
 * inspects is exactly what the recorded read-set replays against.
 */
export interface FileSystemView {
  /** The scan tree-ish, exposed so `currentScanTree()` reads it off the view. */
  readonly tree: string;
  /** Read a file's content, recording a positive content fact (or an absent probe). */
  readFile(path: string): Promise<string | null>;
  /**
   * Record a positive content fact for `path` WITHOUT reading its bytes — the
   * blobSha is taken from the snapshot. For callers that already have the file's
   * content in hand (e.g. `grepCode`'s BATCH `git cat-file --batch`) and must not
   * regress to a per-file read just to log the dependency. A no-op (records an
   * absent probe) if `path` is not a blob in the snapshot.
   */
  recordFile(path: string): void;
  /** Probe existence, recording a content fact (present) or an absent probe. */
  exists(path: string): boolean;
  /** List a directory's immediate children, recording a membership fact. */
  listDir(dir: string): string[];
  /** Expand a glob/pathspec, recording a glob fact. */
  glob(pattern: string): string[];
  /** Record a `git grep -l` selection + its pathspec fingerprint (Group-A). */
  recordQuery(
    grepArg: string,
    fixed: boolean,
    pathspecs: string[],
    matches: string[],
  ): void;
  /** Finalise the accumulated, canonicalised read-set. */
  readSet(): ReadSet;
}

function createRecordingView(
  snapshot: TreeSnapshot,
  codeKey: CheckCodeKey,
): FileSystemView {
  const files = new Map<string, string>(); // path → blobSha
  const absent = new Set<string>();
  const dirs = new Map<string, string[]>(); // dir → members
  const globs = new Map<string, string[]>(); // glob → matches
  const queries: QueryFact[] = [];

  const noteExisting = (path: string) => {
    const sha = snapshot.blobSha(path);
    if (sha === null) absent.add(path);
    else files.set(path, sha);
  };

  return {
    tree: snapshot.treeHash,
    readFile: async (path) => {
      noteExisting(path);
      return snapshot.readBlobText(path);
    },
    recordFile: (path) => {
      noteExisting(path);
    },
    exists: (path) => {
      noteExisting(path);
      return snapshot.exists(path);
    },
    listDir: (dir) => {
      const members = snapshot.members(dir);
      dirs.set(dir.replace(/\/+$/, ""), members);
      return members;
    },
    glob: (pattern) => {
      const matches = snapshot.glob(pattern);
      globs.set(pattern, matches);
      return matches;
    },
    recordQuery: (grepArg, fixed, pathspecs, matches) => {
      queries.push({
        grepArg,
        fixed,
        pathspecs: [...pathspecs].sort(),
        matches: [...matches].sort(),
        pathspecFp: snapshot.pathspecFingerprint(pathspecs),
      });
    },
    readSet: () =>
      canonicalize({
        codeKey,
        treeHashAtRecord: snapshot.treeHash,
        recordedAt: Date.now(),
        files: [...files].map(([path, blobSha]) => ({ path, blobSha })),
        absent: [...absent],
        dirs: [...dirs].map(([dir, members]) => ({ dir, members })),
        globs: [...globs].map(([glob, matches]) => ({ glob, matches })),
        queries,
      }),
  };
}

/** Deterministic ordering so the fingerprint is stable across runs (hazard H7). */
function canonicalize(rs: ReadSet): ReadSet {
  return {
    ...rs,
    files: [...rs.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    absent: [...rs.absent].sort(),
    dirs: [...rs.dirs]
      .map((d) => ({ dir: d.dir, members: [...d.members].sort() }))
      .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0)),
    globs: [...rs.globs]
      .map((g) => ({ glob: g.glob, matches: [...g.matches].sort() }))
      .sort((a, b) => (a.glob < b.glob ? -1 : a.glob > b.glob ? 1 : 0)),
    queries: [...rs.queries]
      .map((q) => ({
        ...q,
        pathspecs: [...q.pathspecs].sort(),
        matches: [...q.matches].sort(),
      }))
      .sort((a, b) => {
        const ka = `${a.grepArg}\0${a.pathspecs.join(",")}`;
        const kb = `${b.grepArg}\0${b.pathspecs.join(",")}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      }),
  };
}

/**
 * Content-addressed fingerprint of a read-set: sha256 over the canonicalised
 * facts + `codeKey`. Two read-sets with the same fingerprint depend on an
 * identical set of tree facts. (Not used as the cache lookup key — the read-set
 * is only known AFTER running — but exposed for shadow-mode logging and tests.)
 */
export function fingerprint(readSet: ReadSet): string {
  const c = canonicalize(readSet);
  return sha256(
    JSON.stringify({
      codeKey: c.codeKey,
      files: c.files,
      absent: c.absent,
      dirs: c.dirs,
      globs: c.globs,
      queries: c.queries.map((q) => ({
        grepArg: q.grepArg,
        fixed: q.fixed,
        pathspecs: q.pathspecs,
        matches: q.matches,
        pathspecFp: q.pathspecFp,
      })),
    }),
  );
}

// ---------------------------------------------------------------------------
// Validate-by-replay
// ---------------------------------------------------------------------------

/**
 * Discriminated result (never a bare boolean that hides the reason — the reason
 * feeds shadow-mode divergence logging).
 */
export type ValidateResult = { hit: true } | { hit: false; reason: string };

export interface ValidateOptions {
  /**
   * Re-run a recorded `git grep -l` query against the CURRENT scan tree and
   * return its match set. Called ONLY when a query's `pathspecFp` changed
   * (cheap in-memory check first). Absent → a changed pathspecFp is treated as a
   * MISS (safe: run). Wired when grep recording lands (later stage).
   */
  replayQuery?: (query: QueryFact) => Promise<string[]>;
}

function sortedEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

/**
 * Replay a recorded read-set against a fresh snapshot, for a check whose code
 * is now `codeKey`. HIT iff it was recorded by that same code and EVERY recorded
 * fact still holds; otherwise MISS with a human reason. Any doubt is a MISS —
 * the cache can never CAUSE a stale PASS.
 */
export async function validate(
  readSet: ReadSet,
  snapshot: TreeSnapshot,
  codeKey: CheckCodeKey,
  opts?: ValidateOptions,
): Promise<ValidateResult> {
  // A read-set recorded before the code key existed carries none: a MISS.
  if (readSet.codeKey !== codeKey) {
    return { hit: false, reason: "check code changed (codeKey mismatch)" };
  }
  for (const f of readSet.files) {
    if (snapshot.blobSha(f.path) !== f.blobSha) {
      return { hit: false, reason: `file changed or removed: ${f.path}` };
    }
  }
  for (const path of readSet.absent) {
    if (snapshot.exists(path)) {
      return {
        hit: false,
        reason: `previously-absent path now present: ${path}`,
      };
    }
  }
  for (const d of readSet.dirs) {
    if (!sortedEqual(snapshot.members(d.dir), d.members)) {
      return { hit: false, reason: `directory membership changed: ${d.dir}` };
    }
  }
  for (const g of readSet.globs) {
    if (!sortedEqual(snapshot.glob(g.glob), g.matches)) {
      return { hit: false, reason: `glob match set changed: ${g.glob}` };
    }
  }
  for (const q of readSet.queries) {
    if (snapshot.pathspecFingerprint(q.pathspecs) === q.pathspecFp) continue; // provably identical
    if (!opts?.replayQuery) {
      return {
        hit: false,
        reason: `query inputs changed (no replay hook): ${q.grepArg}`,
      };
    }
    const fresh = await opts.replayQuery(q);
    if (!sortedEqual(fresh, q.matches)) {
      return { hit: false, reason: `query match set changed: ${q.grepArg}` };
    }
  }
  return { hit: true };
}
