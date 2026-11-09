import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The attachment bytes themselves: one UUID-named file per row of
 * `attachments`, extension taken from the original filename.
 *
 * `state` rather than `apps`: attachments are platform content, not one app's.
 * Tasks, agent conversations, pages, mail and Sonata's library all link into
 * the same pool through `Attachments.defineLink`, and an `apps/<app>` dir is
 * reserved for the one app that owns it. What this dir shares with an app dir is the reclaim class — it
 * is the only copy — and that is exactly what `state/` means.
 *
 * Host-global rather than per-worktree because an attachment outlives the
 * worktree that uploaded it — a screenshot filed against a task is read from
 * main long after the agent's checkout is gone.
 *
 * `movedFrom`: this dir was `apps/attachments` until the one-dir-per-app rule
 * made `apps/` app-only. The declaration records the old name so the paths
 * primitive performs the move itself, and only in the host's singleton process
 * (main): it renames the tree into `state/attachments` and leaves a symlink at
 * the old name, so an older checkout still reads and writes the same bytes.
 * Every other process — a worktree backend, an exec child — resolves to the
 * old location until that has happened, so no reader ever looks at the new
 * spot before the bytes are there.
 */
export const attachmentsDir = defineDataDir({
  kind: "state",
  name: "attachments",
  owner: "infra/attachments",
  description:
    "Uploaded attachment bytes, one UUID-named file per attachments row (screenshots, pasted images, uploaded files)",
  // The DB row holds only metadata — filename, mime, size, owner link. The
  // bytes exist nowhere else, so deleting this tree turns every attachment in
  // the app into a broken link with no way back.
  reclaim: {
    kind: "never",
    reason:
      "the DB holds only each attachment's metadata; these files are the only copy of the bytes",
  },
  movedFrom: [{ from: "apps/attachments" }],
});

export default [attachmentsDir];
