import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { enumTextField } from "@plugins/fields/plugins/text/plugins/config/core";
import { clientFields } from "@plugins/network/plugins/live/core";
import { fileEntry } from "@plugins/apps/plugins/file-explorer/plugins/browser/core";

/**
 * What a path's git badge says: how it stands against HEAD (else against
 * main) — the closed set `git status` / `git diff --name-status` report — or,
 * for a folder, that it holds changes below it (its own value, so it filters
 * and groups like the others).
 */
export const GIT_BADGES = [
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "contains-changes",
] as const;
export type GitBadge = (typeof GIT_BADGES)[number];

export const GIT_BADGE_OPTIONS = {
  modified: { label: "Modified", variant: "warning" },
  added: { label: "Added", variant: "success" },
  deleted: { label: "Deleted", variant: "destructive" },
  renamed: { label: "Renamed", variant: "info" },
  copied: { label: "Copied", variant: "info" },
  untracked: { label: "Untracked", variant: "success" },
  "contains-changes": { label: "Contains changes", variant: "muted" },
} as const;

/**
 * The file tree's git fields, whose values only the browser knows (the
 * checkout status of the folder it shows — `ClientFields.Resolve` in this
 * plugin's web half): `git` (the status badge) and `changed` ("Changed vs
 * main", the Filter pill that narrows the tree to a branch's work).
 */
export const gitFields = clientFields(fileEntry, "git", {
  section: "Git",
  fields: {
    git: enumTextField(GIT_BADGES, {
      label: "Git",
      options: GIT_BADGE_OPTIONS,
    }),
    changed: boolField({ label: "Changed vs main" }),
  },
});
