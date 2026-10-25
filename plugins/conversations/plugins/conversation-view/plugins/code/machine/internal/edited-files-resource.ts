import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import type { LiveQueryParams } from "@plugins/network/plugins/live/core";
import { createParkedWatches } from "@plugins/packages/plugins/parked-watch/core";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { sliceRange } from "@plugins/network/plugins/live/server";
import { WorktreeGoneError } from "@plugins/primitives/plugins/commit-list/server";
import {
  resolved,
  unresolved,
  type Resolvable,
} from "@plugins/primitives/plugins/live-state/core";
import { assertCapability } from "@plugins/conversations/plugins/workspace/core";
import { workspaceOfConversationLookup } from "@plugins/tasks/plugins/tasks-core/server";
import { editedFile, editedFiles } from "../../core";
import type { EditedFile, EditedFilesMeta } from "../../core/protocol";
import { evictEditedFiles } from "../../server/internal/edited-files-cache";
import { getEditedFiles } from "../../server/internal/get-edited-files";
import { watchEditedFiles } from "../../server/internal/watch-edited-files";

// The conversation's worktree, through tasks-core's compiled lookup — the
// one read every loader and the watch make (`PAGED_READS`, `FILE_READS`). A
// conversation with no git (a scratch workspace) is a caller bug — a surface
// that reads edited files is gated on the git capability — so it throws
// rather than reading as "no worktree" or "no changes".
async function resolveWorktree(conversationId: string): Promise<string | null> {
  const found = await workspaceOfConversationLookup.run(conversationId);
  if (!found.found) return null;
  assertCapability(found.row.spec.kind, "git", "edited-files");
  return found.row.path;
}

// The watches of a conversation subscribed before its row was written,
// parked until a load resolves its worktree (`watchConversation`). A parked
// watch that fails to open is reported and parked again: the next load that
// resolves the worktree retries it.
const parked = createParkedWatches<string>({
  onOpenError: (conversationId, err) =>
    reportServerError({
      message: `[edited-files] the worktree watch of conversation ${conversationId} failed to open — its edited files hear no change until a load retries it: ${err instanceof Error ? err.message : String(err)}`,
      stack: err instanceof Error ? (err.stack ?? null) : null,
      errorType: "EditedFilesWatchOpenError",
    }),
});

// The loaders' resolve: a worktree found opens the watches parked on the
// conversation, so the load its row's insert re-ran opens the watch too.
async function worktreeFor(conversationId: string): Promise<string | null> {
  const wt = await resolveWorktree(conversationId);
  if (wt !== null) parked.resolved(conversationId, wt);
  return wt;
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
    // Drops only the unwatched path's cached list: a watched worktree's held
    // value is its memo's own (a failed pass already demoted it).
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

// What every loader reads in Postgres: the conversation's worktree, through
// the compiled lookup alone (conversations ⋈ attempts by `conversations.id`).
// A write to a column it does not read (a turn's status) reaches no tuple; a
// conversation's insert or delete reaches only its own tuples; an attempt's
// insert or delete every tuple once, at launch rate.
const READ_REASON =
  "each tuple resolves its conversation's worktree (conversations → attempts) before reading git; only the lookup's columns can move which worktree it reads";

const PAGED_READS = {
  tables: [],
  lookups: [
    workspaceOfConversationLookup.read<LiveQueryParams>(
      (p) => editedFiles.query.decodeQuery(p.q).id,
    ),
  ],
  reason: READ_REASON,
};

const FILE_READS = {
  tables: [],
  lookups: [
    workspaceOfConversationLookup.read<{ id: string; path: string }>(
      (p) => p.id,
    ),
  ],
  reason: READ_REASON,
};

// Watch the worktree (and its git dir) while the conversation is on screen. The
// watch is the memo's, one per worktree (`watchEditedFiles`), so the pages, the
// meta and a peeked file share one watch and one pass per change. A
// conversation whose row is not written yet has no worktree to watch: the
// watch parks, and the load the row's insert re-runs (the lookup's route)
// opens it — then notifies, so the loaders read the watched list.
function watchConversation(
  id: string,
  notify: () => void,
): Promise<() => void> {
  return parked.watch(
    id,
    () => resolveWorktree(id),
    (wt) => watchEditedFiles(wt, notify),
    notify,
  );
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
// The pages, the meta and the one-file value all declare the worktree lookup
// (`PAGED_READS` / `FILE_READS`): only a write the lookup reads re-reads a
// tuple, and only the tuples asking about that conversation.
export const editedFilesServed = serveValue(editedFiles, {
  source: "external",
  changes: "notified",
  reads: PAGED_READS,
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
  reads: FILE_READS,
  loader: async ({ id, path }): Promise<Resolvable<EditedFile | null>> => {
    const files = await loadEditedFilesFor(id);
    if (!files.resolved) return files;
    return resolved(files.value.find((f) => f.path === path) ?? null);
  },
  whileSubscribed: ({ id }, notify) => watchConversation(id, notify),
});
