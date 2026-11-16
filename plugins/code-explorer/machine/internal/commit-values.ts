import { serveValue } from "@plugins/network/plugins/live/machine";
import {
  commitFiles,
  commitInfo,
  type CommitDetail,
  type CommitFiles,
} from "@plugins/code-explorer/plugins/code-api/core";
import {
  LOG_FORMAT,
  parseGitLog,
  tryRunGit,
} from "@plugins/primitives/plugins/commit-list/server";
import {
  cappedRangeFiles,
  objectStoreRoot,
  SHA_RE,
} from "../../server/internal/commit-values";
import { resolveParentSha } from "../../server/internal/get-push-files";
import { bodyWithoutTrailers } from "./commit-body";

// One commit's metadata and files, read with git from the repository's object
// store — desktop-only (`needsMachine` on both declarations).

/**
 * The shared row format, then the raw body (`%b`) as one more NUL-terminated
 * field: commit messages cannot hold a NUL, so the first one ends the row.
 */
const DETAIL_FORMAT = `${LOG_FORMAT}%b%x00`;

/**
 * A sha naming no commit is a determinate answer (`missing`), not a failure.
 * `tryRunGit` still throws `WorktreeGoneError` when the checkout itself has
 * vanished — a real fault, so it surfaces as one.
 */
async function loadCommitInfo(
  worktree: string,
  sha: string,
): Promise<CommitDetail> {
  const missing = () => commitInfo.refuse("missing", `no commit ${sha}`);
  if (!SHA_RE.test(sha)) throw missing();
  const root = await objectStoreRoot(worktree, commitInfo.refuse);
  const result = await tryRunGit(
    ["log", "-1", `--format=${DETAIL_FORMAT}`, `${sha}^{commit}`, "--"],
    root,
  );
  if (!result.ok) throw missing();
  const end = result.stdout.indexOf("\0");
  const row =
    end < 0 ? undefined : parseGitLog(result.stdout.slice(0, end + 1))[0];
  // `git log -1` either fails or emits exactly one record: an ok exit that
  // parses to nothing is a broken premise, not an answer to vouch for.
  if (!row) throw new Error(`git log -1 ${sha} produced no parseable commit`);
  const rawBody = result.stdout.slice(end + 1).replace(/\0\s*$/, "");
  return { ...row, body: bodyWithoutTrailers(rawBody, row.trailers.length) };
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
  if (!baseSha) {
    return { files: [], truncated: false, baseSha: headSha, headSha };
  }
  return {
    ...(await cappedRangeFiles(root, baseSha, headSha)),
    baseSha,
    headSha,
  };
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
