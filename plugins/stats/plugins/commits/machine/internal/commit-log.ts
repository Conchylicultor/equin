import { createHash } from "node:crypto";
import { open, rename } from "node:fs/promises";
import { z } from "zod";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { sourceDigest } from "@plugins/packages/plugins/source-digest/server";
import {
  spawnCaptured,
  spawnExpectOk,
} from "@plugins/infra/plugins/spawn/core";
import { commitHistoryDir } from "../../data-dirs";
import {
  CommitInfoSchema,
  LOG_FORMAT,
  parseHeaders,
  parseLogCode,
  parseNumstatLog,
  type CommitHeader,
  type CommitInfo,
} from "./parse-log";

export type { CommitHeader, CommitInfo } from "./parse-log";

// Two reads of the main checkout's history, priced very differently:
//
// - The commit list (date, push and conversation trailers) is `git log`
//   without diffs: ~0.1 s for the whole history. The commit counts read only
//   this, recomputed per HEAD in memory.
// - Line stats need `git log --numstat`, a tree and blob diff per commit:
//   ~8 ms of git CPU per commit (our parse is ~50 ms for the whole 11 MB
//   output), 40–90 s for the whole history on a busy host — three quarters of
//   it diffing the 3 MB generated docs/plugins-details.md, changed by every
//   other commit. Main restarts on every push, so an in-memory memo alone made
//   every push's first chart read pay all of it. A commit's line stats never
//   change, so they are stored per excluded-paths filter (`commitHistoryDir`)
//   and a read at a newer HEAD diffs only the commits since the stored one:
//   O(new commits). Only the first read on a host (or a history not
//   descending from the stored one) diffs the whole history, a chunk at a
//   time, each chunk stored as it lands.
//
// Two minutes is far above one chunk and exists only to stop a wedged child
// holding a stats read open forever.
const GIT_LOG_TIMEOUT_MS = 120_000;
const REV_PARSE_TIMEOUT_MS = 10_000;

/**
 * How many first-parent commits one `git log --numstat` call covers while a
 * history is built up: every call stays well inside GIT_LOG_TIMEOUT_MS on a
 * busy host, and a build cut short (a timeout, a restart) resumes from the last
 * stored chunk instead of starting over.
 */
const CHUNK_COMMITS = 400;

async function git(root: string, args: string[], timeoutMs: number) {
  return spawnExpectOk([GIT, "-C", root, ...args], { timeoutMs });
}

/** The main checkout's HEAD — the history every series reads. */
async function readHead(root: string): Promise<string> {
  const result = await git(root, ["rev-parse", "HEAD"], REV_PARSE_TIMEOUT_MS);
  return result.stdout.trim();
}

/**
 * Whether `ancestor` is in `head`'s history. A commit this clone does not have
 * (a stored history from before a re-clone) is in no history.
 */
