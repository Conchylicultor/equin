import { serveValue } from "@plugins/network/plugins/live/server";
import { WorktreeGoneError } from "@plugins/primitives/plugins/commit-list/server";
import {
  resolved,
  unresolved,
  type Resolvable,
} from "@plugins/primitives/plugins/live-state/core";
import { assertCapability } from "@plugins/conversations/plugins/workspace/core";
import { findWorkspaceOfConversation } from "@plugins/conversations/plugins/workspace/server";
import { editedFiles } from "../../core";
import type { EditedFile } from "../../core/protocol";
import { editedFilesMemo, evictEditedFiles } from "./edited-files-cache";
import { getEditedFiles } from "./get-edited-files";
import { watchEditedFiles } from "./watch-edited-files";

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

/** The `revalidate` half — the same memo, hence the same authority. */
export function editedFilesSignatureFor(
  conversationId: string,
): Promise<string> {
  return onWorktree(conversationId, "no-worktree", (wt) =>
    editedFilesMemo.signature(wt),
  );
}

export const editedFilesServed = serveValue(editedFiles, {
  source: "external",
  changes: "notified",
  loader: ({ id }) => loadEditedFilesFor(id),
  // The ETag and the value are produced by ONE authority: `editedFilesMemo` is a
  // `createSignedMemo` binding `editedFilesSignature` (here) to `computeEditedFiles`
  // (the loader's `getEditedFiles`) at its single declaration site. `revalidate` and
  // `loader` are therefore provably the same function of the same inputs — they are
  // not two probes agreeing by convention, which is precisely how this resource
  // drifted into serving a stale value under a fresh ETag (permanent, because an
  // `invalidate`-mode push carries no value that could heal it).
  //
  // The signature is content-addressed and cheap: (headSha, mergeBase) + a per-dirty
  // -file (porcelain code, lstat mtime+size). It moves on an uncommitted save with no
  // SHA change, and it survives a server restart — preserving the 304 herd-collapse
  // this ETag exists for. Cost: 1 `rev-parse` + 1 `merge-base` + 1 `git status` + an
  // `lstat` per dirty file, vs. the loader's `merge-base` + two `git diff` passes +
  // full content reads of untracked files. See edited-files-signature.ts for the
  // faithfulness argument and research/2026-07-09-global-etag-value-coproduction.md.
  //
  // The no-worktree/reaped collapse preserves that same co-production invariant:
  // the `revalidate`'s `"no-worktree"` ETag and the loader's `unresolved(…)` value
  // are produced from the SAME `onWorktree` branch, so they are one consistent
  // signature/value pair for a real determinate state — never a fresh ETag over a
  // stale value.
  revalidate: ({ id }) => editedFilesSignatureFor(id),
  // Watch the worktree (and its git dir) while the conversation is on screen.
  whileSubscribed: async ({ id }, notify) => {
    const wt = await worktreeFor(id);
    if (!wt) return () => {};
    return watchEditedFiles(wt, notify);
  },
});
