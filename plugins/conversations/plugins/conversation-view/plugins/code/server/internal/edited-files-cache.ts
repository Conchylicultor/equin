import type { EditedFile } from "../../core/protocol";
import { acquireCheckoutWatch } from "@plugins/infra/plugins/git/plugins/checkout-watch/server";
import { createWatchedMemo } from "@plugins/packages/plugins/watched-memo/core";
import { computeEditedFiles } from "./compute-edited-files";
import {
  type EditedFilesFacts,
  editedFilesSignatureOf,
  readEditedFilesFacts,
} from "./edited-files-signature";

// ONE module-level memo per process, keyed by worktree, shared by every reader
// of a worktree's edited files: the pages, the meta and one file
// (machine/internal/edited-files-resource.ts), and review/plugin-changes.
//
// While a worktree is watched (`watchEditedFiles`), its checkout watch is the
// freshness authority: each change runs ONE pass — one `git status` (the facts)
// and one `git diff --raw --numstat` over them — and a read is the held list,
// with no git spawn. Passes run one at a time, the changes landing mid-pass
// folded into one trailing pass, and every pass computes (no skip on an equal
// signature: an edit read mid-pass and undone puts the signature back while
// the list still shows the edit). The list is set before the watchers are told.
//
// The checkout watch hears the working tree AND the git dir — the list moves on
// a `git add` (untracked → added) and on a `main` advance or rebase (the
// merge-base) — but of the refs every worktree shares only its own branch and
// `refs/heads/main`: another worktree's commit costs nothing. It drops what git
// ignores (a build's `dist/`, the main checkout's `.claude/worktrees/`). A watch
// that lost events is a resync: one more pass.
//
// Unwatched (an HTTP read, plugin-changes with nothing open), or after a failed
// pass, a read takes the probe path: the facts, then the content signature
// (edited-files-signature.ts) — a hit, or one compute single-flighted per
// signature over the probe's own facts.
//
// The list is pushed, so nothing mints an ETag from a fresh probe beside it: a
// revalidate would have to return the held entry's own signature.
//
// See packages/watched-memo and
// research/2026-10-25-global-edited-files-paged-cost.md.
export const editedFilesMemo = createWatchedMemo<
  EditedFile[],
  EditedFilesFacts
>({
  name: "edited-files",
  passLabel: "watch-edited-files:pass",
  facts: readEditedFilesFacts,
  signatureOf: editedFilesSignatureOf,
  compute: computeEditedFiles,
  changes: (worktreePath, trigger) =>
    acquireCheckoutWatch(worktreePath, {
      refs: { also: ["refs/heads/main"] },
      onChange: () => trigger(),
      onResync: () => trigger(true),
    }),
});

/** Drop the unwatched path's cached list (a worktree found gone). */
export function evictEditedFiles(worktreePath: string): void {
  editedFilesMemo.evict(worktreePath);
}
