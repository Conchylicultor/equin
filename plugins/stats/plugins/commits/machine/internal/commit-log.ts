import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";

import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";

// `git log --numstat` over the whole history is the heaviest read in this
// plugin — real work, seconds of it, which is why one parse is shared per
// (HEAD, excluded paths) below. Two minutes is far above that and exists only
// to stop a wedged child holding a stats read open forever.
const GIT_LOG_TIMEOUT_MS = 120_000;
const REV_PARSE_TIMEOUT_MS = 10_000;

export interface CommitInfo {
  sha: string;
  iso: string;
  pushId: string | null;
  conversationId: string | null;
  added: number;
  removed: number;
  byExt: Record<string, { added: number; removed: number }>;
}

async function parseGitLog(
  root: string,
  head: string,
  pathArgs: string[],
): Promise<CommitInfo[]> {
  const result = await spawnExpectOk(
    [
      GIT,
      "-C",
      root,
      "log",
      "--format=__C__%H\x1f%cI\x1f%(trailers:key=Singularity-Push,valueonly)\x1f%(trailers:key=Singularity-Conversation,valueonly)",
      "--numstat",
      "--reverse",
      head,
      ...pathArgs,
    ],
    { timeoutMs: GIT_LOG_TIMEOUT_MS },
  );
  const text = result.stdout;

  // Split on __C__ markers — each chunk is one commit's header + numstat.
  // Trailer values append newlines, so the \x1f-delimited header may span
  // multiple lines; splitting on __C__ captures the full record.
  const chunks = text.split("__C__").filter(Boolean);
  const commits: CommitInfo[] = [];
  for (const chunk of chunks) {
    const fields = chunk.split("\x1f");
    const sha = (fields[0] ?? "").trim();
    const iso = (fields[1] ?? "").trim();
    const pushId = (fields[2] ?? "").trim() || null;
    const rest = fields[3] ?? "";
    const restLines = rest.split("\n");
    const conversationId = (restLines[0] ?? "").trim() || null;

    const current: CommitInfo = {
      sha,
      iso,
      pushId,
      conversationId,
      added: 0,
      removed: 0,
      byExt: {},
    };
    for (const line of restLines.slice(1)) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length >= 3) {
        const ins = parts[0]! === "-" ? 0 : parseInt(parts[0]!, 10) || 0;
        const del = parts[1]! === "-" ? 0 : parseInt(parts[1]!, 10) || 0;
        current.added += ins;
        current.removed += del;
        const filepath = parts[2]!;
        const dotIdx = filepath.lastIndexOf(".");
        const ext =
          dotIdx >= 0 ? filepath.slice(dotIdx).toLowerCase() : "(none)";
        const e = current.byExt[ext] ?? { added: 0, removed: 0 };
        e.added += ins;
        e.removed += del;
        current.byExt[ext] = e;
      }
    }
    commits.push(current);
  }
  return commits;
}

/** The main checkout's HEAD — the history every series reads. */
async function readHead(root: string): Promise<string> {
  const result = await spawnExpectOk([GIT, "-C", root, "rev-parse", "HEAD"], {
    timeoutMs: REV_PARSE_TIMEOUT_MS,
  });
  return result.stdout.trim();
}

interface Parse {
  head: string;
  commits: Promise<CommitInfo[]>;
}

// One parse per filter, kept while HEAD stays where it was parsed at. Keyed by
// the sha, not a TTL: the values recompute on every ref advance
// (`recomputeOn: [refHeadServed]`), and a time-boxed cache would answer that
// recompute with the history from before the advance. The promise is stored,
// so charts reading at once share one `git log`; a failed parse is dropped so
// the next read retries.
//
// Bounded: a read at a new HEAD drops every parse taken at another one (each
// is a full-history copy nobody can be answered from again), and at most
// MAX_FILTERED_PARSES excluded-path combinations are kept beside the
// unfiltered one, least recently read dropped first — toggling the excluded
// chips through many combinations cannot pin a history copy per combination.
const parses = new Map<string, Parse>();
const UNFILTERED_KEY = "";
const MAX_FILTERED_PARSES = 2;

function keepBounded(head: string): void {
  for (const [key, parse] of parses) {
    if (parse.head !== head) parses.delete(key);
  }
  // Map order is insertion order, and a read re-inserts its key: the first
  // filtered keys are the least recently read.
  const filtered = [...parses.keys()].filter((k) => k !== UNFILTERED_KEY);
  for (const key of filtered.slice(0, -MAX_FILTERED_PARSES)) {
    parses.delete(key);
  }
}

/**
 * Every commit of the main checkout's history, oldest first. `excludedPaths`
 * leaves those path prefixes out of each commit's line stats (a commit that
 * touched only excluded paths is left out).
 */
export async function getCommits(
  excludedPaths: readonly string[] = [],
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
    commits: parseGitLog(root, head, pathArgs).catch((err: unknown) => {
      if (parses.get(key) === entry) parses.delete(key);
      throw err;
    }),
  };
  parses.delete(key);
  parses.set(key, entry);
  keepBounded(head);
  return entry.commits;
}

/**
 * Collapses commits sharing a Singularity-Push trailer into one representative
 * commit per push group: timestamp of the last commit, line stats summed.
 * Commits without a push id are kept as-is. Never mutates its input (the
 * cached parse).
 */
export function deduplicateByPushId(commits: CommitInfo[]): CommitInfo[] {
  const result: CommitInfo[] = [];
  const byPushId = new Map<string, CommitInfo>();

  for (const commit of commits) {
    if (!commit.pushId) {
      result.push(commit);
      continue;
    }
    const existing = byPushId.get(commit.pushId);
    if (!existing) {
      // A deep copy: the sums below must never write into the cached parse.
      const merged: CommitInfo = {
        ...commit,
        byExt: Object.fromEntries(
          Object.entries(commit.byExt).map(([ext, s]) => [ext, { ...s }]),
        ),
      };
      byPushId.set(commit.pushId, merged);
      result.push(merged);
    } else {
      existing.iso = commit.iso;
      if (!existing.conversationId && commit.conversationId) {
        existing.conversationId = commit.conversationId;
      }
      existing.added += commit.added;
      existing.removed += commit.removed;
      for (const [ext, stats] of Object.entries(commit.byExt)) {
        const e = existing.byExt[ext] ?? { added: 0, removed: 0 };
        e.added += stats.added;
        e.removed += stats.removed;
        existing.byExt[ext] = e;
      }
    }
  }

  return result;
}
