import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { FILE_PEEK_MAX_NAMES } from "@plugins/infra/plugins/paths/plugins/file-systems/core";
import {
  cappedList,
  cappedRecord,
} from "@plugins/packages/plugins/list-bound/core";

/**
 * How a path stands against one base — the closed set `git status` / `git diff
 * --name-status` report, `clean` being the absence of an entry.
 */
export const GitChangeSchema = z.enum([
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "untracked",
]);
export type GitChange = z.infer<typeof GitChangeSchema>;

/** A changed path's status against HEAD and against the `main` merge-base. */
export const GitEntrySchema = z.object({
  vsHead: GitChangeSchema.nullable(),
  vsMain: GitChangeSchema.nullable(),
});
export type GitEntry = z.infer<typeof GitEntrySchema>;

/**
 * The most paths each of a status's lists holds (its changed entries, and the
 * collapsed untracked folders). A checkout past it — a mass rename, an
 * un-ignored build tree — is served its first this many, `truncated`.
 */
export const GIT_STATUS_MAX_PATHS = 5000;

const pathList = () => cappedList(z.string(), { max: GIT_STATUS_MAX_PATHS });

/**
 * One checkout's git status, every path relative to its root. Bounded by what
 * changed, never by tree size: an untracked directory comes back
 * collapsed (`dir`, no trailing slash) and the client resolves what lies below
 * it by prefix. Each list is capped at {@link GIT_STATUS_MAX_PATHS};
 * `truncated` says one was cut, so the paths left out read unknown, never
 * clean.
 */
export const GitStatusSchema = z.object({
  /** The checked-out commit; `null` on an unborn branch. */
  head: z.string().nullable(),
  /** `merge-base main HEAD`; `null` when there is no `main` or no common ancestor. */
  mergeBase: z.string().nullable(),
  entries: cappedRecord(GitEntrySchema, { max: GIT_STATUS_MAX_PATHS }),
  untrackedDirs: pathList(),
  /** Some list held more than {@link GIT_STATUS_MAX_PATHS} paths and was cut. */
  truncated: z.boolean(),
});
export type GitStatus = z.infer<typeof GitStatusSchema>;

/**
 * Which checkout a folder is in. `root` is git's own spelling of the toplevel
 * (symlinks resolved) — the code-api checkout id and the status param.
 * `rootAsGiven` is the same folder spelled the way the asked path spells it, so
 * the browser's paths can be made relative to it.
 */
export const GitCheckoutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("checkout"),
    root: z.string(),
    rootAsGiven: z.string(),
  }),
]);
export type GitCheckout = z.infer<typeof GitCheckoutSchema>;

/**
 * The git checkout holding the absolute folder `path`, if any — a SNAPSHOT:
 * a folder's checkout changes only when a repository is created or removed
 * around it, which nothing signals, so it is asked again on every mount (a
 * `git init` shows up on the next visit) and on `refresh()`. Refused:
 * `invalid-path` (not absolute).
 */
export const fileExplorerGitCheckoutValue = liveValue(
  "file-explorer.git-checkout",
  {
    schema: GitCheckoutSchema,
    params: ["path"],
    load: "snapshot",
    refusals: ["invalid-path"],
    needsMachine: { feature: "Git status" },
  },
);

/**
 * The live git status of the checkout at `root` (a toplevel
 * `file-explorer.git-checkout` answered). Pushed while subscribed, from a watcher on the checkout
 * and its git dir.
 */
export const fileExplorerGitStatus = liveValue("file-explorer.git-status", {
  schema: GitStatusSchema,
  params: ["root"],
  needsMachine: { feature: "Git status" },
});

/**
 * The most entries one folder's answer judges per folder read: as many as the
 * browser lists of a folder (`FILE_PEEK_MAX_NAMES`, the first in name order),
 * so every entry it shows is covered.
 */
export const GIT_IGNORED_MAX_NAMES = FILE_PEEK_MAX_NAMES;

/**
 * The most ignored paths one answer carries. The folder's own entries come
 * first (at most {@link GIT_IGNORED_MAX_NAMES}, so always whole); past the cap
 * the subfolders' entries are cut and `truncated` says so — a collapsed
 * folder's item count may then include ignored items.
 */
export const GIT_IGNORED_MAX_PATHS = 50_000;

/**
 * What git ignores among one folder's entries and its subfolders' entries —
 * paths relative to the folder (`node_modules`, `src/app.log`). What lies
 * below an ignored folder is not listed: a folder git ignores holds only
 * ignored paths. An ignored folder holding a tracked file is not listed (git
 * shows what it tracks), as `git status --ignored` would list its ignored
 * files rather than the folder.
 */
export const GitIgnoredSchema = z.object({
  paths: cappedList(z.string(), { max: GIT_IGNORED_MAX_PATHS }),
  truncated: z.boolean(),
});
export type GitIgnored = z.infer<typeof GitIgnoredSchema>;

/**
 * What git ignores in the folder `dir` of the checkout at `root` (`dir`
 * relative to it, `""` the root itself): among its entries and its
 * subfolders' entries — its rows and each collapsed folder's item count.
 * Asked per folder the browser lists, so its cost follows what is shown: a
 * listing of the folder and of its subfolders, and two `git check-ignore`
 * rounds over those entries — never a walk of the tree. Pushed while
 * subscribed, from a watch of those two levels and of the checkout's ignore
 * rules (`.gitignore` files, the git dir). Nothing is ignored beyond a
 * symbolic link (git never descends one). Refused: `invalid-path` (`dir`
 * absolute or climbing out), `missing` (no such folder).
 */
export const fileExplorerGitIgnored = liveValue("file-explorer.git-ignored", {
  schema: GitIgnoredSchema,
  params: ["root", "dir"],
  refusals: ["invalid-path", "missing"],
  needsMachine: { feature: "Git status" },
});
