import { liveValue } from "@plugins/network/plugins/live/core";
import { EditedFilesPayloadSchema } from "./protocol";

// The edited files of a conversation's worktree, relative to its merge base.
// The payload is a `Resolvable<EditedFile[]>`: an unresolvable worktree is a
// settled `{ resolved: false, reason }`, never `[]` — an empty list would be an
// absorbable failure indistinguishable from a genuinely clean worktree. Not
// loaded yet is `pending` (a value has no placeholder).
//
// `load: "on-demand"`: the loader (merge-base + two `git diff` passes + untracked
// reads) is too slow for the shared flush, so a change sends an `invalidate` and
// each tab refetches over HTTP.
//
// It is measured from git in the worktree on disk, so only the desktop app
// answers it (`needsMachine`): a reader under an in-browser server gets
// `unavailable`.
export const editedFiles = liveValue("edited-files", {
  schema: EditedFilesPayloadSchema,
  params: ["id"],
  load: "on-demand",
  needsMachine: { feature: "Listing the files an agent edited" },
});
