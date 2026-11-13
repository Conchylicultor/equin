/**
 * The ONE definition of "published" for migrations.
 *
 * > A migration is published once it exists on any `main` this checkout knows
 * > of: local `main`, or `refs/remotes/<any>/main`.
 *
 * - Author: `main` + `origin/main`.
 * - Clone: local `main` holds the user's own migrations, `origin/main` (or
 *   `upstream/main`) the author's.
 * - Fork: `origin/main` + `upstream/main`.
 * - An upstream-merge branch: upstream's migrations are on `upstream/main`, the
 *   user's on `main` — both immutable, so push's normalize resets neither.
 *
 * The union needs no remote classification, so it is offline and side-effect
 * free — checks call it. It deliberately does NOT go through the remotes
 * plugin's `resolvePublishTarget` (may run a dry-run push) or
 * `resolveUpstreamRemote` (may add a remote). Erring toward "published" is the
 * safe direction: the worst case is a branch migration that already sits on
 * some remote's `main` is not consolidated — and it really is out there.
 *
 * See research/2026-09-30-global-clone-migrations-published-set.md.
 */
import {
  spawnCaptured,
  spawnExpectOk,
} from "@plugins/infra/plugins/spawn/core";
import { MIGRATIONS_PLUGIN_DIR } from "./schema-glob-patterns";

/**
 * The repo-relative migrations data dir, as a git pathspec. A wrong pathspec
 * makes `git ls-tree` / `git diff` exit 0 with empty output, so it is derived
 * from `MIGRATIONS_PLUGIN_DIR` rather than re-typed.
 */
export const MIGRATIONS_DATA_DIR = `${MIGRATIONS_PLUGIN_DIR}/data`;

// Wedge-breaker for local git metadata reads — orders of magnitude above what
// any of them take, so only a wedged child trips it.
const GIT_TIMEOUT_MS = 60_000;

/** Local `main`: this checkout's own trunk, first in `publishedMigrationRefs`. */
export const LOCAL_MAIN_REF = "refs/heads/main";
// `refs/remotes/<remote>/main`; `<remote>/HEAD` and deeper branches excluded.
const REMOTE_MAIN_RE = /^refs\/remotes\/[^/]+\/main$/;

/** One `main` this checkout knows of, resolved. */
export interface PublishedRef {
  /** Full ref name: `refs/heads/main` or `refs/remotes/<remote>/main`. */
  ref: string;
  /** The commit it points at. */
  sha: string;
}

/**
 * Every `main` this checkout knows of, resolved: local `main` first (typed as
 * the tuple's head, so a caller wanting the ref the main DB runs takes
 * element 0), then each `refs/remotes/<remote>/main` in ref-name order. Stable order, so a joined
 * signature is deterministic.
 *
 * Throws when local `main` does not exist — the published set would otherwise
 * silently shrink to whatever remotes happen to be fetched, and "nothing is
 * published" is the one answer that makes the normalize delete real history.
 */
export async function publishedMigrationRefs(
  root: string,
): Promise<[local: PublishedRef, ...remotes: PublishedRef[]]> {
  const listed = await spawnExpectOk(
    [
      "git",
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      LOCAL_MAIN_REF,
      "refs/remotes",
    ],
    { cwd: root, timeoutMs: GIT_TIMEOUT_MS },
  );
  let local: PublishedRef | null = null;
  const remotes: PublishedRef[] = [];
  for (const line of listed.stdout.split("\n")) {
    if (!line) continue;
    const [ref, sha] = line.split(" ") as [string, string];
    if (ref === LOCAL_MAIN_REF) local = { ref, sha };
    else if (REMOTE_MAIN_RE.test(ref)) remotes.push({ ref, sha });
  }
  if (!local) {
    throw new Error(
      `No local \`main\` branch in ${root}: the published migration set (local \`main\` plus every ` +
        "`refs/remotes/<remote>/main`) cannot be determined. Create it (`git branch main <commit>`) and re-run.",
    );
  }
  remotes.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return [local, ...remotes];
}

/**
 * The cache-signature spelling of the published set: every ref and its sha,
 * joined. A check whose verdict depends on the published set folds this in, so
 * any `main` moving (a fetch, a push, an upstream update) invalidates it.
 */
export async function publishedMigrationRefsSignature(
  root: string,
): Promise<string> {
  const refs = await publishedMigrationRefs(root);
  return refs.map((r) => `${r.ref}=${r.sha}`).join(",");
}

/**
 * The published set's migration CONTENT, as a cache-signature spelling: each
 * published ref and the tree id of `MIGRATIONS_DATA_DIR` in it (`-` where it
 * has none). Unlike `publishedMigrationRefsSignature`, a `main` that moves
 * without touching a migration keeps it — so a check whose verdict depends on
 * the published files (not on the commits around them) is re-run only when a
 * migration lands, not on every push. One `git cat-file` for every ref.
 */
