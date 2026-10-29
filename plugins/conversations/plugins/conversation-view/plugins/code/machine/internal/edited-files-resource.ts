import { serveValue } from "@plugins/network/plugins/live/machine";
import { sliceRange } from "@plugins/network/plugins/live/server";
import { WorktreeGoneError } from "@plugins/primitives/plugins/commit-list/server";
import {
  resolved,
  unresolved,
  type Resolvable,
} from "@plugins/primitives/plugins/live-state/core";
import {
  assertCapability,
  type WorkspaceSpec,
} from "@plugins/conversations/plugins/workspace/core";
import { conversationWorkspacesServed } from "@plugins/tasks/plugins/tasks-core/server";
import { conversationWorkspaceOf } from "@plugins/tasks/plugins/tasks-core/core";
import { editedFile, editedFiles } from "../../core";
import type { EditedFile, EditedFilesMeta } from "../../core/protocol";
import { evictEditedFiles } from "../../server/internal/edited-files-cache";
import { getEditedFiles } from "../../server/internal/get-edited-files";
import { watchEditedFiles } from "../../server/internal/watch-edited-files";

/** What the loaders and the watch read of the followed `conversationWorkspaces` row. */
interface ConversationWorkspace {
  readonly worktreePath: string;
  readonly workspace: WorkspaceSpec;
}

// The conversation's worktree, from its followed workspace row (`followed.ws`,
// below). No row (a conversation subscribed before it is written), or no
// path yet, is no worktree. A conversation with no git (a scratch workspace)
// is a caller bug — a surface that reads edited files is gated on the git
// capability — so it throws rather than reading as "no worktree" or "no
// changes".
function worktreeOf(ws: readonly ConversationWorkspace[]): string | null {
  const row = conversationWorkspaceOf(ws);
  if (row === null) return null;
  assertCapability(row.workspace.kind, "git", "edited-files");
  return row.worktreePath;
}

// A conversation whose worktree we cannot resolve — or whose worktree is reaped
// mid-compute — has an UNKNOWN file set, not an empty one. Both are the SAME
// determinate state (no trustworthy worktree to read), so both collapse onto the
// caller's `gone` value: a first-class settled non-value, NOT `[]`/`"none"`.
// Returning the empty value would be an absorbed failure — the client renders a
// legitimate "no changes", which arms the destructive "Drop & Close". Every OTHER
// git failure propagates: that is a TRANSIENT failure, and the readiness gate now
// makes it un-absorbable.
//
// Modelled byte-for-byte on commits-graph's `onWorktree`
// (commits-graph/server/internal/resources.ts): the reaped case is CAUGHT, not
// stat-pre-checked, because a reap racing the compute would slip past any
// pre-check. One `gone` value per call, so a reaped worktree reports the same
// reason as an absent one — giving the reaped case its own reason would mean
// diverging from that shared shape for a distinction the consumer does not act on
// (both are "no trustworthy value").
async function onWorktree<T>(
  ws: readonly ConversationWorkspace[],
  gone: T,
  compute: (worktreePath: string) => Promise<T>,
): Promise<T> {
  const wt = worktreeOf(ws);
  if (!wt) return gone;
  try {
    return await compute(wt);
  } catch (err) {
    if (!(err instanceof WorktreeGoneError)) throw err;
    // Drops only the unwatched path's cached list: a watched worktree's held
    // value is its memo's own (a failed pass already demoted it).
    evictEditedFiles(wt);
    return gone;
  }
}

/** The `loader` half, over the conversation's followed workspace row. */
export function loadEditedFilesFor(
  ws: readonly ConversationWorkspace[],
): Promise<Resolvable<EditedFile[]>> {
  return onWorktree(ws, unresolved("worktree unavailable"), async (wt) =>
    resolved(await getEditedFiles(wt)),
  );
}

/** The whole set's totals — `editedFiles.meta` — from the same memoized list. */
export function editedFilesMetaOf(
  files: Resolvable<EditedFile[]>,
): EditedFilesMeta {
  if (!files.resolved) return files;
  let additions = 0;
  let deletions = 0;
  for (const f of files.value) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return resolved({ count: files.value.length, additions, deletions });
}

// Watch the worktree (and its git dir) while the conversation is on screen. The
// watch is the memo's, one per worktree (`watchEditedFiles`), so the pages, the
// meta and a peeked file share one watch and one pass per change. A
// conversation with no worktree yet (its row not written) watches nothing: the
// framework re-starts the watch over the new row when a write moves it (its
// follow re-point), and so when the worktree changes too. Once open, it
// notifies — a change between the load and the watch going live (a re-point
// races the load the same write re-ran) is not lost.
function watchConversation(
  wt: string | null,
  notify: () => void,
): (() => void) | Promise<() => void> {
  if (wt === null) return () => {};
  return watchEditedFiles(wt, notify).then((stop) => {
    notify();
    return stop;
  });
}

// Every page and the meta read ONE authority: `editedFilesMemo`, a watched memo
// (server/internal/edited-files-cache.ts). While the worktree is watched, its
// list is set by the pass a change ran before anyone is notified, so a loader
// run is a slice of the held list — no git spawn. Unwatched, a read probes the
// content signature (edited-files-signature.ts) and computes on a miss, once
// per signature. See research/2026-10-25-global-edited-files-paged-cost.md.
//
// An unresolvable (or reaped) worktree is one determinate state from the SAME
// `onWorktree` branch: the meta says `unresolved(…)` and the pages are empty —
// never a zero count a reader could take for a clean worktree.
//
// The pages, the meta and the one-file value each follow the conversation's
// workspace row — tasks-core's `conversationWorkspaces`, `{ ids: [id] }` — the
// one Postgres read every hook makes, handed in fresh as `followed.ws`: only a
// write that moves the row (the conversation's `attempt_id`, its attempt's
// `worktree_path` / `workspace`) re-reads a tuple, and only the tuples asking
// about that conversation (an attempt's write: the conversations of that
// attempt). A conversation's turn (its status) reaches none.
export const editedFilesServed = serveValue(editedFiles, {
  source: "external",
  changes: "notified",
  follows: (follow) => ({
    ws: follow(conversationWorkspacesServed, ({ id }) => ({ ids: [id] })),
  }),
  loader: async (_q, range, { followed }) => {
    const files = await loadEditedFilesFor(followed.ws);
    return files.resolved ? sliceRange(editedFiles, files.value, range) : [];
  },
  meta: async (_q, { followed }) =>
    editedFilesMetaOf(await loadEditedFilesFor(followed.ws)),
  whileFollowing: {
    over: (followed) => worktreeOf(followed.ws),
    start: (_q, { over: wt, notify }) => watchConversation(wt, notify),
  },
});

// One file of the set, by path, from the same memoized list — the file-peek
// pane's status hint, wherever in the set's pages the file falls.
export const editedFileServed = serveValue(editedFile, {
  source: "external",
  changes: "notified",
  follows: (follow) => ({
    ws: follow(conversationWorkspacesServed, ({ id }) => ({ ids: [id] })),
  }),
  loader: async (
    { path },
    { followed },
  ): Promise<Resolvable<EditedFile | null>> => {
    const files = await loadEditedFilesFor(followed.ws);
    if (!files.resolved) return files;
    return resolved(files.value.find((f) => f.path === path) ?? null);
  },
  whileFollowing: {
    over: (followed) => worktreeOf(followed.ws),
    start: (_p, { over: wt, notify }) => watchConversation(wt, notify),
  },
});
