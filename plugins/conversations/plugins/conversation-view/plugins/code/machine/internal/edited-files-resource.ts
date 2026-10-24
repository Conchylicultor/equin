import { serveValue } from "@plugins/network/plugins/live/machine";
import { sliceRange } from "@plugins/network/plugins/live/server";
import { WorktreeGoneError } from "@plugins/primitives/plugins/commit-list/server";
import {
  resolved,
  unresolved,
  type Resolvable,
} from "@plugins/primitives/plugins/live-state/core";
import { assertCapability } from "@plugins/conversations/plugins/workspace/core";
import { findWorkspaceOfConversation } from "@plugins/conversations/plugins/workspace/server";
import {
  _attempts,
  _conversations,
} from "@plugins/tasks/plugins/tasks-core/server";
import { editedFile, editedFiles } from "../../core";
import type { EditedFile, EditedFilesMeta } from "../../core/protocol";
import { evictEditedFiles } from "../../server/internal/edited-files-cache";
import { getEditedFiles } from "../../server/internal/get-edited-files";
import { watchEditedFiles } from "../../server/internal/watch-edited-files";

// A conversation with no git (a scratch workspace) is a caller bug — a
// surface that reads edited files is gated on the git capability — so it
// throws rather than reading as "no worktree" or "no changes".
async function worktreeFor(conversationId: string): Promise<string | null> {
  const found = await findWorkspaceOfConversation(conversationId);
  if (!found.found) return null;
  assertCapability(found.workspace.spec.kind, "git", "edited-files");
  return found.workspace.path;
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
  conversationId: string,
  gone: T,
  compute: (worktreePath: string) => Promise<T>,
): Promise<T> {
  const wt = await worktreeFor(conversationId);
  if (!wt) return gone;
  try {
    return await compute(wt);
  } catch (err) {
    if (!(err instanceof WorktreeGoneError)) throw err;
    evictEditedFiles(wt);
    return gone;
  }
}

/** The `loader` half, resolved from a conversation id. */
export function loadEditedFilesFor(
  conversationId: string,
): Promise<Resolvable<EditedFile[]>> {
  return onWorktree(
    conversationId,
    unresolved("worktree unavailable"),
    async (wt) => resolved(await getEditedFiles(wt)),
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

const READS = {
  tables: [_conversations, _attempts],
  reason:
    "each tuple resolves its conversation's worktree (conversations → attempts) before reading git, and the same lookup runs in whileSubscribed; a write to any conversation or attempt row may move which worktree a tuple reads — whole-table until the path is a param or a db-served value",
};

// Watch the worktree (and its git dir) while the conversation is on screen. The
// watch is a refcounted room per worktree (`watchEditedFiles`), so the pages,
// the meta and a peeked file share one.
async function watchConversation(
  id: string,
  notify: () => void,
): Promise<() => void> {
  const wt = await worktreeFor(id);
  if (!wt) return () => {};
  return watchEditedFiles(wt, notify);
}

// Every page and the meta read ONE authority: `editedFilesMemo` is a
// `createSignedMemo` binding `editedFilesSignature` to `computeEditedFiles` (the
// loader's `getEditedFiles`) at its single declaration site, primed by the
// watcher before it notifies — so a recompute is a signature probe and a slice
// of the memoized list, never a second set of git reads per page.
//
// The signature is content-addressed and cheap: (headSha, mergeBase) + a per-dirty
// -file (porcelain code, lstat mtime+size). It moves on an uncommitted save with no
// SHA change. See edited-files-signature.ts for the faithfulness argument and
// research/2026-07-09-global-etag-value-coproduction.md.
//
// An unresolvable (or reaped) worktree is one determinate state from the SAME
// `onWorktree` branch: the meta says `unresolved(…)` and the pages are empty —
// never a zero count a reader could take for a clean worktree.
//
// The pages, the meta and the one-file value all declare the worktree lookup
// (`READS`): a write there re-reads every subscribed page whole.
export const editedFilesServed = serveValue(editedFiles, {
  source: "external",
  changes: "notified",
  reads: READS,
  loader: async ({ id }, range) => {
    const files = await loadEditedFilesFor(id);
    return files.resolved ? sliceRange(editedFiles, files.value, range) : [];
  },
  meta: async ({ id }) => editedFilesMetaOf(await loadEditedFilesFor(id)),
  whileSubscribed: ({ id }, notify) => watchConversation(id, notify),
});

// One file of the set, by path, from the same memoized list — the file-peek
// pane's status hint, wherever in the set's pages the file falls.
export const editedFileServed = serveValue(editedFile, {
  source: "external",
  changes: "notified",
  reads: READS,
  loader: async ({ id, path }): Promise<Resolvable<EditedFile | null>> => {
    const files = await loadEditedFilesFor(id);
    if (!files.resolved) return files;
    return resolved(files.value.find((f) => f.path === path) ?? null);
  },
  whileSubscribed: ({ id }, notify) => watchConversation(id, notify),
});
