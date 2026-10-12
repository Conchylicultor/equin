import { isAbsolute } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  commitFiles,
  commitInfo,
  type CommitFiles,
} from "@plugins/code-explorer/plugins/code-api/core";
import type { CommitRow } from "@plugins/primitives/plugins/commit-list/core";
import {
  LOG_FORMAT,
  parseGitLog,
  tryRunGit,
} from "@plugins/primitives/plugins/commit-list/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/server";
import { resolveCheckoutRoot } from "./checkout-root";
import { getRangeFiles, resolveParentSha } from "./get-push-files";

/**
 * A sha and only a sha: named refs (`HEAD`, `main`) move, so they are not
 * immutable. Abbreviations (7+) stay accepted — the commit-link chip resolves
 * the short sha an author typed — so `commitFiles` answers with the FULL sha it
 * resolved, never the abbreviation echoed back.
 */
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** Both values declare the same refusals, so either's `refuse` builds them. */
type Refuse = typeof commitInfo.refuse;

/**
 * The checkout whose object store answers for `worktree` — no DB read, so the
 * loaders stay honest `external` ones.
 *
 * Every linked worktree shares this repository's one object database, so `main`,
 * `self` and an attempt id all resolve a sha here (an attempt's DB-stored
 * `worktreePath` goes stale the moment `worktree-cleanup` reaps it; the store
 * keeps the commit). An absolute path is the checkout at that toplevel — another
 * repository's store — refused `no-checkout` when it names none.
 */
async function objectStoreRoot(
  worktree: string,
  refuse: Refuse,
): Promise<string> {
  if (!isAbsolute(worktree)) return REPO_ROOT;
  const root = await resolveCheckoutRoot(worktree);
  if (root === null) throw refuse("no-checkout", `no checkout at ${worktree}`);
  return root;
}

/**
 * A sha naming no commit is a determinate answer (`missing`), not a failure.
 * `tryRunGit` still throws `WorktreeGoneError` when the checkout itself has
 * vanished — a real fault, so it surfaces as one.
 */
async function loadCommitInfo(
  worktree: string,
  sha: string,
): Promise<CommitRow> {
  const missing = () => commitInfo.refuse("missing", `no commit ${sha}`);
  if (!SHA_RE.test(sha)) throw missing();
  const root = await objectStoreRoot(worktree, commitInfo.refuse);
  const result = await tryRunGit(
    ["log", "-1", `--format=${LOG_FORMAT}`, `${sha}^{commit}`, "--"],
    root,
  );
  if (!result.ok) throw missing();
  const row = parseGitLog(result.stdout)[0];
  // `git log -1` either fails or emits exactly one record: an ok exit that
  // parses to nothing is a broken premise, not an answer to vouch for.
  if (!row) throw new Error(`git log -1 ${sha} produced no parseable commit`);
  return row;
}

async function loadCommitFiles(
  worktree: string,
  sha: string,
): Promise<CommitFiles> {
  const missing = () => commitFiles.refuse("missing", `no commit ${sha}`);
  if (!SHA_RE.test(sha)) throw missing();
  const root = await objectStoreRoot(worktree, commitFiles.refuse);
  // Placed first, so an unknown sha is refused rather than read as a root
  // commit (`resolveParentSha` answers null for both).
  const exists = await tryRunGit(
    ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`],
    root,
  );
  if (!exists.ok) throw missing();
  // The full sha the (possibly abbreviated) input resolved to: every git read
  // below and the answer name it, so nothing downstream re-resolves a prefix.
  const headSha = exists.stdout.trim();

  const baseSha = await resolveParentSha(root, headSha);
  if (!baseSha) return { files: [], baseSha: headSha, headSha };

  const files = await getRangeFiles(root, baseSha, headSha);
  if (!files) throw new Error(`git diff ${baseSha} ${headSha} failed`);
  return { files, baseSha, headSha };
}

export const commitInfoServed = serveValue(commitInfo, {
  source: "external",
  changes: {
    // Exact for the found arm of a full sha. Not healed while subscribed (a
    // remount re-asks): a refusal, and an abbreviated sha's resolution.
    immutable: {
      reason:
        "a commit's content is addressed by its sha; refusals (no-checkout, missing) and abbreviated-sha resolutions do not heal while subscribed",
    },
  },
  loader: ({ worktree, sha }) => loadCommitInfo(worktree, sha),
});

export const commitFilesServed = serveValue(commitFiles, {
  source: "external",
  changes: {
    // Exact for the found arm of a full sha. Not healed while subscribed (a
    // remount re-asks): a refusal, and an abbreviated sha's resolution.
    immutable: {
      reason:
        "a commit's content is addressed by its sha; refusals (no-checkout, missing) and abbreviated-sha resolutions do not heal while subscribed",
    },
  },
  loader: ({ worktree, sha }) => loadCommitFiles(worktree, sha),
});
