import { isAbsolute } from "node:path";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  commitInfo,
  pushFiles,
  type CommitFiles,
} from "@plugins/code-explorer/plugins/code-api/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/server";
import { resolveCheckoutRoot } from "./checkout-root";
import { getRangeFiles } from "./get-push-files";
import { pushRangeReads, resolvePushRange } from "./push-range";

/**
 * A sha and only a sha: named refs (`HEAD`, `main`) move, so they are not
 * immutable. Abbreviations (7+) stay accepted — the commit-link chip resolves
 * the short sha an author typed — so `commitFiles` answers with the FULL sha it
 * resolved, never the abbreviation echoed back.
 */
export const SHA_RE = /^[0-9a-f]{7,40}$/;

/** Both values declare the same refusals, so either's `refuse` builds them. */
export type Refuse = typeof commitInfo.refuse;

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
export async function objectStoreRoot(
  worktree: string,
  refuse: Refuse,
): Promise<string> {
  if (!isAbsolute(worktree)) return REPO_ROOT;
  const root = await resolveCheckoutRoot(worktree);
  if (root === null) throw refuse("no-checkout", `no checkout at ${worktree}`);
  return root;
}

/**
 * The files of the push `pushId`: its range (`resolvePushRange` — the push's
 * rows ordered by ancestry) diffed as `baseSha..headSha`.
 */
export async function loadPushFiles(
  worktree: string,
  pushId: string,
): Promise<CommitFiles> {
  const root = await objectStoreRoot(worktree, pushFiles.refuse);
  const range = await resolvePushRange(root, pushId);
  switch (range.kind) {
    case "no-push":
      throw pushFiles.refuse("missing", `no push ${pushId}`);
    case "missing":
      throw pushFiles.refuse(
        "missing",
        `a commit of push ${pushId} is not in the repository`,
      );
    case "no-base":
      throw pushFiles.refuse(
        "no-base",
        `${range.first} is a root commit: push ${pushId} has no base to diff from`,
      );
    case "ok":
      break;
  }
  const { baseSha, headSha } = range;
  const files = await getRangeFiles(root, baseSha, headSha);
  if (!files) throw new Error(`git diff ${baseSha} ${headSha} failed`);
  return { files, baseSha, headSha };
}

// External: the truth is a diff of two commits in git, which never moves once
// the range is known — the range itself is the push's ledger rows, declared as
// the value's reads, so a row of the push landing recomputes it.
export const pushFilesServed = serveValue(pushFiles, {
  source: "external",
  changes: "notified",
  reads: pushRangeReads,
  loader: ({ worktree, pushId }) => loadPushFiles(worktree, pushId),
});