async function isAncestor(
  root: string,
  ancestor: string,
  head: string,
): Promise<boolean> {
  const known = await spawnCaptured(
    [GIT, "-C", root, "cat-file", "-e", `${ancestor}^{commit}`],
    { timeoutMs: REV_PARSE_TIMEOUT_MS },
  );
  if (known.exitCode !== 0) return false;
  const result = await spawnCaptured(
    [GIT, "-C", root, "merge-base", "--is-ancestor", ancestor, head],
    { timeoutMs: REV_PARSE_TIMEOUT_MS },
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(
    `git merge-base --is-ancestor ${ancestor} ${head} failed (exit ${result.exitCode}, signal ${result.signalCode ?? "-"}): ${result.stderr.trim()}`,
  );
}

// --- The commit list (no diffs) -------------------------------------------

let headers: { head: string; commits: Promise<CommitHeader[]> } | null = null;

/** Every commit of the main checkout's history, oldest first, without line stats. */
export async function getCommitHeaders(): Promise<CommitHeader[]> {
  const root = await ensureMainWorktreeRoot();
  const head = await readHead(root);
  if (headers?.head === head) return headers.commits;
  const entry = {
    head,
    commits: git(
      root,
      ["log", LOG_FORMAT, "--reverse", head],
      GIT_LOG_TIMEOUT_MS,
    )
      .then((r) => parseHeaders(r.stdout))
      .catch((err: unknown) => {
        if (headers === entry) headers = null;
        throw err;
      }),
  };
  headers = entry;
  return entry.commits;
}

// --- Line stats (stored, extended per HEAD) --------------------------------

/** One filter's line stats as stored: every commit up to `head`. */
const StoredHistorySchema = z.object({
  filter: z.string(),
  head: z.string(),
  commits: z.array(CommitInfoSchema),
});
type StoredHistory = z.infer<typeof StoredHistorySchema>;

/**
 * The file one filter's history lives in. Named by the parse code's digest
 * too: every backend on the host (worktrees included) shares the directory,
 * and a process never extends a history another parse wrote.
 */
async function historyPath(filterKey: string): Promise<string> {
  const code = await sourceDigest([parseLogCode]);
  const digest = createHash("sha256")
    .update(`${code}\0${filterKey}`)
    .digest("hex")
    .slice(0, 24);
  return commitHistoryDir.file(`history-${digest}.json`);
}

/** The stored history of `filterKey`, or null when none was written yet. */
async function readStored(filterKey: string): Promise<StoredHistory | null> {
  const path = await historyPath(filterKey);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
  // Written whole and synced before its rename, by the code of this digest:
  // a file that does not parse is a bug, thrown, never rebuilt over.
  const stored = StoredHistorySchema.parse(JSON.parse(raw));
  if (stored.filter !== filterKey)
    throw new Error(
      `${path} holds the history of filter "${stored.filter}", not "${filterKey}" (a digest collision)`,
    );
  return stored;
}

/** Store `history` whole: synced, then renamed over the old file. */
async function writeStored(history: StoredHistory): Promise<void> {
  const path = await historyPath(history.filter);
  await commitHistoryDir.ensure();
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(history), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

/** The line stats of the commits `revs` names, oldest first. */
async function parseNumstat(
  root: string,
  revs: string[],
  pathArgs: string[],
): Promise<CommitInfo[]> {
  const result = await git(
    root,
    ["log", LOG_FORMAT, "--numstat", "--reverse", ...revs, ...pathArgs],
    GIT_LOG_TIMEOUT_MS,
  );
  return parseNumstatLog(result.stdout);
}

/**
 * The first-parent commits after `since` (null = from the root) up to `head`,
 * every CHUNK_COMMITS-th one and `head` itself: the tips a build walks. Each is
 * an ancestor of the next, so the ranges between them tile the history.
 */
async function chunkTips(
  root: string,
  head: string,
  since: string | null,
): Promise<string[]> {
  const result = await git(
    root,
    [
      "rev-list",
      "--first-parent",
      "--reverse",
      head,
      ...(since === null ? [] : [`^${since}`]),
    ],
    REV_PARSE_TIMEOUT_MS,
  );
  const chain = result.stdout.split("\n").filter(Boolean);
  const tips = chain.filter(
    (_sha, i) => (i + 1) % CHUNK_COMMITS === 0 || i === chain.length - 1,
  );
  if (tips.at(-1) !== head)
    throw new Error(
      `git rev-list --first-parent ${head} did not end at ${head} (${chain.length} commits)`,
    );
  return tips;
}

/** What a read at a HEAD starts from: the history at another HEAD. */
interface Base {
  head: string;
  commits: CommitInfo[];
}

/**
 * Every commit up to `head` for one filter, from `base`:
 * - `base` at `head`: itself;
 * - `base` past `head` (another backend stored a newer HEAD before this one
 *   read its own): `base` minus the commits after `head`;
 * - `base` behind `head`: extended by the commits since, a chunk at a time,
 *   each stored;
 * - no usable base: built from the root the same way.
 */
async function historyAt(
  root: string,
  head: string,
  filterKey: string,
  pathArgs: string[],
  base: Base | null,
): Promise<CommitInfo[]> {
  if (base !== null && base.head === head) return base.commits;
  if (base !== null && (await isAncestor(root, head, base.head))) {
    const after = await git(
      root,
      ["rev-list", base.head, `^${head}`],
      REV_PARSE_TIMEOUT_MS,
    );
    const later = new Set(after.stdout.split("\n").filter(Boolean));
    return base.commits.filter((c) => !later.has(c.sha));
  }
  const from =
    base !== null && (await isAncestor(root, base.head, head)) ? base : null;
  let commits = from?.commits ?? [];
  let prev = from?.head ?? null;
  for (const tip of await chunkTips(root, head, prev)) {
    // `^from.head` on every range: a tip's history may reach the base's
    // commits through a merge the base's own first-parent chain never crossed.
    const excludes = [prev, from?.head ?? null]
      .filter((s): s is string => s !== null)
      .map((s) => `^${s}`);
    commits = [
      ...commits,
      ...(await parseNumstat(root, [tip, ...excludes], pathArgs)),
    ];
    prev = tip;
    await writeStored({ filter: filterKey, head: tip, commits });
  }
  return commits;
}

interface Parse {
  head: string;
  commits: Promise<CommitInfo[]>;
}

// One parse per filter, kept while HEAD stays where it was parsed at, and the
// base the next HEAD's read extends. Keyed by the sha, not a TTL: the values
// recompute on every ref advance (`recomputeOn: [refHeadServed]`), and a
// time-boxed cache would answer that recompute with the history from before
// the advance. The promise is stored, so charts reading at once share one
// read; a failed one is dropped so the next read retries.
//
// Bounded: one entry per filter (a read at a new HEAD replaces it), and at most
// MAX_PARSES excluded-path combinations, least recently read dropped first —
// toggling the excluded chips through many combinations cannot pin a history
// copy per combination.
const parses = new Map<string, Parse>();
const MAX_PARSES = 3;

function keepBounded(): void {
  // Map order is insertion order, and a read re-inserts its key: the first
  // keys are the least recently read.
  for (const key of [...parses.keys()].slice(0, -MAX_PARSES)) {
    parses.delete(key);
  }
}

/** The history a read at a new HEAD starts from: this process's, else the stored one. */
async function baseOf(
  previous: Parse | undefined,
  filterKey: string,
): Promise<Base | null> {
  if (previous !== undefined) {
    const commits = await previous.commits.then(
      (c) => c,
      // A failed earlier read leaves nothing to extend; its error was
      // already its own readers'.
      (_err: unknown) => null,
    );
    if (commits !== null) return { head: previous.head, commits };
  }
  return readStored(filterKey);
}

/**
 * Every commit of the main checkout's history with its line stats, oldest
 * first. `excludedPaths` leaves those path prefixes out of each commit's line
 * stats (a commit that touched only excluded paths is left out).
 */
export async function getCommits(
  excludedPaths: readonly string[],
): Promise<CommitInfo[]> {
  const root = await ensureMainWorktreeRoot();
  const head = await readHead(root);
  const key = [...excludedPaths].sort().join("|");
  const cached = parses.get(key);
  if (cached && cached.head === head) {
    parses.delete(key);
    parses.set(key, cached); // most recently read
    return cached.commits;
  }
  const pathArgs =
    excludedPaths.length === 0
      ? []
      : ["--", ".", ...excludedPaths.map((p) => `:(exclude)${p}`)];
  const entry: Parse = {
    head,
    commits: baseOf(cached, key)
      .then((base) => historyAt(root, head, key, pathArgs, base))
      .catch((err: unknown) => {
        if (parses.get(key) === entry) parses.delete(key);
        throw err;
      }),
  };
  parses.delete(key);
  parses.set(key, entry);
  keepBounded();
  return entry.commits;
}

// --- One commit per push ----------------------------------------------------

/**
 * Collapses commits sharing a push trailer into one per push: the last
 * commit's timestamp, the first conversation id found, and `absorb` folding
 * the rest into the first's copy. Commits without a push id are kept as-is.
 * Never mutates its input (the cached parse).
 */
function collapseByPush<C extends CommitHeader>(
  commits: readonly C[],
  copy: (c: C) => C,
  absorb: (into: C, c: C) => void,
): C[] {
  const result: C[] = [];
  const byPushId = new Map<string, C>();
  for (const commit of commits) {
    if (!commit.pushId) {
      result.push(commit);
      continue;
    }
    const existing = byPushId.get(commit.pushId);
    if (!existing) {
      const merged = copy(commit);
      byPushId.set(commit.pushId, merged);
      result.push(merged);
      continue;
    }
    existing.iso = commit.iso;
    if (!existing.conversationId && commit.conversationId) {
      existing.conversationId = commit.conversationId;
    }
    absorb(existing, commit);
  }
  return result;
}

/** One commit per push, without line stats. */
export function deduplicateHeadersByPushId(
  commits: readonly CommitHeader[],
): CommitHeader[] {
  return collapseByPush(
    commits,
    (c) => ({ ...c }),
    () => {},
  );
}

/** One commit per push, its line stats summed over the push's commits. */
export function deduplicateByPushId(commits: CommitInfo[]): CommitInfo[] {
  return collapseByPush(
    commits,
    // A deep copy: the sums below must never write into the cached parse.
    (c) => ({
      ...c,
      byExt: Object.fromEntries(
        Object.entries(c.byExt).map(([ext, s]) => [ext, { ...s }]),
      ),
    }),
    (existing, commit) => {
      existing.added += commit.added;
      existing.removed += commit.removed;
      for (const [ext, stats] of Object.entries(commit.byExt)) {
        const e = existing.byExt[ext] ?? { added: 0, removed: 0 };
        e.added += stats.added;
        e.removed += stats.removed;
        existing.byExt[ext] = e;
      }
    },
  );
}
