import { liveValue } from "@plugins/network/plugins/live/core";
import { resolvableSchema } from "@plugins/primitives/plugins/live-state/core";
import {
  EditedFileSchema,
  EditedFilesMetaSchema,
  EditedFilesQuerySchema,
} from "./protocol";

/** Files per page. */
const EDITED_FILES_PAGE = 500;

/**
 * The most files one read without a viewport holds — the review section, the
 * summary chip and the exit decision each read the set this way; past it they
 * say the list was cut (the meta's `count` is the whole set's).
 */
export const EDITED_FILES_MAX = 2000;

const NEEDS_MACHINE = { feature: "Listing the files an agent edited" } as const;

// The edited files of a conversation's worktree, relative to its merge base,
// paged by path: a reader holds a bounded window of the set, never the whole
// list. `editedFiles.meta` is the whole set's totals as a `Resolvable` — an
// unresolvable worktree is a settled `{ resolved: false, reason }` there (and
// its pages are empty), never a zero count: that would be an absorbable failure
// indistinguishable from a genuinely clean worktree. Not loaded yet is
// `pending` (a value has no placeholder).
//
// Pushed, as every paged value is (a page is a keyed window): the git reads
// (one status scan + one `git diff --raw --numstat` + untracked reads) run once
// per change through the watched memo, and every page and the meta slice its
// one answer.
//
// It is measured from git in the worktree on disk, so only the desktop app
// answers it (`needsMachine`): a reader under an in-browser server gets
// `unavailable`.
export const editedFiles = liveValue("edited-files", {
  query: EditedFilesQuerySchema,
  paged: {
    item: EditedFileSchema,
    id: "path",
    key: { of: (file) => [file.path], order: ["asc"] },
    limit: EDITED_FILES_PAGE,
    maxLimit: EDITED_FILES_MAX,
    meta: EditedFilesMetaSchema,
  },
  needsMachine: NEEDS_MACHINE,
});

// One edited file of a conversation's worktree, by path — the file-peek pane's
// status hint, whatever page of the set it falls on. `null`: the path is clean
// (not in the set); an unresolvable worktree is `{ resolved: false, reason }`.
export const editedFile = liveValue("edited-files.file", {
  schema: resolvableSchema(EditedFileSchema.nullable()),
  params: ["id", "path"],
  needsMachine: NEEDS_MACHINE,
});