export async function publishedMigrationTreesSignature(
  root: string,
): Promise<string> {
  const refs = await publishedMigrationRefs(root);
  const result = await spawnCaptured(
    ["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"],
    {
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
      stdin: refs.map((r) => `${r.sha}:${MIGRATIONS_DATA_DIR}\n`).join(""),
    },
  );
  if (result.timedOut || result.exitCode !== 0)
    throw new Error(
      `git cat-file --batch-check failed in ${root} (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""}): ${result.stderr.trim()}`,
    );
  const lines = result.stdout.split("\n").filter(Boolean);
  if (lines.length !== refs.length)
    throw new Error(
      `git cat-file --batch-check answered ${lines.length} line(s) for ${refs.length} ref(s): ${result.stdout}`,
    );
  return refs
    .map((r, i) => {
      const line = lines[i]!;
      // `<object> tree`, or `<input> missing` for a ref with no data dir.
      const tree = line.endsWith(" tree")
        ? line.slice(0, -" tree".length)
        : "-";
      if (tree === "-" && !line.endsWith(" missing"))
        throw new Error(
          `${r.ref}:${MIGRATIONS_DATA_DIR} is not a tree: ${line}`,
        );
      return `${r.ref}=${tree}`;
    })
    .join(",");
}

/** The paths under `MIGRATIONS_DATA_DIR` at `rev`, with their blob ids. */
export async function migrationTreeAt(
  root: string,
  rev: string,
): Promise<{ path: string; blob: string }[]> {
  const listed = await spawnExpectOk(
    ["git", "ls-tree", "-r", rev, "--", MIGRATIONS_DATA_DIR],
    { cwd: root, timeoutMs: GIT_TIMEOUT_MS },
  );
  const entries: { path: string; blob: string }[] = [];
  for (const line of listed.stdout.split("\n")) {
    if (!line) continue;
    // `<mode> <type> <object>\t<path>`
    const tab = line.indexOf("\t");
    const [, type, blob] = line.slice(0, tab).split(" ") as [
      string,
      string,
      string,
    ];
    if (type !== "blob") continue;
    entries.push({ path: line.slice(tab + 1), blob });
  }
  return entries;
}

/**
 * Where each published migration file comes from: basename → the published
 * refs (`publishedMigrationRefs` order, so local `main` first) whose tree holds
 * it. The one reading of the published trees — `publishedMigrationBasenames`
 * is its key set — for a caller that must say WHICH `main` a file is on (the
 * snapshot join labels a conflict's sides by it: this checkout vs upstream).
 */
export async function publishedMigrationOrigins(
  root: string,
): Promise<Map<string, string[]>> {
  const origins = new Map<string, string[]>();
  for (const { ref, sha } of await publishedMigrationRefs(root)) {
    const listed = await spawnExpectOk(
      ["git", "ls-tree", "-r", "--name-only", sha, "--", MIGRATIONS_DATA_DIR],
      { cwd: root, timeoutMs: GIT_TIMEOUT_MS },
    );
    for (const p of listed.stdout.split("\n")) {
      if (!p) continue;
      const name = p.slice(p.lastIndexOf("/") + 1);
      const refs = origins.get(name) ?? [];
      refs.push(ref);
      origins.set(name, refs);
    }
  }
  return origins;
}

/**
 * The basenames of every file under the migrations data dir on ANY published
 * `main` (the union over `publishedMigrationRefs`). A migration in this set is
 * immutable: its hash may be in a deployed ledger, and its snapshot is a link
 * of someone's chain.
 */
export async function publishedMigrationBasenames(
  root: string,
): Promise<Set<string>> {
  return new Set((await publishedMigrationOrigins(root)).keys());
}

/** A distinct `merge-base(HEAD, R)` and every published ref R that yields it. */
export interface PublishedMergeBase {
  mergeBase: string;
  refs: string[];
}

/**
 * For each published ref R, `merge-base(HEAD, R)` — the part of R this branch
 * already contains — grouped so a shared base is listed (and later read) once.
 * A ref with NO common ancestor (an unrelated history fetched as some remote's
 * `main`) contributes nothing: none of its files are in this branch's history,
 * so there is nothing of it for this branch to have changed.
 */
export async function publishedMergeBases(
  root: string,
): Promise<PublishedMergeBase[]> {
  const byBase = new Map<string, string[]>();
  for (const { ref, sha } of await publishedMigrationRefs(root)) {
    const result = await spawnCaptured(["git", "merge-base", "HEAD", sha], {
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (result.timedOut) {
      throw new Error(`git merge-base HEAD ${ref} timed out`);
    }
    // Exit 1 with no output is git's "no common ancestor" answer; anything
    // else non-zero is a real failure.
    if (result.exitCode === 1 && result.stdout.trim() === "") continue;
    if (result.exitCode !== 0) {
      throw new Error(
        `git merge-base HEAD ${ref} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    const base = result.stdout.trim();
    const refs = byBase.get(base) ?? [];
    refs.push(ref);
    byBase.set(base, refs);
  }
  return [...byBase].map(([mergeBase, refs]) => ({ mergeBase, refs }));
}
