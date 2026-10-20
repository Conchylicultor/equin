import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

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
 * One checkout's git status, every path relative to its root. Bounded by what
 * changed, never by tree size: an untracked or ignored directory comes back
 * collapsed (`dir`, no trailing slash) and the client resolves what lies below
 * it by prefix.
 */
export const GitStatusSchema = z.object({
  /** The checked-out commit; `null` on an unborn branch. */
  head: z.string().nullable(),
  /** `merge-base main HEAD`; `null` when there is no `main` or no common ancestor. */
  mergeBase: z.string().nullable(),
  entries: z.record(z.string(), GitEntrySchema),
  untrackedDirs: z.array(z.string()),
  ignoredDirs: z.array(z.string()),
  ignoredFiles: z.array(z.string()),
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
});
