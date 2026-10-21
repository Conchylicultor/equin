import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { EditedFileSchema } from "@plugins/conversations/plugins/conversation-view/plugins/code/core";
import { CommitRowSchema } from "@plugins/primitives/plugins/commit-list/core";

/**
 * Why a commit read can be refused, both values alike:
 *
 * - `missing` — the sha names no commit in that repository's object store (never
 *   one, garbage-collected since, or not a sha at all). A determinate answer
 *   about the repository, not a failed read: the reader shows "no such commit",
 *   while a transport or git failure stays an error.
 * - `no-checkout` — an absolute-path `worktree` that is not a checkout's
 *   toplevel, so there is no object store to ask.
 */
const COMMIT_REFUSALS = ["missing", "no-checkout"] as const;

/**
 * One commit's metadata (subject, author, dates), by `(worktree, sha)`.
 *
 * `worktree` names the REPOSITORY whose object store holds the sha: `main`,
 * `self` or an attempt id all name this repository — every `git worktree add`
 * checkout shares one object database, so the sha resolves the same from any of
 * them, including an attempt whose worktree has since been reaped — and an
 * absolute path names the checkout at that toplevel. Served external,
 * `immutable`: a commit's content is addressed by its sha. Two answers do not
 * heal while a tuple is subscribed (a remount re-asks): a refusal (`no-checkout`
 * for a path that later becomes a checkout, `missing` for a sha that arrives
 * later), and an abbreviated `sha`, whose resolution depends on the object
 * store's contents. `commitFiles` answers with the full sha it resolved.
 */
export const commitInfo = liveValue("code.commit-info", {
  schema: CommitRowSchema,
  params: ["worktree", "sha"],
  refusals: COMMIT_REFUSALS,
});

export const CommitFilesSchema = z.object({
  /** The files the commit touched against its first parent, sorted by path. */
  files: z.array(EditedFileSchema),
  /** The first parent; the commit itself for a root commit (then `files` is empty). */
  baseSha: z.string(),
  headSha: z.string(),
});
export type CommitFiles = z.infer<typeof CommitFilesSchema>;

/**
 * The files one commit changed (against its first parent), by
 * `(worktree, sha)` — the same addressing and freshness as {@link commitInfo}.
 */
export const commitFiles = liveValue("code.commit-files", {
  schema: CommitFilesSchema,
  params: ["worktree", "sha"],
  refusals: COMMIT_REFUSALS,
});

/**
 * The files a push changed, by `(worktree, pushId)`: the push's range — its
 * `pushes` rows ordered by git ancestry, the tip the one commit no other of
 * them has as a parent, the base the first parent of the earliest commit on
 * the tip's first-parent chain — diffed as `baseSha..headSha`. `worktree`
 * names the object store, as for {@link commitInfo}; the rows are the serving
 * database's. Pushed, and recomputed when a row of the push lands (its
 * `pushes` rows are the value's declared reads); the diff of a known range
 * never moves.
 *
 * Refused: `missing` (no push `pushId`, or one of its commits is not in the
 * store), `no-checkout` (an absolute-path `worktree` that is not a checkout's
 * toplevel), `no-base` (the push's earliest commit is a root commit: there is
 * no parent to diff from).
 */
export const pushFiles = liveValue("code.push-files", {
  schema: CommitFilesSchema,
  params: ["worktree", "pushId"],
  refusals: [...COMMIT_REFUSALS, "no-base"],
});
